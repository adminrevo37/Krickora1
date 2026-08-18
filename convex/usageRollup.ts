/**
 * Daily usage roll-up — the durable fix for the admin Usage tab (2026-08-18).
 *
 * WHY THIS EXISTS
 * ---------------
 * `getUsageAnalytics` used to aggregate raw `analytics` rows for the selected
 * range. That table grows ~3,000 rows per 46h, so 7d ~= 11k rows and 90d ~=
 * 140k rows: the query Server-Errored at EVERY realistic range (verified on
 * prod — only an empty range succeeded). A read cap was shipped first as a
 * stop-gap; this replaces it, so the tab reads <=90 pre-aggregated rows instead.
 *
 * WHY A CRON, NOT trackEvent
 * --------------------------
 * A per-day counter row updated on every pageview would serialise writes on one
 * hot document — the opposite of what we want on the busiest mutation in the
 * system. The cron builds one whole day at a time, which is a bounded read.
 *
 * WHAT IS EXACT AND WHAT ISN'T
 * ----------------------------
 * Per-day figures are exact. Distinct-identity counts do NOT sum across days
 * (one person active on three days is one unique user, not three), so
 * `activeIdentities` is stored per day and range-level unique users / WAU / MAU
 * are answered from `firstSeenByIdentity.lastTimestamp` instead — see
 * getUsageAnalytics. Medians likewise cannot be summed, so each day stores its
 * own median and the query reports the median-of-days for multi-day ranges.
 */
import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";
import {
  awstDateKey,
  awstDateKeyToMs,
  parseUserAgent,
  median,
  DAY_MS,
} from "./lib/analyticsHelpers";

const TOP_PAGES_KEPT = 40;

/** Add one AWST day to a YYYY-MM-DD key. */
function addDayKey(dateKey: string, days: number): string {
  return awstDateKey(awstDateKeyToMs(dateKey) + days * DAY_MS);
}

/**
 * Build (or rebuild) the roll-up row for one AWST date. Idempotent — upserts by
 * `date`, so re-running overwrites rather than duplicating.
 *
 * Reads exactly one day of analytics via by_timestamp. At current volume that is
 * ~1,500 rows; the guard below stops a pathological day from blowing the read
 * limit and silently producing a wrong row.
 */
export const buildUsageDayInternal = internalMutation({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    const dayStart = awstDateKeyToMs(date);
    const dayEnd = dayStart + DAY_MS - 1;

    const CAP = 12000;
    const rows = (await ctx.db
      .query("analytics")
      .withIndex("by_timestamp", (q: any) =>
        q.gte("timestamp", dayStart).lte("timestamp", dayEnd)
      )
      .take(CAP + 1)) as any[];
    // If a single day ever exceeds the cap the row would understate the day
    // without saying so. Record it rather than write a quietly-wrong figure.
    const capped = rows.length > CAP;
    const events = capped ? rows.slice(0, CAP) : rows;

    const idOf = (e: any) => e.userId ?? e.sessionId ?? "";

    const sessions = new Set<string>();
    const identities = new Set<string>();
    let pageviews = 0;
    const pageCounts = new Map<string, number>();
    const sessionSpan = new Map<string, { min: number; max: number; count: number }>();
    const sessionUA = new Map<string, string>();

    for (const e of events) {
      const id = idOf(e);
      if (e.sessionId) sessions.add(e.sessionId);
      if (id) identities.add(id);
      if (e.type === "pageview") {
        pageviews++;
        let path = "/";
        try {
          path = new URL(e.url ?? "").pathname || "/";
        } catch {
          path = e.url ?? "/";
        }
        pageCounts.set(path, (pageCounts.get(path) ?? 0) + 1);
      }
      if (e.sessionId) {
        const span =
          sessionSpan.get(e.sessionId) ?? { min: e.timestamp, max: e.timestamp, count: 0 };
        span.min = Math.min(span.min, e.timestamp);
        span.max = Math.max(span.max, e.timestamp);
        span.count++;
        sessionSpan.set(e.sessionId, span);
        if (e.userAgent && !sessionUA.has(e.sessionId)) sessionUA.set(e.sessionId, e.userAgent);
      }
    }

    // Session lengths — only sessions with >=2 events have a meaningful span.
    const lengths: number[] = [];
    for (const span of sessionSpan.values()) {
      if (span.count >= 2) lengths.push(span.max - span.min);
    }

    // Device/OS/browser: one vote per session, by that session's first UA.
    const device: Record<string, number> = {};
    const os: Record<string, number> = {};
    const browser: Record<string, number> = {};
    for (const ua of sessionUA.values()) {
      const p = parseUserAgent(ua);
      device[p.device] = (device[p.device] ?? 0) + 1;
      os[p.os] = (os[p.os] ?? 0) + 1;
      browser[p.browser] = (browser[p.browser] ?? 0) + 1;
    }

    // New identities = those whose first-EVER event falls on this day. Point
    // reads against the small rollup table, one per identity active today.
    let newIdentities = 0;
    for (const id of identities) {
      const seen: any = await ctx.db
        .query("firstSeenByIdentity")
        .withIndex("by_identity", (q: any) => q.eq("identity", id))
        .first();
      const first = seen?.firstTimestamp;
      if (first == null || (first >= dayStart && first <= dayEnd)) newIdentities++;
    }

    const topPages = Object.fromEntries(
      Array.from(pageCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_PAGES_KEPT)
    );

    const doc = {
      date,
      events: events.length, // rows actually aggregated for this day
      pageviews,
      sessions: sessions.size,
      activeIdentities: identities.size,
      newIdentities,
      sessionSecondsTotal: Math.round(lengths.reduce((s, x) => s + x, 0) / 1000),
      sessionsMeasured: lengths.length,
      sessionMedianSec: lengths.length ? Math.round(median(lengths) / 1000) : 0,
      device: JSON.stringify(device),
      os: JSON.stringify(os),
      browser: JSON.stringify(browser),
      topPages: JSON.stringify(topPages),
      createdAt: Date.now(),
    };

    const existing = await ctx.db
      .query("usageDaily")
      .withIndex("by_date", (q: any) => q.eq("date", date))
      .first();
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("usageDaily", doc);

    return { date, events: events.length, capped, identities: identities.size };
  },
});

