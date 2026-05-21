import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Lane display names (keep in sync with src/lib/booking-data.ts)
const LANE_NAMES: Record<string, string> = {
  bm1: "Bowling Machine 1",
  bm2: "Bowling Machine 2",
  bm3: "Bowling Machine 3",
  ru1: "9m Run Up 1",
  ru2: "9m Run Up 2",
};

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

// Get recent events (last N)
export const getRecentEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
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
    // Use index to skip records older than startTimestamp instead of a full scan
    const events = await ctx.db
      .query("analytics")
      .withIndex("by_timestamp", (q: any) => q.gte("timestamp", args.startTimestamp))
      .collect();

    const filtered = events.filter((e) => e.timestamp <= args.endTimestamp);

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
// ADMIN ANALYTICS DASHBOARD — aggregated metrics for the analytics tab
// ============================================================================
export const getAdminAnalytics = query({
  args: {
    months: v.optional(v.number()), // 3, 6, or 12 — defaults to 12
  },
  handler: async (ctx, args) => {
    const monthsBack = args.months ?? 12;
    const pad = (n: number) => String(n).padStart(2, "0");

    // Helper: YYYY-MM string for a given offset from today's month
    const now = new Date();
    const monthKey = (offsetFromNow: number): string => {
      const d = new Date(now.getFullYear(), now.getMonth() + offsetFromNow, 1);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    };
    const monthLabel = (key: string): string => {
      const [y, m] = key.split("-").map(Number);
      return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
    };

    // Cutoff: first day of the earliest month in the window
    const cutoffKey = monthKey(-monthsBack + 1);
    const cutoffDate = `${cutoffKey}-01`;

    // ── Build month-keyed result map (oldest → newest) ─────────────────────
    const monthMap = new Map<
      string,
      { label: string; revenue: number; bookings: number; cancelled: number }
    >();
    for (let i = monthsBack - 1; i >= 0; i--) {
      const key = monthKey(-i);
      monthMap.set(key, { label: monthLabel(key), revenue: 0, bookings: 0, cancelled: 0 });
    }

    // ── Revenue from stripePayments (amounts stored in dollars) ────────────
    const allPayments = await ctx.db.query("stripePayments").collect();
    for (const p of allPayments) {
      const dateStr = p.date ?? "";
      if (dateStr < cutoffDate) continue;
      const status = (p.status ?? "").toLowerCase();
      if (status === "refunded" || status === "failed" || status === "canceled" || status === "cancelled") continue;
      const key = dateStr.slice(0, 7); // YYYY-MM
      const entry = monthMap.get(key);
      if (entry) entry.revenue += p.amount ?? 0;
    }

    // ── Bookings data ──────────────────────────────────────────────────────
    // Use by_date index range: collect from cutoffDate onward
    const allBookingsInRange = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.gte("date", cutoffDate))
      .collect();

    // Booking counts by month
    for (const b of allBookingsInRange) {
      const key = (b.date ?? "").slice(0, 7);
      const entry = monthMap.get(key);
      if (!entry) continue;
      if (b.status === "cancelled") entry.cancelled++;
      else entry.bookings++;
    }

    const byMonth = Array.from(monthMap.values());

    // ── Current vs previous month KPIs ─────────────────────────────────────
    const thisMonthKey = monthKey(0);
    const prevMonthKey = monthKey(-1);
    const thisM = monthMap.get(thisMonthKey) ?? { revenue: 0, bookings: 0, cancelled: 0 };
    const prevM = monthMap.get(prevMonthKey) ?? { revenue: 0, bookings: 0, cancelled: 0 };

    // Overall cancellation rate for the window
    let totalConfirmed = 0;
    let totalCancelled = 0;
    for (const entry of monthMap.values()) {
      totalConfirmed += entry.bookings;
      totalCancelled += entry.cancelled;
    }
    const cancellationRate =
      totalConfirmed + totalCancelled > 0
        ? Math.round((totalCancelled / (totalConfirmed + totalCancelled)) * 100)
        : 0;

    // ── Lane popularity ────────────────────────────────────────────────────
    const laneMap = new Map<string, { name: string; bookings: number; hours: number }>();
    const confirmedBookings = allBookingsInRange.filter((b) => b.status !== "cancelled");

    for (const b of confirmedBookings) {
      const laneId = b.laneId;
      const name = LANE_NAMES[laneId] ?? laneId;
      if (!laneMap.has(laneId)) laneMap.set(laneId, { name, bookings: 0, hours: 0 });
      const e = laneMap.get(laneId)!;
      e.bookings++;
      e.hours = Math.round((e.hours + b.duration / 60) * 10) / 10;

      // Also count additional lanes (multi-lane bookings)
      const extras = (b as any).additionalLaneIds ?? [];
      for (const lid of extras) {
        const lname = LANE_NAMES[lid] ?? lid;
        if (!laneMap.has(lid)) laneMap.set(lid, { name: lname, bookings: 0, hours: 0 });
        const le = laneMap.get(lid)!;
        le.bookings++;
        le.hours = Math.round((le.hours + b.duration / 60) * 10) / 10;
      }
    }

    const lanes = Array.from(laneMap.values()).sort((a, b) => b.bookings - a.bookings);

    // ── Peak hours ─────────────────────────────────────────────────────────
    const hourMap = new Map<number, number>();
    for (const b of confirmedBookings) {
      const h = Math.floor(b.startHour);
      hourMap.set(h, (hourMap.get(h) ?? 0) + 1);
    }

    const timeSlots = Array.from(hourMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([hour, bookings]) => ({
        hour,
        label:
          hour === 0
            ? "12am"
            : hour < 12
            ? `${hour}am`
            : hour === 12
            ? "12pm"
            : `${hour - 12}pm`,
        bookings,
      }));

    // ── Customer segments (unique emails in this window) ───────────────────
    const emailCount = new Map<string, number>();
    for (const b of confirmedBookings) {
      const email = (b.customerEmail ?? "").toLowerCase().trim();
      if (email) emailCount.set(email, (emailCount.get(email) ?? 0) + 1);
    }
    const totalUniqueCustomers = emailCount.size;
    const newCustomers = Array.from(emailCount.values()).filter((c) => c === 1).length;
    const returningCustomers = Array.from(emailCount.values()).filter((c) => c > 1).length;

    return {
      kpis: {
        currentMonthRevenue: thisM.revenue,
        prevMonthRevenue: prevM.revenue,
        currentMonthBookings: thisM.bookings,
        prevMonthBookings: prevM.bookings,
        cancellationRate,
        totalUniqueCustomers,
        newCustomers,
        returningCustomers,
      },
      byMonth,
      lanes,
      timeSlots,
    };
  },
});
