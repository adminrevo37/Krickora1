import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";
import { defaultLaneName } from "./lib/lanes";
import { awstDateKey, isoWeekKey, monthKey, dayLabel } from "./lib/analyticsHelpers";

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
    // LOW (SEC audit 2026-06-03): never trust the client-supplied `userId` — a
    // forged value would mis-attribute analytics. Derive it from the
    // authenticated identity (undefined for anonymous visitors). Cap free-text
    // fields so this public, unauthenticated insert can't be used to write
    // oversized rows. (`args.userId` is still accepted for arg-shape compat but
    // ignored.)
    const identity = await ctx.auth.getUserIdentity();
    const cap = (s: string | undefined, n: number) =>
      s == null ? undefined : s.slice(0, n);
    return await ctx.db.insert("analytics", {
      type: args.type.slice(0, 64),
      name: cap(args.name, 128),
      url: cap(args.url, 1024),
      referrer: cap(args.referrer, 1024),
      sessionId: cap(args.sessionId, 128),
      userId: identity?.subject ?? undefined,
      // Server-derived actor email (authed visitors only) so the admin activity
      // feed can attribute page views to a customer. Never client-supplied.
      email: identity?.email ? String(identity.email).toLowerCase().slice(0, 256) : undefined,
      metadata: cap(args.metadata, 4096),
      userAgent: cap(args.userAgent, 512),
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

// SPEC_RECONFIGURABLE_LANES: lane utilisation is aggregated per physical bay, so
// the default display name ("BM 1".."RU 5") is the right label here.
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourLabel(h: number): string {
  const whole = Math.floor(h);
  const period = whole >= 12 ? "pm" : "am";
  const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
  return `${display}${period}`;
}

export const getAdminAnalytics = query({
  // `from`/`to` (YYYY-MM-DD, inclusive) drive an explicit window; when absent we
  // fall back to the legacy trailing-`months` window (unchanged behaviour).
  args: {
    months: v.optional(v.number()),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return null;

    const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth(); // 0-based

    const months = args.months ?? 12;
    const explicit = !!(args.from && args.to);

    // ── Window bounds (cutoffKey..toKey inclusive) ───────────────────────────
    // Explicit from/to window, else legacy trailing-N-months cutoff (to = today).
    let cutoffKey: string;
    let toKey: string;
    if (explicit) {
      cutoffKey = args.from!;
      toKey = args.to!;
    } else {
      const cutoff = new Date(curY, curM - (months - 1), 1);
      cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-01`;
      toKey = awstDateKey(now.getTime());
    }

    // UTC midnight ms for a YYYY-MM-DD (month arg is 0-based for Date.UTC).
    const keyToUtcMs = (k: string) => {
      const [y, m, d] = k.split("-").map(Number);
      return Date.UTC(y, (m || 1) - 1, d || 1);
    };
    const utcMsToKey = (ms: number) => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };

    // Time-series bucket granularity: by DAY for short spans, ISO-WEEK for
    // medium, MONTH for long (or always month on the legacy path).
    const spanDays = explicit
      ? Math.round((keyToUtcMs(toKey) - keyToUtcMs(cutoffKey)) / 86400000) + 1
      : 0;
    const gran: "day" | "week" | "month" = !explicit
      ? "month"
      : spanDays <= 31
        ? "day"
        : spanDays <= 120
          ? "week"
          : "month";

    // Bucket helpers — map an AWST date-string to its bucket key + label.
    const bucketOf = (date: string): { key: string; label: string } => {
      if (gran === "day") return { key: date, label: dayLabel(date) };
      if (gran === "week") {
        const w = isoWeekKey(date);
        return { key: w.key, label: w.label };
      }
      const m = monthKey(date);
      return { key: m.key, label: explicit ? m.label : MONTH_ABBR[Number(date.slice(5, 7)) - 1] };
    };

    // Read only the window for the period aggregates (efficiency); the all-time
    // first-booking pass below still needs everything. The legacy months path
    // keeps its original behaviour (no upper bound — future-dated bookings still
    // count); the explicit window is bounded both sides via the by_date index.
    const inPeriod = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) =>
        explicit ? q.gte("date", cutoffKey).lte("date", toKey) : q.gte("date", cutoffKey),
      )
      .collect();

    // Earliest booking date per customer email (across ALL time) → "new" detection.
    const allBookings = await ctx.db.query("bookings").collect();
    const firstBookingByEmail = new Map<string, string>();
    for (const b of allBookings) {
      if (b.isCoachBooking) continue;
      const email = (b.customerEmail ?? "").toLowerCase();
      if (!email) continue;
      const prev = firstBookingByEmail.get(email);
      if (!prev || b.date < prev) firstBookingByEmail.set(email, b.date);
    }

    // Ordered time-series buckets (oldest → newest), pre-seeded so empty
    // buckets still render a zero column on the chart.
    const bucketKeys: string[] = [];
    const byMonthMap = new Map<string, { label: string; revenue: number; coachCharges: number; bookings: number }>();
    const seedBucket = (date: string) => {
      const { key, label } = bucketOf(date);
      if (!byMonthMap.has(key)) {
        bucketKeys.push(key);
        byMonthMap.set(key, { label, revenue: 0, coachCharges: 0, bookings: 0 });
      }
    };
    if (!explicit) {
      // Legacy: exactly N month columns, including empty months.
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date(curY, curM - i, 1);
        seedBucket(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
      }
    } else {
      // Explicit: walk every day in the window so day/week/month columns are
      // contiguous even where no booking lands in a bucket.
      let cur = keyToUtcMs(cutoffKey);
      const end = keyToUtcMs(toKey);
      while (cur <= end) {
        seedBucket(utcMsToKey(cur));
        cur += 86400000;
      }
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
    const hourMapWeekday = new Map<number, number>();
    const hourMapWeekend = new Map<number, number>();
    const dowAgg = DOW_LABELS.map((day) => ({ day, bookings: 0, hours: 0 }));
    const custAgg = new Map<string, { email: string; name: string; bookings: number; hours: number }>();

    for (const b of inPeriod) {
      const bucketKey = bucketOf(b.date).key;
      const calMonthKey = b.date.slice(0, 7); // calendar month, for MoM KPIs
      const hours = (b.duration ?? 0) / 60;
      const revenue = b.priceInCents != null ? b.priceInCents / 100 : 0;
      const coachCharge = b.isCoachBooking ? (b.coachPrice ?? 0) : 0;

      if (b.status === "cancelled") {
        cancelledCount++;
        // C-3: a coach late-cancel is still charged in full and kept on the coach
        // statement — so it must count toward coach revenue in management reports too
        // (previously the blanket cancelled-skip hid it). coachCharge = coachPrice here.
        if (b.coachLateCancelCharged) {
          const mBucket = byMonthMap.get(bucketKey);
          periodCoachCharges += coachCharge;
          if (mBucket) mBucket.coachCharges += coachCharge;
          if (calMonthKey === curMonthKey) currentMonthRevenue += coachCharge;
          else if (calMonthKey === prevMonthKey) prevMonthRevenue += coachCharge;
        }
        continue; // other cancelled bookings don't count toward revenue/utilisation
      }
      confirmedCount++;

      periodHours += hours;
      const mBucket = byMonthMap.get(bucketKey);

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

      if (calMonthKey === curMonthKey) {
        currentMonthBookings++;
        currentMonthRevenue += b.isCoachBooking ? coachCharge : revenue;
      } else if (calMonthKey === prevMonthKey) {
        prevMonthBookings++;
        prevMonthRevenue += b.isCoachBooking ? coachCharge : revenue;
      }

      // Lane utilisation (primary lane).
      const lane = laneMap.get(b.laneId) ?? { name: defaultLaneName(b.laneId), bookings: 0, hours: 0 };
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

      // Peak times split weekday vs weekend (SPEC_ANALYTICS_BUILD addendum).
      const wkMap = dow === 0 || dow === 6 ? hourMapWeekend : hourMapWeekday;
      wkMap.set(hourBucket, (wkMap.get(hourBucket) ?? 0) + 1);
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

    const byMonth = bucketKeys.map((k) => byMonthMap.get(k)!);
    const lanes = Array.from(laneMap.values()).sort((a, b) => b.bookings - a.bookings)
      .map((l) => ({ ...l, hours: Math.round(l.hours * 10) / 10 }));
    const slotsFrom = (m: Map<number, number>) =>
      Array.from(m.entries()).sort((a, b) => a[0] - b[0]).map(([h, bookings]) => ({ label: hourLabel(h), bookings }));
    const timeSlots = slotsFrom(hourMap);
    const timeSlotsWeekday = slotsFrom(hourMapWeekday);
    const timeSlotsWeekend = slotsFrom(hourMapWeekend);
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
      timeSlotsWeekday,
      timeSlotsWeekend,
      byDayOfWeek,
      topCustomers,
    };
  },
});

// ============================================================================
// CATCHMENT REPORT — SPEC_PROFILE_POSTCODE_SUBURB Addendum A
// Session COUNT per suburb/postcode (NOT revenue). Counts confirmed, non-coach
// bookings (customer + admin-manual), one count per booking (mates ignored),
// excluding cancelled. Uses the per-booking SNAPSHOT (bookingSuburb/bookingPostcode)
// so a customer moving doesn't rewrite history. Optional inclusive date range.
// ============================================================================
export const getCatchmentReport = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) }, // YYYY-MM-DD inclusive
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return null;

    const from = args.from?.trim() || undefined;
    const to = args.to?.trim() || undefined;
    // COST-7 (audit 2026-06): when a window is supplied, read it via the by_date index
    // instead of scanning the whole bookings table then JS-filtering. The unbounded
    // default (no from/to — the OverviewTab all-time load) still needs a full collect.
    const all =
      from || to
        ? await ctx.db
            .query("bookings")
            .withIndex("by_date", (q: any) => {
              let r = q;
              if (from) r = r.gte("date", from);
              if (to) r = r.lte("date", to);
              return r;
            })
            .collect()
        : await ctx.db.query("bookings").collect();

    // bookings = session count; customers = DISTINCT account (by email) per suburb,
    // i.e. unique-user bookings — so 10 sessions from one family count as 1 customer.
    const agg = new Map<string, { suburb: string; postcode: string; bookings: number; emails: Set<string> }>();
    const allEmails = new Set<string>();
    let unknown = 0; // confirmed non-coach booking with no snapshot (backfill gap)
    let total = 0;
    for (const b of all) {
      if ((b as any).isCoachBooking) continue;     // A2: coach own-bookings excluded
      if (b.status !== "confirmed") continue;        // A4: cancelled/pending excluded
      if (from && b.date < from) continue;
      if (to && b.date > to) continue;
      total++;
      const email = ((b as any).customerEmail || "").toLowerCase().trim();
      if (email) allEmails.add(email);
      const suburb = ((b as any).bookingSuburb || "").trim();
      const postcode = ((b as any).bookingPostcode || "").trim();
      if (!suburb) { unknown++; continue; }
      const key = `${suburb}|${postcode}`;
      const row = agg.get(key) ?? { suburb, postcode, bookings: 0, emails: new Set<string>() };
      row.bookings++;
      if (email) row.emails.add(email);
      agg.set(key, row);
    }
    const bySuburb = Array.from(agg.values())
      .map((r) => ({ suburb: r.suburb, postcode: r.postcode, bookings: r.bookings, customers: r.emails.size }))
      .sort((a, b) => b.customers - a.customers || b.bookings - a.bookings || a.suburb.localeCompare(b.suburb));
    return {
      bySuburb,
      unknown,
      total,
      uniqueCustomers: allEmails.size,
      from: from ?? null,
      to: to ?? null,
    };
  },
});

// ============================================================================
// CUSTOMER SUBURB MAP — distribution of EVERY customer account by the suburb on
// their PROFILE, straight from the customers table. Unlike getCatchmentReport
// (which counts booking USAGE), this is the registration footprint: it counts
// accounts whether or not they have ever booked, with no date window. Staff
// (coach/admin) and merged/deactivated tombstones are excluded. Admin only.
// ============================================================================
export const getCustomerSuburbMap = query({
  args: {},
  handler: async (ctx) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return null;

    const customers = await ctx.db.query("customers").collect();
    const agg = new Map<string, { suburb: string; postcode: string; customers: number }>();
    let unknown = 0;        // a customer account with no suburb on file
    let totalCustomers = 0; // all non-staff, non-tombstone accounts
    let placed = 0;         // accounts that have a suburb (i.e. plottable)
    for (const c of customers) {
      const role = (c as any).role;
      if (role === "coach" || role === "admin") continue;            // staff excluded
      if ((c as any).deactivatedAt || (c as any).mergedIntoCustomerId) continue; // merged/retired
      totalCustomers++;
      const suburb = ((c as any).suburb || "").trim();
      const postcode = ((c as any).postcode || "").trim();
      if (!suburb) { unknown++; continue; }
      const key = `${suburb.toUpperCase()}|${postcode}`;
      const row = agg.get(key) ?? { suburb, postcode, customers: 0 };
      row.customers++;
      agg.set(key, row);
      placed++;
    }
    const bySuburb = Array.from(agg.values()).sort(
      (a, b) => b.customers - a.customers || a.suburb.localeCompare(b.suburb)
    );
    return { bySuburb, unknown, totalCustomers, placed };
  },
});

// SPEC_ANALYTICS_ATHLETE_CATCHMENT — a SECOND catchment table shown beside the
// customer one above. Tallies ATHLETES allocated to coach bookings by THEIR home
// suburb (= their parent/account holder's postcode/suburb), read from the snapshot
// written on each athlete slot at allocation time. Reads ONLY coach bookings'
// slots; the customer report (above) excludes coach bookings → the two never
// double-count the same row. The coach's own suburb is never read (R3). Same shape
// as getCatchmentReport so the frontend table component is reusable.
export const getAthleteCatchmentReport = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) }, // YYYY-MM-DD inclusive
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return null;

    const from = args.from?.trim() || undefined;
    const to = args.to?.trim() || undefined;
    // COST-7 (audit 2026-06): indexed window read when from/to supplied (see
    // getCatchmentReport); unbounded default still does a full collect.
    const all =
      from || to
        ? await ctx.db
            .query("bookings")
            .withIndex("by_date", (q: any) => {
              let r = q;
              if (from) r = r.gte("date", from);
              if (to) r = r.lte("date", to);
              return r;
            })
            .collect()
        : await ctx.db.query("bookings").collect();

    const agg = new Map<string, { suburb: string; postcode: string; bookings: number }>();
    let unknown = 0; // slot with no resolvable suburb (legacy / deleted athlete / no postcode yet)
    let total = 0;
    for (const b of all) {
      if (!(b as any).isCoachBooking) continue;      // coach bookings only
      if (b.status !== "confirmed") continue;        // exclude cancelled/pending (Q2)
      if (from && b.date < from) continue;
      if (to && b.date > to) continue;
      const slots = (b as any).athleteSlots as any[] | undefined;
      if (!slots || slots.length === 0) continue;
      // Q3: count one per DISTINCT athlete per booking. Dedupe slots sharing an
      // athleteId within this booking; siblings (different ids) count separately.
      // Legacy slots with no athleteId can't be deduped → each counts (as Unknown).
      const seen = new Set<string>();
      for (const s of slots) {
        if (s.athleteId) {
          const k = String(s.athleteId);
          if (seen.has(k)) continue;
          seen.add(k);
        }
        total++;
        const suburb = ((s.athleteSuburb as string) || "").trim();
        const postcode = ((s.athletePostcode as string) || "").trim();
        if (!suburb) { unknown++; continue; }
        const key = `${suburb}|${postcode}`;
        const row = agg.get(key) ?? { suburb, postcode, bookings: 0 };
        row.bookings++;
        agg.set(key, row);
      }
    }
    const bySuburb = Array.from(agg.values()).sort(
      (a, b) => b.bookings - a.bookings || a.suburb.localeCompare(b.suburb)
    );
    return { bySuburb, unknown, total, from: from ?? null, to: to ?? null };
  },
});
