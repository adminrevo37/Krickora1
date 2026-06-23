// SPEC_ANALYTICS_BUILD_2026-06 C2.2 — persisted end-of-day revenue/usage snapshot.
// The `daily-revenue-snapshot` cron (crons.ts) runs just after midnight AWST and
// writes one immutable row for the day that just ended, so trend history is cheap,
// stable, and survives later edits to historical bookings. `backfillRevenueSnapshots`
// rebuilds history on demand (admin-only). Upsert is keyed by date (idempotent).

import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";
import { awstDateKey, DAY_MS, AWST_OFFSET_MS } from "./lib/analyticsHelpers";

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function openHoursForDate(settings: any, dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
  let open = settings?.openingHour ?? 9;
  let close = settings?.closingHour ?? 21;
  const dh = (settings?.dailyHours ?? []).find((x: any) => x.day === DAY_NAMES[dow]);
  if (dh) {
    if (dh.closed) return 0;
    open = dh.open;
    close = dh.close;
  }
  return Math.max(0, close - open);
}

// Compute + upsert the snapshot row for one AWST date.
// COST-10 (audit 2026-06): the backfill loop passes settings + laneCount in so they
// aren't re-read once per day (~1200×). The cron caller omits them → read once here.
async function snapshotDate(
  ctx: any,
  date: string,
  settingsIn?: any,
  laneCountIn?: number
): Promise<void> {
  const settings =
    settingsIn !== undefined
      ? settingsIn
      : await ctx.db.query("siteSettings").withIndex("by_key", (q: any) => q.eq("key", "global")).first();
  let laneCount: number;
  if (laneCountIn !== undefined) {
    laneCount = laneCountIn;
  } else {
    const lanesRows = await ctx.db.query("lanes").collect();
    laneCount = lanesRows.length > 0 ? lanesRows.length : 5;
  }

  const dayBookings = (
    await ctx.db.query("bookings").withIndex("by_date", (q: any) => q.eq("date", date)).collect()
  ).filter((b: any) => b.status === "confirmed");

  let custRevenue = 0;
  let coachCharges = 0;
  let customerBookings = 0;
  let coachBookings = 0;
  let hours = 0;
  let bookedLaneHours = 0;
  for (const b of dayBookings as any[]) {
    const h = (b.duration ?? 0) / 60;
    const laneN = 1 + (b.additionalLaneIds?.length ?? 0);
    hours += h;
    bookedLaneHours += h * laneN;
    if (b.isCoachBooking) {
      coachBookings++;
      coachCharges += b.coachPrice ?? 0;
    } else {
      customerBookings++;
      custRevenue += b.priceInCents != null ? b.priceInCents / 100 : 0;
    }
  }
  const capacity = openHoursForDate(settings, date) * laneCount;
  const occupancyPct = capacity > 0 ? Math.round((bookedLaneHours / capacity) * 100) : 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const row = {
    date,
    custRevenue: r2(custRevenue),
    coachCharges: r2(coachCharges),
    bookings: customerBookings + coachBookings,
    customerBookings,
    coachBookings,
    hours: r2(hours),
    occupancyPct,
    createdAt: Date.now(),
  };

  const existing = await ctx.db
    .query("revenueSnapshots")
    .withIndex("by_date", (q: any) => q.eq("date", date))
    .first();
  if (existing) await ctx.db.patch(existing._id, row);
  else await ctx.db.insert("revenueSnapshots", row);
}

// Cron target — snapshot the AWST day that just ended (yesterday).
export const runDailyRevenueSnapshot = internalMutation({
  args: {},
  handler: async (ctx) => {
    const yesterday = awstDateKey(Date.now() - DAY_MS);
    await snapshotDate(ctx, yesterday);
    return { date: yesterday };
  },
});

// Admin backfill — rebuild snapshots for every AWST day from the earliest booking
// up to (and including) yesterday. Idempotent; run once after deploy.
export const backfillRevenueSnapshots = mutation({
  args: { fromDate: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    // COST-10 (audit 2026-06): find the earliest date via an indexed ascending read
    // instead of collecting the entire bookings table. snapshotDate filters to
    // confirmed bookings, so starting a day or two early (this ignores status) only
    // writes harmless idempotent zero rows.
    let earliest = args.fromDate ?? null;
    if (!earliest) {
      const first = await ctx.db.query("bookings").withIndex("by_date").order("asc").first();
      earliest = first?.date ?? null;
    }
    if (!earliest) return { written: 0 };

    // Read settings + lane count ONCE and pass them into every snapshotDate call (was
    // re-read from the DB ~1200× inside the loop).
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const lanesRows = await ctx.db.query("lanes").collect();
    const laneCount = lanesRows.length > 0 ? lanesRows.length : 5;

    const startMs = Date.UTC(
      Number(earliest.slice(0, 4)),
      Number(earliest.slice(5, 7)) - 1,
      Number(earliest.slice(8, 10))
    ) - AWST_OFFSET_MS;
    const endMs = Date.now() - DAY_MS; // up to yesterday AWST

    let written = 0;
    for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
      await snapshotDate(ctx, awstDateKey(ms), settings, laneCount);
      written++;
      if (written > 1200) break; // ~3.3y guard
    }
    return { written, from: earliest };
  },
});