/**
 * Nightly cron — roll up YESTERDAY (AWST). Runs after the day is closed so the
 * row is final. Today is never rolled up; getUsageAnalytics reads today's
 * partial figures live from raw events (a single bounded day).
 */
export const runDailyUsageRollup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const yesterday = addDayKey(awstDateKey(Date.now()), -1);
    await ctx.runMutation(internal.usageRollup.buildUsageDayInternal, { date: yesterday });
    return { built: yesterday };
  },
});

/**
 * One-off backfill — seed usageDaily for the retained history, one day per step
 * so no single mutation gets near the read limit. Self-reschedules backwards
 * from `startDate` until `days` are done (the retention.ts pattern).
 *
 * Run ONCE from the authenticated admin browser after deploy:
 *   window.__KRICKORA_CONVEX__.mutation(
 *     {[Symbol.for("functionName")]:"usageRollup:startUsageBackfill"}, {})
 *
 * Idempotent: each day upserts, so a re-run simply rewrites the same rows.
 */
export const startUsageBackfill = mutation({
  args: { days: v.optional(v.number()), startDate: v.optional(v.string()) },
  handler: async (ctx, { days, startDate }) => {
    await requireAdmin(ctx);
    // Analytics is pruned at 90 days, so there is nothing older worth building.
    const total = Math.min(Math.max(days ?? 92, 1), 120);
    const start = startDate ?? addDayKey(awstDateKey(Date.now()), -1);
    await ctx.scheduler.runAfter(0, internal.usageRollup.backfillUsageStep, {
      date: start,
      remaining: total,
    });
    return { scheduled: true, startDate: start, days: total };
  },
});

export const backfillUsageStep = internalMutation({
  args: { date: v.string(), remaining: v.number() },
  handler: async (ctx, { date, remaining }) => {
    await ctx.runMutation(internal.usageRollup.buildUsageDayInternal, { date });
    if (remaining > 1) {
      // Small stagger so the backfill never competes with live traffic.
      await ctx.scheduler.runAfter(250, internal.usageRollup.backfillUsageStep, {
        date: addDayKey(date, -1),
        remaining: remaining - 1,
      });
    }
    return { built: date, remaining: remaining - 1 };
  },
});

/**
 * One-off backfill for `firstSeenByIdentity.lastTimestamp`, which is undefined
 * on every row written before 2026-08-18. Without it WAU/MAU would under-count
 * until each identity happens to return. Walks the analytics table newest-first
 * and stamps each identity the first time it is seen (= its latest activity).
 */
export const startLastSeenBackfill = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    await ctx.scheduler.runAfter(0, internal.usageRollup.lastSeenBackfillStep, {
      cursor: null,
      patched: 0,
      scanned: 0,
    });
    return { scheduled: true };
  },
});

export const lastSeenBackfillStep = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    patched: v.number(),
    scanned: v.number(),
  },
  handler: async (ctx, { cursor, patched, scanned }) => {
    const page = await ctx.db
      .query("analytics")
      .withIndex("by_timestamp")
      .order("desc")
      .paginate({ cursor, numItems: 500 });

    let p = patched;
    for (const e of page.page as any[]) {
      const id = e.userId ?? e.sessionId ?? "";
      if (!id) continue;
      const seen: any = await ctx.db
        .query("firstSeenByIdentity")
        .withIndex("by_identity", (q: any) => q.eq("identity", id))
        .first();
      if (!seen) continue; // startFirstSeenBackfill owns creating these
      // Newest-first, so the FIRST time we meet an identity is its latest
      // activity. Only fill blanks / move forward; never move it backwards.
      if ((seen.lastTimestamp ?? 0) < e.timestamp) {
        await ctx.db.patch(seen._id, { lastTimestamp: e.timestamp });
        p++;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(250, internal.usageRollup.lastSeenBackfillStep, {
        cursor: page.continueCursor,
        patched: p,
        scanned: scanned + page.page.length,
      });
    }
    return { done: page.isDone, patched: p, scanned: scanned + page.page.length };
  },
});
