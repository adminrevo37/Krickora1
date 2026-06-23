// ============================================================================
// RETENTION — prune unbounded append-only tables (audit 2026-06: COST-4 / LEAK-3
// / LEAK-6 / SEC-3). No table had any pruning, so storage + read cost climbed
// forever. `analytics` (public, one row per pageview) is the fastest-growing.
//
// All deletes are BATCHED + INDEXED (take(BATCH) on an index range, then the
// mutation reschedules itself until the table is drained) — never an unbounded
// .collect(). Driven by two crons (see crons.ts): a daily sweep + an hourly
// rate-limit sweep. revenueSnapshots and the audit logs are kept forever.
// ============================================================================
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { awstDateKey } from "./lib/analyticsHelpers";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

// Retention windows. ⚠️ Pruning `analytics` past 90d makes any analytics-derived
// "new vs returning visitor" metric (COST-5) window-bounded to 90d. The facility
// is only weeks old so this deletes nothing yet; persist a first-seen rollup
// before 90d elapses if that metric must stay all-time.
const ANALYTICS_RETENTION_DAYS = 90;
const EVENT_RETENTION_DAYS = 180;
const RATELIMIT_STALE_HOURS = 2; // 2× the longest limiter window (1h)

// Event/log tables pruned on the EVENT_RETENTION window — all keyed on numeric
// `at` via a `by_at` index.
const EVENT_TABLES = [
  "pushEvents",
  "emailEvents",
  "entryEvents",
  "coachLinkEvents",
  "waitlistOfferEvents",
  "bookingEvents",
] as const;

/**
 * Generic batched, INDEXED prune of rows older than `cutoff` on ONE table.
 * Deletes up to BATCH rows in index (ascending = oldest-first) order, then
 * reschedules itself until the table is drained. `cutoff` is a number (ms) for
 * time-keyed tables or a "YYYY-MM-DD" string for date-string tables
 * (lexicographic == chronological). table/index/field are only ever supplied by
 * the drivers below, so the (table,index,field) combos are always valid.
 */
export const pruneByTime = internalMutation({
  args: {
    table: v.string(),
    index: v.string(),
    field: v.string(),
    cutoff: v.union(v.number(), v.string()),
  },
  handler: async (ctx, { table, index, field, cutoff }) => {
    const rows = await (ctx.db as any)
      .query(table)
      .withIndex(index, (q: any) => q.lt(field, cutoff))
      .take(BATCH);
    for (const r of rows) await ctx.db.delete(r._id);
    if (rows.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.retention.pruneByTime, {
        table,
        index,
        field,
        cutoff,
      });
    }
    return rows.length;
  },
});

/**
 * COST-4 / LEAK-3 / LEAK-6 — daily retention sweep. Schedules an indexed prune
 * for each unbounded table.
 */
export const runDailyRetention = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const today = awstDateKey(now);

    // Stagger each table's prune chain so the first post-backlog sweep doesn't
    // fan out 8 concurrent delete chains competing with live writes. Each chain
    // still self-reschedules internally to drain its own table.
    const STAGGER_MS = 5000;
    let i = 0;
    const schedule = (
      table: string,
      index: string,
      field: string,
      cutoff: number | string
    ) =>
      ctx.scheduler.runAfter(i++ * STAGGER_MS, internal.retention.pruneByTime, {
        table,
        index,
        field,
        cutoff,
      });

    // analytics (90d) — field `timestamp`, index `by_timestamp`.
    await schedule("analytics", "by_timestamp", "timestamp", now - ANALYTICS_RETENTION_DAYS * DAY_MS);

    // Event/log tables (180d) — field `at`, index `by_at`.
    const eventCutoff = now - EVENT_RETENTION_DAYS * DAY_MS;
    for (const table of EVENT_TABLES) {
      await schedule(table, "by_at", "at", eventCutoff);
    }

    // laneOverrides — fully-past overrides (endDate < today; date-string compare).
    await schedule("laneOverrides", "by_endDate", "endDate", today);
  },
});

/**
 * SEC-3 — hourly prune of stale rate-limit buckets (windowStart older than 2× the
 * longest limiter window). Bounds the table under rotating-key abuse.
 */
export const runHourlyRetention = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.retention.pruneByTime, {
      table: "rateLimits",
      index: "by_window",
      field: "windowStart",
      cutoff: Date.now() - RATELIMIT_STALE_HOURS * 60 * 60 * 1000,
    });
  },
});
