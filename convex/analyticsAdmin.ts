// SPEC_ANALYTICS_BUILD_2026-06 — admin analytics: bookings explorer, time-series
// revenue/bookings (hour/day/week/month), occupancy, retention cohorts, LTV,
// credit, referral attribution, discount performance, and the persisted
// revenue-snapshot reads. All queries are admin-only (return null/empty
// otherwise). Live full-table scans are acceptable at current volume — flagged
// for indexed range reads at scale (AUDIT B3).

import { query } from "./_generated/server";
import { v } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";
import { defaultLaneName } from "./lib/lanes";
import { computeCustomerPriceCents } from "./lib/pricing";
import { discountAmountCents } from "./lib/discounts";
import {
  DOW_LABELS,
  HOUR_MS,
  DAY_MS,
  awstDateKey,
  awstDateKeyToMs,
  dayLabel,
  isoWeekKey,
  monthKey,
  median,
  round2,
} from "./lib/analyticsHelpers";

const LANE_IDS = ["bm1", "bm2", "bm3", "ru1", "ru2"];
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function inRange(date: string, from?: string, to?: string): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

// FEA-2/COST-6 (audit 2026-06): read bookings through the by_date index when a window
// is supplied, instead of scanning the WHOLE table then JS-filtering. Result-identical
// for callers that gate every row through inRange(date, from, to). With no window it
// falls back to a full index scan (same rows as the old .collect()).
async function rangeBookings(ctx: any, from?: string, to?: string) {
  return await ctx.db
    .query("bookings")
    .withIndex("by_date", (q: any) => {
      let r = q;
      if (from) r = r.gte("date", from);
      if (to) r = r.lte("date", to);
      return r;
    })
    .collect();
}

async function isAdmin(ctx: any): Promise<boolean> {
  const caller = await getCallerContext(ctx);
  return caller.isAdmin;
}

// Resolve open lane-hours capacity for a given AWST date from siteSettings.
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

