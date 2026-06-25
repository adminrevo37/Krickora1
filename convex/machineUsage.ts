// SPEC_MACHINE_USAGE_AUDIT_KRICKORA_2026-06 (Phase 2) — receive each booking's
// ACTUAL bowling-machine-use minutes from Home Assistant (computed HA-side from the
// lane plug power; "in use" = any non-zero draw), store it against the booking /
// customer, and surface "actual vs booked utilisation" in the admin analytics
// dashboard.
//
// Ingest:  convex/http.ts  POST /ha/usage  (HMAC-signed, USAGE_SIGN_KEY)
//            -> logMachineUsageInternal  (insert + match to a bookings row)
// Admin view: getMachineUtilisation (range + lane filter)
//            -> src/components/analytics/MachineUsageTab.tsx
//
// Pairs with the HA Phase-1 build (live 2026-06-24):
//   cricket/home-assistant/SPEC_MACHINE_USAGE_AUDIT_2026-06.md

import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";
import { defaultLaneName } from "./lib/lanes";

// HA sends a physical BM lane number (1..3). Run-up lanes (4/5) have no machine, so
// usage only ever arrives for 1..3 — map straight to the stable bowling-machine id.
function laneIdForMachineLane(lane: number): string {
  return lane >= 1 && lane <= 3 ? `bm${lane}` : "";
}

// Resolve a GCal-event ISO start to its AWST (UTC+8, no DST) calendar day + decimal
// hour — the same +8h offset every other date helper in this codebase uses. The
// event datetime carries the calendar's +08:00 offset (or is AWST-naive); either
// way the +8h shift on the parsed UTC ms yields the AWST wall-clock a booking is
// keyed by (date + startHour).
function awstDateHour(iso: string): { date: string; hour: number } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 8 * 3600000);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  return { date, hour };
}

// ── Ingest + match — called by the /ha/usage webhook in http.ts ────────────────
export const logMachineUsageInternal = internalMutation({
  args: {
    at: v.number(),
    ts: v.number(),
    lane: v.number(),
    customer: v.string(),
    email: v.optional(v.string()),
    bookedMinutes: v.number(),
    usedMinutes: v.number(),
    utilPct: v.number(),
    startISO: v.string(),
  },
  handler: async (ctx, args) => {
    const laneId = laneIdForMachineLane(args.lane);
    const parsed = awstDateHour(args.startISO);
    const date = parsed?.date ?? "";
    const hour = parsed ? parsed.hour : null;
    const email = args.email ? args.email.toLowerCase().trim().slice(0, 256) : undefined;

    // ── Match to a bookings row (the GCal event carries no booking id) ──────────
    // Narrow by lane + date, then prefer an exact email match, then the closest
    // start hour, then an exact name match. Exactly one survivor = confident match;
    // >1 = ambiguous (left UNattributed for admin review); 0 = unmatched.
    let bookingId: any = undefined;
    let matchStatus = "unmatched";
    if (laneId && date) {
      const sameLaneDay = (
        await ctx.db
          .query("bookings")
          .withIndex("by_laneId_date", (q: any) => q.eq("laneId", laneId).eq("date", date))
          .collect()
      ).filter((b: any) => b.status !== "cancelled");

      let pool = sameLaneDay;
      if (email) {
        const byEmail = pool.filter((b: any) => (b.customerEmail ?? "").toLowerCase().trim() === email);
        if (byEmail.length) pool = byEmail;
      }
      if (pool.length > 1 && hour !== null) {
        const within = pool.filter((b: any) => Math.abs((b.startHour ?? 0) - hour) <= 0.5);
        if (within.length) pool = within;
      }
      if (pool.length > 1 && !email && args.customer) {
        const nameLc = args.customer.toLowerCase().trim();
        const byName = pool.filter((b: any) => (b.customerName ?? "").toLowerCase().trim() === nameLc);
        if (byName.length) pool = byName;
      }
      if (pool.length === 1) {
        bookingId = pool[0]._id;
        matchStatus = "matched";
      } else if (pool.length > 1) {
        matchStatus = "ambiguous";
      }
    }

    const bookedMinutes = Math.max(0, Math.round(args.bookedMinutes));
    const usedMinutes = Math.max(0, Math.round(args.usedMinutes * 10) / 10);
    const utilPct = Number.isFinite(args.utilPct)
      ? Math.round(args.utilPct)
      : bookedMinutes > 0
        ? Math.round((usedMinutes / bookedMinutes) * 100)
        : 0;

    await ctx.db.insert("machineUsage", {
      at: args.at,
      ts: args.ts,
      lane: args.lane,
      laneId,
      date,
      startHour: hour ?? undefined,
      customer: args.customer.slice(0, 128),
      email,
      bookedMinutes,
      usedMinutes,
      utilPct,
      startISO: args.startISO.slice(0, 64),
      bookingId,
      matchStatus,
    });
    return true;
  },
});

