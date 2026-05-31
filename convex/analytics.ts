import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";

// ============================================================================
// TRACK EVENT — public mutation for client-side tracker
// ============================================================================
export const trackEvent = mutation({
  args: {
    type: v.string(),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    referrer: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    userId: v.optional(v.string()),
    metadata: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("analytics", {
      type: args.type,
      name: args.name,
      url: args.url,
      referrer: args.referrer,
      sessionId: args.sessionId,
      userId: args.userId,
      metadata: args.metadata,
      userAgent: args.userAgent,
      timestamp: args.timestamp,
    });
  },
});

// ============================================================================
// ADMIN QUERIES
// ============================================================================

// Get recent events (last N) — admin only.
export const getRecentEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return [];
    const limit = args.limit ?? 100;
    return await ctx.db
      .query("analytics")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit);
  },
});

// Get pageviews in a date range
export const getPageviews = query({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return [];
    const events = await ctx.db
      .query("analytics")
      .withIndex("by_type_timestamp", (q: any) =>
        q.eq("type", "pageview").gte("timestamp", args.startTimestamp)
      )
      .collect();
    return events.filter((e) => e.timestamp <= args.endTimestamp);
  },
});

// Get event counts by type for a date range
export const getEventSummary = query({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return { total: 0, breakdown: {}, uniqueSessions: 0 };
    const events = await ctx.db
      .query("analytics")
      .withIndex("by_timestamp")
      .collect();

    const filtered = events.filter(
      (e) => e.timestamp >= args.startTimestamp && e.timestamp <= args.endTimestamp
    );

    const summary: Record<string, number> = {};
    for (const e of filtered) {
      const key = e.type === "event" ? `event:${e.name ?? "unknown"}` : e.type;
      summary[key] = (summary[key] ?? 0) + 1;
    }

    return {
      total: filtered.length,
      breakdown: summary,
      uniqueSessions: new Set(filtered.map((e) => e.sessionId).filter(Boolean)).size,
    };
  },
});

// ============================================================================
// BOOKING-METRICS DASHBOARD (SPEC_ADMIN_AND_SETTINGS #6)
// Built entirely from booking/payment data — replaces the broken pageview-based
// analytics. Returns the exact shape AdminAnalyticsDashboard renders. Admin only.
// No-show rate is intentionally omitted (depends on the HA attendance feed).
// ============================================================================

const LANE_NAMES: Record<string, string> = {
  bm1: "Bowling Machine 1",
  bm2: "Bowling Machine 2",
  bm3: "Bowling Machine 3",
  ru1: "9m Run Up 1",
  ru2: "9m Run Up 2",
};
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourLabel(h: number): string {
  const whole = Math.floor(h);
  const period = whole >= 12 ? "pm" : "am";
  const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
  return `${display}${period}`;
}