// ============================================================================
// C2.1 — BOOKINGS EXPLORER (filterable, sortable, paginated)
// ============================================================================
export const queryBookings = query({
  args: {
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    laneId: v.optional(v.string()),
    variantId: v.optional(v.string()),
    status: v.optional(v.string()),
    kind: v.optional(v.string()), // 'customer' | 'coach'
    search: v.optional(v.string()), // name/email contains
    suburb: v.optional(v.string()),
    sortBy: v.optional(v.string()), // 'date' | 'created' | 'price' | 'name'
    sortDir: v.optional(v.string()), // 'asc' | 'desc'
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const all = args.from
      ? await ctx.db
          .query("bookings")
          .withIndex("by_date", (q: any) => q.gte("date", args.from))
          .collect()
      : await ctx.db.query("bookings").collect();

    const search = (args.search ?? "").toLowerCase().trim();
    const suburb = (args.suburb ?? "").toLowerCase().trim();

    let rows = all.filter((b: any) => {
      if (!inRange(b.date, args.from, args.to)) return false;
      if (args.laneId) {
        const occ = b.laneId === args.laneId ||
          (Array.isArray(b.additionalLaneIds) && b.additionalLaneIds.includes(args.laneId));
        if (!occ) return false;
      }
      if (args.variantId && b.variantId !== args.variantId) return false;
      if (args.status && b.status !== args.status) return false;
      if (args.kind === "coach" && !b.isCoachBooking) return false;
      if (args.kind === "customer" && b.isCoachBooking) return false;
      if (suburb && (b.bookingSuburb ?? "").toLowerCase() !== suburb) return false;
      if (search) {
        const hay = `${b.customerName ?? ""} ${b.customerEmail ?? ""}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const total = rows.length;
    const dir = args.sortDir === "asc" ? 1 : -1;
    const by = args.sortBy ?? "date";
    rows.sort((a: any, b: any) => {
      let av: any, bv: any;
      if (by === "price") { av = a.priceInCents ?? (a.coachPrice ?? 0) * 100; bv = b.priceInCents ?? (b.coachPrice ?? 0) * 100; }
      else if (by === "created") { av = a.createdAt ?? a._creationTime; bv = b.createdAt ?? b._creationTime; }
      else if (by === "name") { av = (a.customerName ?? "").toLowerCase(); bv = (b.customerName ?? "").toLowerCase(); }
      else { av = `${a.date} ${String(a.startHour).padStart(5, "0")}`; bv = `${b.date} ${String(b.startHour).padStart(5, "0")}`; }
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    });

    const pageSize = Math.min(Math.max(args.pageSize ?? 50, 1), 200);
    const page = Math.max(args.page ?? 0, 0);
    const pageRows = rows.slice(page * pageSize, page * pageSize + pageSize).map((b: any) => ({
      id: b._id,
      date: b.date,
      startHour: b.startHour,
      duration: b.duration,
      laneId: b.laneId,
      laneName: b.laneNameSnapshot ?? defaultLaneName(b.laneId),
      variant: b.variantLabelSnapshot ?? b.variantId ?? "",
      additionalLanes: (b.additionalLaneIds ?? []).length,
      customerName: b.customerName ?? "",
      customerEmail: b.customerEmail ?? "",
      suburb: b.bookingSuburb ?? "",
      postcode: b.bookingPostcode ?? "",
      status: b.status,
      isCoachBooking: !!b.isCoachBooking,
      price: b.isCoachBooking ? (b.coachPrice ?? 0) : (b.priceInCents != null ? b.priceInCents / 100 : 0),
      discountCode: b.discountCode ?? "",
      createdAt: b.createdAt ?? b._creationTime,
    }));

    return { rows: pageRows, total, page, pageSize };
  },
});

// ============================================================================
// C2.7 — TIME-SERIES booking + revenue (granularity: hour | day | week | month)
// Buckets by SESSION date so future bookings are included (navigable forward).
// 'hour' aggregates by hour-of-day (scheduled startHour) across the range.
// ============================================================================
export const getBookingRevenueSeries = query({
  args: {
    granularity: v.string(), // 'hour' | 'day' | 'week' | 'month'
    from: v.optional(v.string()),
    to: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const all = await rangeBookings(ctx, args.from, args.to);
    const g = args.granularity;

    type Bucket = {
      key: string; label: string; custRevenue: number; coachCharges: number;
      bookings: number; customerBookings: number; coachBookings: number; hours: number;
    };
    const map = new Map<string, Bucket>();
    const ensure = (key: string, label: string): Bucket => {
      let b = map.get(key);
      if (!b) { b = { key, label, custRevenue: 0, coachCharges: 0, bookings: 0, customerBookings: 0, coachBookings: 0, hours: 0 }; map.set(key, b); }
      return b;
    };

    for (const b of all as any[]) {
      if (!inRange(b.date, args.from, args.to)) continue;
      if (b.status === "cancelled") continue;
      if (b.status !== "confirmed" && b.status !== "pending" && b.status !== "pending_payment") {
        // Only count realised/active bookings; skip unknown statuses.
      }
      const isConfirmed = b.status === "confirmed";
      if (!isConfirmed) continue;
      const hours = (b.duration ?? 0) / 60;
      const rev = b.priceInCents != null ? b.priceInCents / 100 : 0;
      const coach = b.isCoachBooking ? (b.coachPrice ?? 0) : 0;

      let key: string, label: string;
      if (g === "hour") {
        const h = Math.floor(b.startHour ?? 0);
        key = String(h).padStart(2, "0");
        const period = h >= 12 ? "pm" : "am";
        const disp = h > 12 ? h - 12 : h === 0 ? 12 : h;
        label = `${disp}${period}`;
      } else if (g === "week") {
        const w = isoWeekKey(b.date); key = w.key; label = w.label;
      } else if (g === "month") {
        const m = monthKey(b.date); key = m.key; label = m.label;
      } else {
        key = b.date; label = dayLabel(b.date);
      }

      const bucket = ensure(key, label);
      bucket.bookings++;
      bucket.hours += hours;
      if (b.isCoachBooking) { bucket.coachBookings++; bucket.coachCharges += coach; }
      else { bucket.customerBookings++; bucket.custRevenue += rev; }
    }

    const series = Array.from(map.values())
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((b) => ({
        ...b,
        custRevenue: round2(b.custRevenue),
        coachCharges: round2(b.coachCharges),
        hours: round2(b.hours),
      }));
    return { granularity: g, series };
  },
});

// Min/max session date across all bookings, so the dashboard can bound + extend
// the time-series navigation into the future (where future bookings exist).
export const getBookingDateBounds = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isAdmin(ctx))) return null;
    const all = await ctx.db.query("bookings").collect();
    let min: string | null = null;
    let max: string | null = null;
    for (const b of all as any[]) {
      if (b.status === "cancelled") continue;
      if (min === null || b.date < min) min = b.date;
      if (max === null || b.date > max) max = b.date;
    }
    return { min, max };
  },
});

// ============================================================================
// C2.2 — REVENUE SNAPSHOTS read (persisted end-of-day trend history)
// ============================================================================
export const getRevenueSnapshots = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const rows = await ctx.db
      .query("revenueSnapshots")
      .withIndex("by_date")
      .collect();
    return rows
      .filter((r: any) => inRange(r.date, args.from, args.to))
      .sort((a: any, b: any) => (a.date < b.date ? -1 : 1))
      .map((r: any) => ({
        date: r.date,
        custRevenue: r.custRevenue,
        coachCharges: r.coachCharges,
        bookings: r.bookings,
        customerBookings: r.customerBookings,
        coachBookings: r.coachBookings,
        hours: r.hours,
        occupancyPct: r.occupancyPct,
      }));
  },
});

// ============================================================================
// C2.6 — OCCUPANCY (booked hours ÷ open lane-hours capacity)
// ============================================================================
export const getOccupancy = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const lanesRows = await ctx.db.query("lanes").collect();
    const laneCount = lanesRows.length > 0 ? lanesRows.length : LANE_IDS.length;

    const all = (await rangeBookings(ctx, args.from, args.to)).filter(
      (b: any) => b.status === "confirmed" && inRange(b.date, args.from, args.to)
    );

    const byDate = new Map<string, number>(); // booked lane-hours per day
    const byLane = new Map<string, number>();
    const byHour = new Map<number, number>(); // booked count per hour-of-day
    const byHourWeekday = new Map<number, number>();
    const byHourWeekend = new Map<number, number>();
    for (const b of all as any[]) {
      const laneIds = [b.laneId, ...(b.additionalLaneIds ?? [])];
      const hours = (b.duration ?? 0) / 60;
      byDate.set(b.date, (byDate.get(b.date) ?? 0) + hours * laneIds.length);
      for (const lid of laneIds) byLane.set(lid, (byLane.get(lid) ?? 0) + hours);
      const hb = Math.floor(b.startHour ?? 0);
      byHour.set(hb, (byHour.get(hb) ?? 0) + 1);
      const [yy, mm, dd] = b.date.split("-").map(Number);
      const dow = new Date(Date.UTC(yy, (mm || 1) - 1, dd || 1)).getUTCDay();
      const isWeekend = dow === 0 || dow === 6;
      const target = isWeekend ? byHourWeekend : byHourWeekday;
      target.set(hb, (target.get(hb) ?? 0) + 1);
    }

    let totalBooked = 0;
    let totalCapacity = 0;
    const daily: { date: string; occupancyPct: number; bookedHours: number; capacityHours: number }[] = [];
    for (const [date, booked] of Array.from(byDate.entries()).sort()) {
      const cap = openHoursForDate(settings, date) * laneCount;
      totalBooked += booked;
      totalCapacity += cap;
      daily.push({
        date,
        bookedHours: round2(booked),
        capacityHours: round2(cap),
        occupancyPct: cap > 0 ? Math.round((booked / cap) * 100) : 0,
      });
    }

    const lanes = LANE_IDS.map((lid) => ({
      laneId: lid,
      name: defaultLaneName(lid),
      hours: round2(byLane.get(lid) ?? 0),
    }));
    const hourSeries = (m: Map<number, number>) =>
      Array.from(m.entries()).sort((a, b) => a[0] - b[0]).map(([h, count]) => ({ hour: h, count }));
    const byHourOfDay = hourSeries(byHour);

    return {
      overallPct: totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0,
      totalBookedHours: round2(totalBooked),
      totalCapacityHours: round2(totalCapacity),
      laneCount,
      daily,
      lanes,
      byHourOfDay,
      byHourWeekday: hourSeries(byHourWeekday),
      byHourWeekend: hourSeries(byHourWeekend),
    };
  },
});

// ============================================================================
// C2.6 — RETENTION COHORTS (weekly cohorts by first booking, repeat rate)
// ============================================================================
export const getRetentionCohorts = query({
  args: { weeks: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    // Expanded to 26 weeks (was 8). Default + cap 26.
    const maxOffsets = Math.min(Math.max(args.weeks ?? 26, 2), 26);
    const all = (await ctx.db.query("bookings").collect()).filter(
      (b: any) => !b.isCoachBooking && b.status === "confirmed" && b.customerEmail
    );

    // email -> set of week keys with a booking; earliest + latest week; all weeks.
    const weeksByEmail = new Map<string, Set<string>>();
    const firstWeekByEmail = new Map<string, { key: string; ms: number }>();
    const lastWeekMsByEmail = new Map<string, number>();
    const weekMsByEmail = new Map<string, number[]>();
    for (const b of all as any[]) {
      const email = b.customerEmail.toLowerCase();
      const w = isoWeekKey(b.date);
      const set = weeksByEmail.get(email) ?? new Set<string>();
      set.add(w.key);
      weeksByEmail.set(email, set);
      const prev = firstWeekByEmail.get(email);
      if (!prev || w.mondayMs < prev.ms) firstWeekByEmail.set(email, { key: w.key, ms: w.mondayMs });
      lastWeekMsByEmail.set(email, Math.max(lastWeekMsByEmail.get(email) ?? 0, w.mondayMs));
      const arr = weekMsByEmail.get(email) ?? [];
      arr.push(w.mondayMs);
      weekMsByEmail.set(email, arr);
    }

    // Group customers by their first-booking week (cohort).
    const cohortMembers = new Map<string, { ms: number; emails: string[] }>();
    for (const [email, first] of firstWeekByEmail) {
      const c = cohortMembers.get(first.key) ?? { ms: first.ms, emails: [] };
      c.emails.push(email);
      cohortMembers.set(first.key, c);
    }

    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const cohorts = Array.from(cohortMembers.entries())
      .sort((a, b) => a[1].ms - b[1].ms)
      .map(([key, c]) => {
        const size = c.emails.length;
        const retention: number[] = [];
        for (let off = 0; off < maxOffsets; off++) {
          const targetMs = c.ms + off * WEEK_MS;
          const targetKey = isoWeekKey(awstDateKey(targetMs)).key;
          let active = 0;
          for (const email of c.emails) {
            if (weeksByEmail.get(email)?.has(targetKey)) active++;
          }
          retention.push(size > 0 ? Math.round((active / size) * 100) : 0);
        }
        // Per-cohort extras: repeat rate (≥2 active weeks) + avg active weeks.
        let repeat = 0;
        let weeksActiveSum = 0;
        for (const email of c.emails) {
          const wc = weeksByEmail.get(email)?.size ?? 0;
          if (wc >= 2) repeat++;
          weeksActiveSum += wc;
        }
        return {
          cohort: isoWeekKey(key).label,
          cohortKey: key,
          size,
          retention,
          repeatPct: size > 0 ? Math.round((repeat / size) * 100) : 0,
          avgWeeksActive: size > 0 ? round2(weeksActiveSum / size) : 0,
        };
      });

    // ── Extra cross-cohort analytics ──────────────────────────────────────────
    const nowWeekMs = isoWeekKey(awstDateKey(Date.now())).mondayMs;
    const allEmails = Array.from(firstWeekByEmail.keys());
    const totalCustomers = allEmails.length;
    let repeatAll = 0;
    let lifespanSum = 0;
    let churned = 0;
    let reactivated = 0;
    for (const email of allEmails) {
      const wc = weeksByEmail.get(email)?.size ?? 0;
      if (wc >= 2) repeatAll++;
      const first = firstWeekByEmail.get(email)!.ms;
      const last = lastWeekMsByEmail.get(email) ?? first;
      lifespanSum += Math.round((last - first) / WEEK_MS) + 1; // weeks first→last inclusive
      if ((nowWeekMs - last) / WEEK_MS > 4) churned++; // no activity in 4+ weeks
      const uniq = Array.from(new Set(weekMsByEmail.get(email) ?? [])).sort((a, b) => a - b);
      for (let i = 1; i < uniq.length; i++) {
        if ((uniq[i] - uniq[i - 1]) / WEEK_MS >= 4) { reactivated++; break; } // returned after a 4+ week gap
      }
    }
    // Size-weighted average retention at each week offset (the rolling retention curve).
    const weekNRetention: number[] = [];
    for (let off = 0; off < maxOffsets; off++) {
      let num = 0, den = 0;
      for (const c of cohorts) { num += (c.retention[off] ?? 0) * c.size; den += c.size; }
      weekNRetention.push(den > 0 ? Math.round(num / den) : 0);
    }

    return {
      cohorts,
      maxOffsets,
      summary: {
        totalCustomers,
        repeatRatePct: totalCustomers > 0 ? Math.round((repeatAll / totalCustomers) * 100) : 0,
        avgLifespanWeeks: totalCustomers > 0 ? round2(lifespanSum / totalCustomers) : 0,
        churnedPct: totalCustomers > 0 ? Math.round((churned / totalCustomers) * 100) : 0,
        reactivatedCount: reactivated,
        weekNRetention,
      },
    };
  },
});

// ============================================================================
// C2.6 — LTV + averages, plus customer-level revenue table
// ============================================================================
export const getCustomerValue = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const all = (await rangeBookings(ctx, args.from, args.to)).filter(
      (b: any) => !b.isCoachBooking && b.status === "confirmed" && b.customerEmail && inRange(b.date, args.from, args.to)
    );
    const byEmail = new Map<string, { email: string; name: string; bookings: number; revenue: number; firstDate: string; lastDate: string }>();
    for (const b of all as any[]) {
      const email = b.customerEmail.toLowerCase();
      const rev = b.priceInCents != null ? b.priceInCents / 100 : 0;
      const c = byEmail.get(email) ?? { email, name: b.customerName ?? email, bookings: 0, revenue: 0, firstDate: b.date, lastDate: b.date };
      c.bookings++;
      c.revenue += rev;
      if (b.date < c.firstDate) c.firstDate = b.date;
      if (b.date > c.lastDate) c.lastDate = b.date;
      byEmail.set(email, c);
    }
    const customers = Array.from(byEmail.values());
    const totalRevenue = customers.reduce((s, c) => s + c.revenue, 0);
    const totalBookings = customers.reduce((s, c) => s + c.bookings, 0);
    const n = customers.length;
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
    const top = customers
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit)
      .map((c) => ({ ...c, revenue: round2(c.revenue) }));
    return {
      uniqueCustomers: n,
      avgLtv: n > 0 ? round2(totalRevenue / n) : 0,
      avgBookingsPerCustomer: n > 0 ? round2(totalBookings / n) : 0,
      avgRevenuePerBooking: totalBookings > 0 ? round2(totalRevenue / totalBookings) : 0,
      totalRevenue: round2(totalRevenue),
      top,
    };
  },
});

// ============================================================================
// C2.9 — CREDIT analytics (issuance by reason, redemption, redemption latency)
// ============================================================================
export const getCreditAnalytics = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const ledger = await ctx.db.query("creditLedger").collect();
    const fromMs = args.from ? Date.parse(args.from + "T00:00:00+08:00") : -Infinity;
    const toMs = args.to ? Date.parse(args.to + "T23:59:59+08:00") : Infinity;

    const issuedByReason: Record<string, number> = {};
    let totalIssued = 0;
    let totalRedeemed = 0;
    let issuedCount = 0;
    let redeemedCount = 0;

    // Per-customer FIFO matching of issuance → redemption for latency.
    const byCustomer = new Map<string, any[]>();
    for (const e of ledger as any[]) {
      const arr = byCustomer.get(e.customerId) ?? [];
      arr.push(e);
      byCustomer.set(e.customerId, arr);
    }

    const latencies: number[] = []; // ms, issue -> redeem
    for (const [, entries] of byCustomer) {
      const sorted = entries.sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at));
      const issueQueue: { amount: number; at: number }[] = [];
      for (const e of sorted) {
        const t = Date.parse(e.at);
        if (e.delta > 0) {
          issueQueue.push({ amount: e.delta, at: t });
        } else if (e.delta < 0) {
          // redemption — consume oldest issuances FIFO
          let need = -e.delta;
          while (need > 0 && issueQueue.length > 0) {
            const head = issueQueue[0];
            const take = Math.min(need, head.amount);
            if (t >= head.at) latencies.push(t - head.at);
            head.amount -= take;
            need -= take;
            if (head.amount <= 1e-9) issueQueue.shift();
          }
        }
      }
    }

    for (const e of ledger as any[]) {
      const t = Date.parse(e.at);
      if (t < fromMs || t > toMs) continue;
      if (e.delta > 0) {
        totalIssued += e.delta;
        issuedCount++;
        issuedByReason[e.reason] = (issuedByReason[e.reason] ?? 0) + e.delta;
      } else if (e.delta < 0) {
        totalRedeemed += -e.delta;
        redeemedCount++;
      }
    }

    // Current outstanding balance across all customers.
    const customers = await ctx.db.query("customers").collect();
    let outstanding = 0;
    let holders = 0;
    for (const c of customers as any[]) {
      const bal = c.creditBalance ?? 0;
      if (bal > 0) { outstanding += bal; holders++; }
    }

    const DAY = 24 * 60 * 60 * 1000;
    return {
      totalIssued: round2(totalIssued),
      totalRedeemed: round2(totalRedeemed),
      issuedCount,
      redeemedCount,
      issuedByReason: Object.fromEntries(Object.entries(issuedByReason).map(([k, v2]) => [k, round2(v2)])),
      cancellationCredit: round2(issuedByReason["cancellation"] ?? 0),
      outstanding: round2(outstanding),
      holders,
      redeemedPctOfIssued: totalIssued > 0 ? Math.round((totalRedeemed / totalIssued) * 100) : 0,
      medianDaysToRedeem: latencies.length ? round2(median(latencies) / DAY) : 0,
      avgDaysToRedeem: latencies.length ? round2(latencies.reduce((s, x) => s + x, 0) / latencies.length / DAY) : 0,
      matchedRedemptions: latencies.length,
    };
  },
});

// ============================================================================
// C2.6 — REFERRAL attribution ("How did you hear about us?")
// ============================================================================
export const getReferralBreakdown = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const customers = await ctx.db.query("customers").collect();
    const fromMs = args.from ? Date.parse(args.from + "T00:00:00+08:00") : -Infinity;
    const toMs = args.to ? Date.parse(args.to + "T23:59:59+08:00") : Infinity;
    const counts: Record<string, number> = {};
    let withSource = 0;
    let total = 0;
    for (const c of customers as any[]) {
      if (c.role !== "customer" && c.role !== "user") continue;
      const t = Date.parse(c.createdAt ?? "");
      if (Number.isFinite(t) && (t < fromMs || t > toMs)) continue;
      total++;
      const src = (c.referralSource ?? "").trim();
      if (!src) continue;
      withSource++;
      const label = src === "Other" && c.referralSourceOther ? `Other: ${c.referralSourceOther}` : src;
      counts[label] = (counts[label] ?? 0) + 1;
    }
    const rows = Object.entries(counts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);
    return { rows, total, withSource, unknown: total - withSource };
  },
});

// ============================================================================
// C2.6 — DISCOUNT code performance
// ============================================================================
export const getDiscountPerformance = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const redemptions = await ctx.db.query("discountRedemptions").collect();
    const codes = await ctx.db.query("discountCodes").collect();
    const codeMeta = new Map<string, any>();
    for (const c of codes as any[]) codeMeta.set(c.code, c);

    const fromMs = args.from ? Date.parse(args.from + "T00:00:00+08:00") : -Infinity;
    const toMs = args.to ? Date.parse(args.to + "T23:59:59+08:00") : Infinity;

    const byCode = new Map<string, { code: string; redemptions: number; customers: Set<string> }>();
    for (const r of redemptions as any[]) {
      const t = Date.parse(r.at ?? "");
      if (Number.isFinite(t) && (t < fromMs || t > toMs)) continue;
      const row = byCode.get(r.code) ?? { code: r.code, redemptions: 0, customers: new Set<string>() };
      row.redemptions++;
      row.customers.add((r.customerEmail ?? "").toLowerCase());
      byCode.set(r.code, row);
    }

    const rows = Array.from(byCode.values())
      .map((r) => {
        const meta = codeMeta.get(r.code);
        return {
          code: r.code,
          label: meta?.label ?? r.code,
          discountType: meta?.discountType ?? "percent",
          discount: meta?.discount ?? 0,
          amountOff: meta?.amountOff ?? 0,
          active: meta?.active ?? false,
          redemptions: r.redemptions,
          uniqueCustomers: r.customers.size,
          usageLimit: meta?.usageLimit ?? null,
        };
      })
      .sort((a, b) => b.redemptions - a.redemptions);
    return { rows, totalRedemptions: rows.reduce((s, r) => s + r.redemptions, 0) };
  },
});

// ============================================================================
// Today / this week / next week revenue + bookings, plus bookings created today.
// ============================================================================
type PeriodBucket = {
  custRevenue: number; coachCharges: number; bookings: number;
  customerBookings: number; coachBookings: number; hours: number;
};
const blankBucket = (): PeriodBucket => ({
  custRevenue: 0, coachCharges: 0, bookings: 0, customerBookings: 0, coachBookings: 0, hours: 0,
});

export const getPeriodSummary = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isAdmin(ctx))) return null;
    const all = await ctx.db.query("bookings").collect();
    const today = awstDateKey(Date.now());
    const wk = isoWeekKey(today);
    const thisMon = wk.key;
    const thisSun = awstDateKey(wk.mondayMs + 6 * DAY_MS);
    const nextMon = awstDateKey(wk.mondayMs + 7 * DAY_MS);
    const nextSun = awstDateKey(wk.mondayMs + 13 * DAY_MS);
    const todayStartMs = awstDateKeyToMs(today);
    const todayEndMs = todayStartMs + DAY_MS;

    const todayB = blankBucket();
    const thisWeek = blankBucket();
    const nextWeek = blankBucket();
    let createdTodayCount = 0;
    let createdTodayRevenue = 0;

    for (const b of all as any[]) {
      if (b.status !== "confirmed") continue;
      const h = (b.duration ?? 0) / 60;
      const rev = b.priceInCents != null ? b.priceInCents / 100 : 0;
      const coach = b.isCoachBooking ? (b.coachPrice ?? 0) : 0;
      const add = (bk: PeriodBucket) => {
        bk.bookings++; bk.hours += h;
        if (b.isCoachBooking) { bk.coachBookings++; bk.coachCharges += coach; }
        else { bk.customerBookings++; bk.custRevenue += rev; }
      };
      if (b.date === today) add(todayB);
      if (b.date >= thisMon && b.date <= thisSun) add(thisWeek);
      if (b.date >= nextMon && b.date <= nextSun) add(nextWeek);
      if (typeof b.createdAt === "number" && b.createdAt >= todayStartMs && b.createdAt < todayEndMs) {
        createdTodayCount++;
        if (!b.isCoachBooking) createdTodayRevenue += rev;
      }
    }
    const fin = (bk: PeriodBucket) => ({
      ...bk, custRevenue: round2(bk.custRevenue), coachCharges: round2(bk.coachCharges), hours: round2(bk.hours),
    });
    return {
      today: fin(todayB),
      thisWeek: fin(thisWeek),
      nextWeek: fin(nextWeek),
      createdToday: { count: createdTodayCount, custRevenue: round2(createdTodayRevenue) },
      ranges: { today, thisMon, thisSun, nextMon, nextSun },
    };
  },
});

// ============================================================================
// Booking lead time — how far ahead people book (createdAt → session start).
// ============================================================================
export const getBookingLeadTime = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const all = await rangeBookings(ctx, args.from, args.to);
    const leadsH: number[] = []; // hours ahead
    const custLeadsH: number[] = [];
    const buckets = { walk_in: 0, lt2h: 0, h2_24: 0, d1_3: 0, d3_7: 0, d7_14: 0, gt14: 0 };
    let counted = 0;
    for (const b of all as any[]) {
      if (b.status !== "confirmed") continue;
      if (typeof b.createdAt !== "number") continue; // legacy rows have no createdAt
      if (!inRange(b.date, args.from, args.to)) continue;
      const startMs = awstDateKeyToMs(b.date) + (b.startHour ?? 0) * HOUR_MS;
      const leadH = (startMs - b.createdAt) / HOUR_MS;
      counted++;
      leadsH.push(leadH);
      if (!b.isCoachBooking) custLeadsH.push(leadH);
      if (leadH < 0) buckets.walk_in++;
      else if (leadH < 2) buckets.lt2h++;
      else if (leadH < 24) buckets.h2_24++;
      else if (leadH < 72) buckets.d1_3++;
      else if (leadH < 168) buckets.d3_7++;
      else if (leadH < 336) buckets.d7_14++;
      else buckets.gt14++;
    }
    return {
      counted,
      medianLeadHours: leadsH.length ? round2(median(leadsH)) : 0,
      medianLeadDays: leadsH.length ? round2(median(leadsH) / 24) : 0,
      avgLeadDays: leadsH.length ? round2(leadsH.reduce((s, x) => s + x, 0) / leadsH.length / 24) : 0,
      custMedianLeadDays: custLeadsH.length ? round2(median(custLeadsH) / 24) : 0,
      buckets,
    };
  },
});

// ============================================================================
// Cancellation timing — how early/late people cancel relative to session start.
// ============================================================================
export const getCancellationAnalytics = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const lateWindowH = settings?.customerCancellationHours ?? settings?.cancellationHoursBefore ?? 2;

    const all = await rangeBookings(ctx, args.from, args.to);
    const leadsH: number[] = [];
    const buckets = { gt48h: 0, h24_48: 0, h6_24: 0, h2_6: 0, lt2h: 0, after_start: 0 };
    let cancelled = 0;
    let withinLateWindow = 0; // cancelled inside the customer cancellation window
    let coachLateCharged = 0;
    let confirmedOrCancelled = 0;
    for (const b of all as any[]) {
      if (b.status === "confirmed") confirmedOrCancelled++;
      if (b.status !== "cancelled") continue;
      if (!inRange(b.date, args.from, args.to)) continue;
      cancelled++;
      confirmedOrCancelled++;
      if (b.coachLateCancelCharged) coachLateCharged++;
      const cancelledAtMs = b.cancelledAt ? Date.parse(b.cancelledAt) : NaN;
      if (!Number.isFinite(cancelledAtMs)) continue;
      const startMs = awstDateKeyToMs(b.date) + (b.startHour ?? 0) * HOUR_MS;
      const leadH = (startMs - cancelledAtMs) / HOUR_MS; // +ve = before start
      leadsH.push(leadH);
      if (leadH < 0) buckets.after_start++;
      else if (leadH < 2) buckets.lt2h++;
      else if (leadH < 6) buckets.h2_6++;
      else if (leadH < 24) buckets.h6_24++;
      else if (leadH < 48) buckets.h24_48++;
      else buckets.gt48h++;
      if (leadH >= 0 && leadH < lateWindowH) withinLateWindow++;
    }
    return {
      cancelled,
      cancellationRatePct: confirmedOrCancelled > 0 ? Math.round((cancelled / confirmedOrCancelled) * 100) : 0,
      medianLeadHours: leadsH.length ? round2(median(leadsH)) : 0,
      avgLeadHours: leadsH.length ? round2(leadsH.reduce((s, x) => s + x, 0) / leadsH.length) : 0,
      lateWindowHours: lateWindowH,
      withinLateWindow,
      lateCancelPct: cancelled > 0 ? Math.round((withinLateWindow / cancelled) * 100) : 0,
      coachLateCharged,
      buckets,
    };
  },
});

// ============================================================================
// Top customers — this month vs all time, side by side (no email/PII).
// ============================================================================
export const getTopCustomersComparison = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const all = (await ctx.db.query("bookings").collect()).filter(
      (b: any) => !b.isCoachBooking && b.status === "confirmed" && b.customerEmail
    );
    const thisMonthKey = awstDateKey(Date.now()).slice(0, 7); // YYYY-MM

    type Agg = { name: string; bookings: number; revenue: number };
    const allTime = new Map<string, Agg>();
    const month = new Map<string, Agg>();
    for (const b of all as any[]) {
      const email = b.customerEmail.toLowerCase();
      const rev = b.priceInCents != null ? b.priceInCents / 100 : 0;
      const a = allTime.get(email) ?? { name: b.customerName ?? email, bookings: 0, revenue: 0 };
      a.bookings++; a.revenue += rev; allTime.set(email, a);
      if (b.date.slice(0, 7) === thisMonthKey) {
        const m = month.get(email) ?? { name: b.customerName ?? email, bookings: 0, revenue: 0 };
        m.bookings++; m.revenue += rev; month.set(email, m);
      }
    }
    const top = (m: Map<string, Agg>) =>
      Array.from(m.values())
        .sort((a, b) => b.bookings - a.bookings || b.revenue - a.revenue)
        .slice(0, limit)
        .map((c) => ({ name: c.name, bookings: c.bookings, revenue: round2(c.revenue) }));
    return { thisMonth: top(month), allTime: top(allTime), monthKey: thisMonthKey };
  },
});

// ============================================================================
// Weekly lane utilisation (booked hours per physical lane per week). Scrollable
// week-by-week to monitor carpet wear. Includes additional lanes per booking.
// ============================================================================
export const getLaneWeekly = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const all = (await rangeBookings(ctx, args.from, args.to)).filter(
      (b: any) => b.status === "confirmed" && inRange(b.date, args.from, args.to)
    );
    // weekKey -> { label, mondayMs, lanes: {laneId: hours}, total }
    const weeks = new Map<string, { label: string; mondayMs: number; lanes: Record<string, number>; total: number }>();
    for (const b of all as any[]) {
      const w = isoWeekKey(b.date);
      const entry = weeks.get(w.key) ?? { label: w.label, mondayMs: w.mondayMs, lanes: {}, total: 0 };
      const h = (b.duration ?? 0) / 60;
      for (const lid of [b.laneId, ...((b.additionalLaneIds as string[]) ?? [])]) {
        entry.lanes[lid] = (entry.lanes[lid] ?? 0) + h;
        entry.total += h;
      }
      weeks.set(w.key, entry);
    }
    const series = Array.from(weeks.entries())
      .sort((a, b) => a[1].mondayMs - b[1].mondayMs)
      .map(([weekKey, e]) => ({
        weekKey,
        label: e.label,
        total: round2(e.total),
        lanes: Object.fromEntries(LANE_IDS.map((lid) => [lid, round2(e.lanes[lid] ?? 0)])),
      }));
    return { laneIds: LANE_IDS, laneNames: LANE_IDS.map((l) => defaultLaneName(l)), series };
  },
});

// Cumulative carpet-wear (2026-06): accumulated booked HOURS per physical lane over
// time (weekly), counting from each lane's latest carpet reset forward. All lanes on
// one chart so wear growth is comparable; a reset zeroes that lane's accumulator.
export const getLaneWearCumulative = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isAdmin(ctx))) return null;
    const resets = await ctx.db.query("laneWearResets").collect();
    const resetByLane: Record<string, string> = {};
    for (const r of resets as any[]) {
      if (!resetByLane[r.laneId] || r.resetDate > resetByLane[r.laneId]) resetByLane[r.laneId] = r.resetDate;
    }
    const all = (await ctx.db.query("bookings").collect()).filter(
      (b: any) => b.status === "confirmed"
    );
    // weekKey -> { mondayMs, label, lanes: {laneId: hoursThisWeek} }
    const weeks = new Map<string, { mondayMs: number; label: string; lanes: Record<string, number> }>();
    for (const b of all as any[]) {
      const h = (b.duration ?? 0) / 60;
      const w = isoWeekKey(b.date);
      for (const lid of [b.laneId, ...((b.additionalLaneIds as string[]) ?? [])]) {
        if (!LANE_IDS.includes(lid)) continue;
        const reset = resetByLane[lid];
        if (reset && b.date < reset) continue; // pre-reset wear excluded
        const e = weeks.get(w.key) ?? { mondayMs: w.mondayMs, label: w.label, lanes: {} };
        e.lanes[lid] = (e.lanes[lid] ?? 0) + h;
        weeks.set(w.key, e);
      }
    }
    const ordered = Array.from(weeks.entries())
      .map(([weekKey, e]) => ({ weekKey, ...e }))
      .sort((a, b) => a.mondayMs - b.mondayMs);
    const cum: Record<string, number> = {};
    for (const l of LANE_IDS) cum[l] = 0;
    const series = ordered.map((w) => {
      const row: Record<string, any> = { weekKey: w.weekKey, label: w.label };
      for (const lid of LANE_IDS) {
        cum[lid] += w.lanes[lid] ?? 0;
        row[lid] = round2(cum[lid]);
      }
      return row;
    });
    return {
      laneIds: LANE_IDS,
      laneNames: LANE_IDS.map((l) => defaultLaneName(l)),
      series,
      resets: LANE_IDS.map((l) => ({
        laneId: l,
        laneName: defaultLaneName(l),
        resetDate: resetByLane[l] ?? null,
      })),
    };
  },
});

// ============================================================================
// WEEKLY REPORT (printable) — admin operations summary for one Mon–Sun week.
//   • Section A: each coach's session count, hours, and $ billed for the week
//     (from coachPrice — the statement figure; excludes statement-removed lines).
//   • Section B: customer cash revenue PER DAY (Mon–Sun), by session day. Cash =
//     authoritative Stripe net (stripePayments, paid/complete), with offline-paid
//     admin bookings falling back to priceInCents − credit.
//   • Section C: itemised account-credit and discount usage + weekly totals.
// All amounts in dollars. Confirmed bookings only (pending/cancelled excluded).
// ============================================================================

const REPORT_DAY_LABELS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Add N days to a YYYY-MM-DD using UTC arithmetic (calendar-safe, no TZ drift).
function addDaysStr(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export const getWeeklyReport = query({
  // weekStart = the Monday of the week (YYYY-MM-DD). The client defaults this to
  // the last completed Mon–Sun and lets the admin step weeks.
  args: { weekStart: v.string() },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const weekStart = args.weekStart;
    const weekEnd = addDaysStr(weekStart, 6);
    const days = Array.from({ length: 7 }, (_, i) => addDaysStr(weekStart, i));

    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();

    // Bookings whose SESSION date falls in the week (indexed range read).
    const bookings = (await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.gte("date", weekStart).lte("date", weekEnd))
      .collect()) as any[];

    // Authoritative customer cash: Stripe net charges for sessions in the week,
    // summed per booking (a top-up adds a 2nd row → both count).
    const payments = (await ctx.db
      .query("stripePayments")
      .withIndex("by_date", (q: any) => q.gte("date", weekStart).lte("date", weekEnd))
      .collect()) as any[];
    const cashByBooking = new Map<string, number>();
    for (const p of payments) {
      const st = (p.status || "").toLowerCase();
      if (st !== "paid" && st !== "complete") continue;
      cashByBooking.set(p.bookingId, (cashByBooking.get(p.bookingId) ?? 0) + (p.amount || 0));
    }

    // Discount-code definitions (small table) → recompute the $ given per session.
    const codeMap = new Map<string, any>();
    for (const c of (await ctx.db.query("discountCodes").collect()) as any[]) {
      codeMap.set((c.code || "").toLowerCase().trim(), c);
    }

    const coachMap = new Map<
      string,
      { name: string; email: string; sessions: number; hours: number; amount: number }
    >();
    const dayMap = new Map<
      string,
      { date: string; dayName: string; sessions: number; cash: number; creditUsed: number; discountGiven: number }
    >();
    for (const d of days) {
      const dow = new Date(d + "T00:00:00Z").getUTCDay();
      dayMap.set(d, { date: d, dayName: REPORT_DAY_LABELS[dow], sessions: 0, cash: 0, creditUsed: 0, discountGiven: 0 });
    }

    const creditItems: Array<{ date: string; customerName: string; amount: number; lane: string; startHour: number }> = [];
    const discountItems: Array<{ date: string; customerName: string; code: string; amount: number; lane: string; startHour: number }> = [];

    for (const b of bookings) {
      if (b.status !== "confirmed") continue; // exclude pending/cancelled

      if (b.isCoachBooking) {
        if (b.statementExcluded) continue; // removed from the coach statement
        const key = (b.customerEmail || "").toLowerCase().trim() || (b.customerName || "unknown");
        const e =
          coachMap.get(key) ??
          { name: b.customerName || "Unknown", email: b.customerEmail || "", sessions: 0, hours: 0, amount: 0 };
        e.sessions += 1;
        e.hours += (b.duration || 0) / 60;
        e.amount += b.coachPrice || 0;
        coachMap.set(key, e);
        continue;
      }

      // Customer booking
      const day = dayMap.get(b.date);
      if (!day) continue;
      day.sessions += 1;

      const id = b._id.toString();
      let cash = 0;
      if (cashByBooking.has(id)) cash = cashByBooking.get(id)!;
      else if (b.paymentStatus === "paid") cash = Math.max(0, (b.priceInCents || 0) / 100 - (b.creditApplied || 0));
      day.cash += cash;

      const credit = b.creditApplied || 0;
      if (credit > 0) {
        day.creditUsed += credit;
        creditItems.push({
          date: b.date,
          customerName: b.customerName || "Customer",
          amount: credit,
          lane: b.laneNameSnapshot || b.laneId,
          startHour: b.startHour,
        });
      }

      if (b.discountCode) {
        const def = codeMap.get((b.discountCode || "").toLowerCase().trim());
        let disc = 0;
        if (def) {
          let grossCents = computeCustomerPriceCents(settings as any, b.variantId, b.duration);
          for (const _l of (b.additionalLaneIds || []) as string[]) {
            grossCents += computeCustomerPriceCents(settings as any, null, b.duration);
          }
          const type = def.discountType ?? "percent";
          if (type === "free") disc = grossCents / 100;
          else
            disc =
              discountAmountCents(grossCents, {
                discount: def.discount,
                type: type === "fixed" ? "fixed" : "percent",
                amountOff: def.amountOff ?? 0,
                label: "",
                bypassStripe: false,
              } as any) / 100;
        }
        day.discountGiven += disc;
        discountItems.push({
          date: b.date,
          customerName: b.customerName || "Customer",
          code: b.discountCode,
          amount: disc,
          lane: b.laneNameSnapshot || b.laneId,
          startHour: b.startHour,
        });
      }
    }

    // ── Coach account balances (opening / paid this week / current) ──────────
    // Mirrors buildCoachLedger (src/lib/statementLedger.ts) so "Balance" equals
    // the coach's statement page: balance = booked + adjustments − paid, with
    // statement-excluded charges counted as $0 and late-cancelled coach bookings
    // still charged.
    const coachDocs = (await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", "coach"))
      .collect()) as any[];

    // Booked charges up to the END of the displayed week (indexed), split
    // before-week vs to-week-end, by email.
    const bookedBeforeByEmail = new Map<string, number>();
    const bookedToWeekEndByEmail = new Map<string, number>();
    const bookingsToWeekEnd = (await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.lte("date", weekEnd))
      .collect()) as any[];
    for (const b of bookingsToWeekEnd) {
      const isCoachCharge =
        b.isCoachBooking === true || (typeof b.coachPrice === "number" && b.coachPrice > 0);
      if (!isCoachCharge) continue;
      // filterCoachBookings: late-cancelled-charged stay; other cancelled excluded.
      if (b.status === "cancelled" && b.coachLateCancelCharged !== true) continue;
      const cost = b.statementExcluded === true ? 0 : Number(b.coachPrice) || 0;
      if (cost === 0) continue;
      const email = (b.customerEmail ?? "").toLowerCase().trim();
      if (!email) continue;
      bookedToWeekEndByEmail.set(email, (bookedToWeekEndByEmail.get(email) ?? 0) + cost);
      if (b.date < weekStart)
        bookedBeforeByEmail.set(email, (bookedBeforeByEmail.get(email) ?? 0) + cost);
    }

    // Payments, split before-week / this-week / total, by coachId.
    const paidBeforeByCoach = new Map<string, number>();
    const paidThisWeekByCoach = new Map<string, number>();
    for (const p of (await ctx.db.query("payments").collect()) as any[]) {
      const cid = String(p.coachId ?? "");
      if (!cid) continue;
      const amt = Number(p.amount) || 0;
      const dr = p.dateReceived ?? "";
      if (dr && dr < weekStart) paidBeforeByCoach.set(cid, (paidBeforeByCoach.get(cid) ?? 0) + amt);
      if (dr >= weekStart && dr <= weekEnd)
        paidThisWeekByCoach.set(cid, (paidThisWeekByCoach.get(cid) ?? 0) + amt);
    }

    // Coach statement adjustments, split before-week / to-week-end, by coachId.
    const adjBeforeByCoach = new Map<string, number>();
    const adjToWeekEndByCoach = new Map<string, number>();
    for (const a of (await ctx.db
      .query("statementAdjustments")
      .withIndex("by_subject", (q: any) => q.eq("subjectType", "coach"))
      .collect()) as any[]) {
      const cid = String(a.subjectId ?? "");
      if (!cid) continue;
      const d = a.date ?? "";
      const delta = Number(a.delta) || 0;
      if (d && d <= weekEnd) adjToWeekEndByCoach.set(cid, (adjToWeekEndByCoach.get(cid) ?? 0) + delta);
      if (d && d < weekStart) adjBeforeByCoach.set(cid, (adjBeforeByCoach.get(cid) ?? 0) + delta);
    }

    // Per-coach finance keyed by email (charges key by email; pay/adj by coachId).
    const financeByEmail = new Map<
      string,
      { openingBalance: number; paymentsThisWeek: number; closingBalance: number }
    >();
    for (const c of coachDocs) {
      const email = (c.email ?? "").toLowerCase().trim();
      if (!email) continue;
      const cid = String(c._id);
      const bookedBefore = bookedBeforeByEmail.get(email) ?? 0;
      const bookedToWeekEnd = bookedToWeekEndByEmail.get(email) ?? 0;
      const paidBefore = paidBeforeByCoach.get(cid) ?? 0;
      const paidThisWeek = paidThisWeekByCoach.get(cid) ?? 0;
      const adjBefore = adjBeforeByCoach.get(cid) ?? 0;
      const adjToWeekEnd = adjToWeekEndByCoach.get(cid) ?? 0;
      financeByEmail.set(email, {
        openingBalance: round2(bookedBefore + adjBefore - paidBefore),
        paymentsThisWeek: round2(paidThisWeek),
        // Balance as at the END of the displayed week (not live), so it reconciles:
        // opening + booked(wk) + adjustments(wk) − paid(wk).
        closingBalance: round2(bookedToWeekEnd + adjToWeekEnd - (paidBefore + paidThisWeek)),
      });
      // Include a coach who received a payment this week even with no session.
      if ((paidThisWeekByCoach.get(cid) ?? 0) !== 0 && !coachMap.has(email)) {
        coachMap.set(email, { name: c.name || email, email: c.email || "", sessions: 0, hours: 0, amount: 0 });
      }
    }

    const coaches = Array.from(coachMap.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => {
        const fin = financeByEmail.get((c.email || "").toLowerCase().trim());
        return {
          ...c,
          hours: round2(c.hours),
          amount: round2(c.amount),
          openingBalance: fin?.openingBalance ?? 0,
          paymentsThisWeek: fin?.paymentsThisWeek ?? 0,
          closingBalance: fin?.closingBalance ?? 0,
        };
      });
    const dayList = days.map((d) => {
      const x = dayMap.get(d)!;
      return { ...x, cash: round2(x.cash), creditUsed: round2(x.creditUsed), discountGiven: round2(x.discountGiven) };
    });

    const byDateThenTime = (a: { date: string; startHour: number }, b: { date: string; startHour: number }) =>
      a.date.localeCompare(b.date) || a.startHour - b.startHour;

    return {
      weekStart,
      weekEnd,
      coaches,
      coachTotal: {
        sessions: coaches.reduce((s, c) => s + c.sessions, 0),
        hours: round2(coaches.reduce((s, c) => s + c.hours, 0)),
        amount: round2(coaches.reduce((s, c) => s + c.amount, 0)),
        openingBalance: round2(coaches.reduce((s, c) => s + c.openingBalance, 0)),
        paymentsThisWeek: round2(coaches.reduce((s, c) => s + c.paymentsThisWeek, 0)),
        closingBalance: round2(coaches.reduce((s, c) => s + c.closingBalance, 0)),
      },
      days: dayList,
      customerTotal: {
        sessions: dayList.reduce((s, d) => s + d.sessions, 0),
        cash: round2(dayList.reduce((s, d) => s + d.cash, 0)),
        creditUsed: round2(dayList.reduce((s, d) => s + d.creditUsed, 0)),
        discountGiven: round2(dayList.reduce((s, d) => s + d.discountGiven, 0)),
      },
      creditItems: creditItems.sort(byDateThenTime),
      discountItems: discountItems.sort(byDateThenTime),
    };
  },
});