// ── Admin "Machine Utilisation" view ───────────────────────────────────────────
// Range-driven (by booking date). Returns the raw records joined to a display lane
// name, plus summary KPIs and a per-customer aggregate. Admin only (null otherwise),
// matching the other analytics queries.
export const getMachineUtilisation = query({
  args: {
    from: v.optional(v.string()), // YYYY-MM-DD
    to: v.optional(v.string()),
    lane: v.optional(v.number()), // 1..3, or absent = all
  },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return null;

    const from = args.from || "0000-00-00";
    const to = args.to || "9999-99-99";
    let records = await ctx.db
      .query("machineUsage")
      .withIndex("by_date", (q: any) => q.gte("date", from).lte("date", to))
      .collect();
    records = records.filter((r: any) => args.lane == null || r.lane === args.lane);
    records.sort((a: any, b: any) => b.at - a.at);

    const rows = records.map((r: any) => ({
      id: String(r._id),
      at: r.at as number,
      date: r.date as string,
      startHour: (r.startHour ?? null) as number | null,
      lane: r.lane as number,
      laneId: r.laneId as string,
      laneName: r.laneId ? defaultLaneName(r.laneId) : `Lane ${r.lane}`,
      customer: r.customer as string,
      email: (r.email ?? null) as string | null,
      bookedMinutes: r.bookedMinutes as number,
      usedMinutes: r.usedMinutes as number,
      utilPct: r.utilPct as number,
      matchStatus: r.matchStatus as string,
      bookingId: r.bookingId ? String(r.bookingId) : null,
    }));

    // Summary KPIs.
    const sessions = rows.length;
    const totalBooked = rows.reduce((s, r) => s + r.bookedMinutes, 0);
    const totalUsed = rows.reduce((s, r) => s + r.usedMinutes, 0);
    const avgUtilPct = sessions ? Math.round(rows.reduce((s, r) => s + r.utilPct, 0) / sessions) : 0;
    const lowUtilCount = rows.filter((r) => r.bookedMinutes > 0 && r.utilPct < 40).length;
    const overUseCount = rows.filter((r) => r.utilPct > 100).length;
    const unmatchedCount = rows.filter((r) => r.matchStatus !== "matched").length;

    // Per-customer aggregate (keyed by email when present, else name).
    const byKey = new Map<
      string,
      { customer: string; email: string | null; sessions: number; totalBooked: number; totalUsed: number; utilSum: number }
    >();
    for (const r of rows) {
      const key = (r.email || r.customer || "Unknown").toLowerCase();
      let agg = byKey.get(key);
      if (!agg) {
        agg = { customer: r.customer || r.email || "Unknown", email: r.email, sessions: 0, totalBooked: 0, totalUsed: 0, utilSum: 0 };
        byKey.set(key, agg);
      }
      agg.sessions += 1;
      agg.totalBooked += r.bookedMinutes;
      agg.totalUsed += r.usedMinutes;
      agg.utilSum += r.utilPct;
    }
    const byCustomer = [...byKey.values()]
      .map((a) => ({
        customer: a.customer,
        email: a.email,
        sessions: a.sessions,
        totalBooked: a.totalBooked,
        totalUsed: a.totalUsed,
        avgUtilPct: a.sessions ? Math.round(a.utilSum / a.sessions) : 0,
      }))
      .sort((x, y) => y.totalUsed - x.totalUsed);

    return {
      rows,
      summary: { sessions, totalBooked, totalUsed, avgUtilPct, lowUtilCount, overUseCount, unmatchedCount },
      byCustomer,
    };
  },
});