export const getAdminAnalytics = query({
  args: { months: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return null;

    const months = args.months ?? 12;
    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth(); // 0-based

    // Cutoff = first day of the (months-1) months before the current month.
    const cutoff = new Date(curY, curM - (months - 1), 1);
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-01`;

    const allBookings = await ctx.db.query("bookings").collect();

    // Earliest booking date per customer email (across ALL time) → "new" detection.
    const firstBookingByEmail = new Map<string, string>();
    for (const b of allBookings) {
      if (b.isCoachBooking) continue;
      const email = (b.customerEmail ?? "").toLowerCase();
      if (!email) continue;
      const prev = firstBookingByEmail.get(email);
      if (!prev || b.date < prev) firstBookingByEmail.set(email, b.date);
    }

    const inPeriod = allBookings.filter((b) => b.date >= cutoffKey && b.status !== "tentative");

    // Month buckets (oldest → newest).
    const monthKeys: string[] = [];
    const byMonthMap = new Map<string, { label: string; revenue: number; coachCharges: number; bookings: number }>();
    const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(curY, curM - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthKeys.push(key);
      byMonthMap.set(key, { label: MONTH_ABBR[d.getMonth()], revenue: 0, coachCharges: 0, bookings: 0 });
    }

    const curMonthKey = `${curY}-${String(curM + 1).padStart(2, "0")}`;
    const prevDate = new Date(curY, curM - 1, 1);
    const prevMonthKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

    let periodRevenue = 0;
    let periodCoachCharges = 0;
    let periodHours = 0;
    let customerBookingsCount = 0;
    let coachBookingsCount = 0;
    let confirmedCount = 0;
    let cancelledCount = 0;
    let currentMonthRevenue = 0;
    let prevMonthRevenue = 0;
    let currentMonthBookings = 0;
    let prevMonthBookings = 0;

    const laneMap = new Map<string, { name: string; bookings: number; hours: number }>();
    const hourMap = new Map<number, number>();
    const dowAgg = DOW_LABELS.map((day) => ({ day, bookings: 0, hours: 0 }));
    const custAgg = new Map<string, { email: string; name: string; bookings: number; hours: number }>();

    for (const b of inPeriod) {
      const monthKey = b.date.slice(0, 7);
      const hours = (b.duration ?? 0) / 60;
      const revenue = b.priceInCents != null ? b.priceInCents / 100 : 0;
      const coachCharge = b.isCoachBooking ? (b.coachPrice ?? 0) : 0;

      if (b.status === "cancelled") {
        cancelledCount++;
        continue; // cancelled bookings don't count toward revenue/utilisation
      }
      confirmedCount++;

      periodHours += hours;
      const mBucket = byMonthMap.get(monthKey);

      if (b.isCoachBooking) {
        coachBookingsCount++;
        periodCoachCharges += coachCharge;
        if (mBucket) mBucket.coachCharges += coachCharge;
      } else {
        customerBookingsCount++;
        periodRevenue += revenue;
        if (mBucket) mBucket.revenue += revenue;
        const email = (b.customerEmail ?? "").toLowerCase();
        if (email) {
          const c = custAgg.get(email) ?? { email, name: b.customerName ?? email, bookings: 0, hours: 0 };
          c.bookings++;
          c.hours += hours;
          custAgg.set(email, c);
        }
      }

      if (mBucket) mBucket.bookings++;

      if (monthKey === curMonthKey) {
        currentMonthBookings++;
        currentMonthRevenue += b.isCoachBooking ? coachCharge : revenue;
      } else if (monthKey === prevMonthKey) {
        prevMonthBookings++;
        prevMonthRevenue += b.isCoachBooking ? coachCharge : revenue;
      }

      // Lane utilisation (primary lane).
      const lane = laneMap.get(b.laneId) ?? { name: LANE_NAMES[b.laneId] ?? b.laneId, bookings: 0, hours: 0 };
      lane.bookings++;
      lane.hours += hours;
      laneMap.set(b.laneId, lane);

      // Peak times (whole-hour bucket).
      const hourBucket = Math.floor(b.startHour ?? 0);
      hourMap.set(hourBucket, (hourMap.get(hourBucket) ?? 0) + 1);

      // Day of week.
      const [yy, mm, dd] = b.date.split("-").map(Number);
      const dow = new Date(yy, mm - 1, dd).getDay();
      dowAgg[dow].bookings++;
      dowAgg[dow].hours += hours;
    }

    // Customer return / new metrics (period customers).
    const totalUniqueCustomers = custAgg.size;
    let returningCustomers = 0;
    let newCustomers = 0;
    for (const [email, c] of custAgg) {
      if (c.bookings >= 2) returningCustomers++;
      const first = firstBookingByEmail.get(email);
      if (first && first >= cutoffKey) newCustomers++;
    }

    const totalForRate = confirmedCount + cancelledCount;
    const cancellationRate = totalForRate > 0 ? Math.round((cancelledCount / totalForRate) * 100) : 0;
    const avgRevenuePerBooking = customerBookingsCount > 0 ? periodRevenue / customerBookingsCount : 0;

    const byMonth = monthKeys.map((k) => byMonthMap.get(k)!);
    const lanes = Array.from(laneMap.values()).sort((a, b) => b.bookings - a.bookings)
      .map((l) => ({ ...l, hours: Math.round(l.hours * 10) / 10 }));
    const timeSlots = Array.from(hourMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([h, bookings]) => ({ label: hourLabel(h), bookings }));
    const byDayOfWeek = dowAgg.map((d) => ({ ...d, hours: Math.round(d.hours * 10) / 10 }));
    const topCustomers = Array.from(custAgg.values())
      .sort((a, b) => b.bookings - a.bookings)
      .slice(0, 10)
      .map((c) => ({ ...c, hours: Math.round(c.hours * 10) / 10 }));

    return {
      kpis: {
        periodRevenue: Math.round(periodRevenue * 100) / 100,
        avgRevenuePerBooking,
        periodHours: Math.round(periodHours * 10) / 10,
        periodCoachCharges: Math.round(periodCoachCharges * 100) / 100,
        customerBookingsCount,
        coachBookingsCount,
        currentMonthRevenue: Math.round(currentMonthRevenue * 100) / 100,
        prevMonthRevenue: Math.round(prevMonthRevenue * 100) / 100,
        currentMonthBookings,
        prevMonthBookings,
        cancellationRate,
        totalUniqueCustomers,
        returningCustomers,
        newCustomers,
      },
      byMonth,
      lanes,
      timeSlots,
      byDayOfWeek,
      topCustomers,
    };
  },
});
