// SPEC_ANALYTICS_BUILD_2026-06 — usage, booking-flow funnel, push delivery/CTR,
// waitlist-offer response latency, and door-code access lead-time analytics.
// Admin-only. Reads the `analytics`, `pushEvents`, `waitlistOfferEvents`,
// `pushSubscriptions` and `customers` tables.

import { query } from "./_generated/server";
import { v } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";
import {
  awstDateKey,
  awstDateKeyToMs,
  awstParts,
  parseUserAgent,
  median,
  round2,
  safeParseJson,
  DAY_MS,
} from "./lib/analyticsHelpers";

async function isAdmin(ctx: any): Promise<boolean> {
  const caller = await getCallerContext(ctx);
  return caller.isAdmin;
}

// Resolve a {from,to} day-string range to ms bounds. Explicit fromMs/toMs (used by
// the sub-day 1h/4h presets) override the day-string conversion when provided.
function rangeMs(
  from?: string,
  to?: string,
  fromMs?: number,
  toMs?: number
): { fromMs: number; toMs: number } {
  return {
    fromMs: fromMs ?? (from ? Date.parse(from + "T00:00:00+08:00") : -Infinity),
    toMs: toMs ?? (to ? Date.parse(to + "T23:59:59+08:00") : Infinity),
  };
}

// ============================================================================
// WS-B — Active-user snapshot (last hour / today). Own ms windows (sub-day),
// independent of the day-level range. Indexed read (today's events only).
// ============================================================================
export const getActiveUserSnapshot = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isAdmin(ctx))) return null;
    const now = Date.now();
    const hourAgo = now - 3600_000;
    const todayStartMs = awstDateKeyToMs(awstDateKey(now));
    const events = await ctx.db
      .query("analytics")
      .withIndex("by_timestamp", (q: any) => q.gte("timestamp", Math.min(hourAgo, todayStartMs)))
      .collect();
    const idOf = (e: any) => e.userId ?? e.sessionId ?? "";
    const lastHour = new Set<string>();
    const today = new Set<string>();
    for (const e of events as any[]) {
      const id = idOf(e);
      if (!id) continue;
      if (e.timestamp >= hourAgo) lastHour.add(id);
      if (e.timestamp >= todayStartMs) today.add(id);
    }
    return { lastHour: lastHour.size, today: today.size };
  },
});

// ============================================================================
// C2.3 — APP USAGE (DAU/WAU/MAU, sessions, session length, pages, device split)
// ============================================================================
export const getUsageAnalytics = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()), fromMs: v.optional(v.number()), toMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to, args.fromMs, args.toMs);
    // ========================================================================
    // 2026-08-18 — reads the `usageDaily` ROLL-UP, not raw analytics.
    // ========================================================================
    // History: this query used to aggregate every raw `analytics` row in range.
    // That table grows ~3,000 rows per 46h, so it Server-Errored at EVERY
    // realistic range (verified on prod: 6h through 90d all failed; only an
    // empty range worked). A read cap was shipped as a stop-gap, which made the
    // tab usable but approximate. This replaces it: <=92 pre-aggregated rows
    // instead of up to ~140,000 raw ones.
    //
    // Only TODAY is computed live, because the nightly cron rolls up yesterday
    // and today is still open. That is a single bounded day.
    const now = Date.now();
    const loBound = Number.isFinite(fromMs) ? fromMs : 0;
    const hiBound = Number.isFinite(toMs) ? toMs : Number.MAX_SAFE_INTEGER;
    const anchor = Number.isFinite(toMs) ? (toMs as number) : now;

    const todayKey = awstDateKey(now);
    const fromKey = awstDateKey(Math.max(loBound, now - 400 * DAY_MS));
    const toKey = awstDateKey(Math.min(hiBound, now));

    const rollupRows = (await ctx.db
      .query("usageDaily")
      .withIndex("by_date", (q: any) => q.gte("date", fromKey).lte("date", toKey))
      .collect()) as any[];

    // Today is never in the roll-up (the cron builds yesterday). Compute it live
    // from a single day of raw events — bounded, unlike the old whole-range read.
    let todayAgg: any = null;
    const todayInRange =
      todayKey >= fromKey && todayKey <= toKey && !rollupRows.some((r) => r.date === todayKey);
    if (todayInRange) {
      const dayStart = awstDateKeyToMs(todayKey);
      const events = (await ctx.db
        .query("analytics")
        .withIndex("by_timestamp", (q: any) =>
          q.gte("timestamp", Math.max(dayStart, loBound)).lte("timestamp", Math.min(now, hiBound))
        )
        .take(8000)) as any[];
      const idOf = (e: any) => e.userId ?? e.sessionId ?? "";
      const s = new Set<string>(), ids = new Set<string>();
      let pv = 0;
      const pages = new Map<string, number>();
      const span = new Map<string, { min: number; max: number; count: number }>();
      const ua = new Map<string, string>();
      for (const e of events) {
        const id = idOf(e);
        if (e.sessionId) s.add(e.sessionId);
        if (id) ids.add(id);
        if (e.type === "pageview") {
          pv++;
          let path = "/";
          try { path = new URL(e.url ?? "").pathname || "/"; } catch { path = e.url ?? "/"; }
          pages.set(path, (pages.get(path) ?? 0) + 1);
        }
        if (e.sessionId) {
          const sp = span.get(e.sessionId) ?? { min: e.timestamp, max: e.timestamp, count: 0 };
          sp.min = Math.min(sp.min, e.timestamp);
          sp.max = Math.max(sp.max, e.timestamp);
          sp.count++;
          span.set(e.sessionId, sp);
          if (e.userAgent && !ua.has(e.sessionId)) ua.set(e.sessionId, e.userAgent);
        }
      }
      const lens: number[] = [];
      for (const sp of span.values()) if (sp.count >= 2) lens.push(sp.max - sp.min);
      const dev: Record<string, number> = {}, o: Record<string, number> = {}, br: Record<string, number> = {};
      for (const u of ua.values()) {
        const p = parseUserAgent(u);
        dev[p.device] = (dev[p.device] ?? 0) + 1;
        o[p.os] = (o[p.os] ?? 0) + 1;
        br[p.browser] = (br[p.browser] ?? 0) + 1;
      }
      todayAgg = {
        date: todayKey,
        pageviews: pv,
        sessions: s.size,
        activeIdentities: ids.size,
        newIdentities: 0, // filled from firstSeen below
        sessionSecondsTotal: Math.round(lens.reduce((a, b) => a + b, 0) / 1000),
        sessionsMeasured: lens.length,
        sessionMedianSec: lens.length ? Math.round(median(lens) / 1000) : 0,
        device: JSON.stringify(dev),
        os: JSON.stringify(o),
        browser: JSON.stringify(br),
        topPages: JSON.stringify(Object.fromEntries(pages)),
      };
    }

    const days = [...rollupRows, ...(todayAgg ? [todayAgg] : [])].sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    // ── Summable per-day figures ──────────────────────────────────────────
    const parse = (s: string) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
    const mergeInto = (dst: Record<string, number>, src: Record<string, number>) => {
      for (const [k, n] of Object.entries(src)) dst[k] = (dst[k] ?? 0) + (n as number);
    };
    let pageviews = 0, sessionsTotal = 0, newVisitors = 0;
    let secondsTotal = 0, sessionsMeasured = 0;
    const device: Record<string, number> = {}, os: Record<string, number> = {}, browser: Record<string, number> = {};
    const pageCounts: Record<string, number> = {};
    const dayMedians: number[] = [];
    for (const d of days) {
      pageviews += d.pageviews ?? 0;
      sessionsTotal += d.sessions ?? 0;
      newVisitors += d.newIdentities ?? 0;
      secondsTotal += d.sessionSecondsTotal ?? 0;
      sessionsMeasured += d.sessionsMeasured ?? 0;
      if (d.sessionMedianSec) dayMedians.push(d.sessionMedianSec);
      mergeInto(device, parse(d.device));
      mergeInto(os, parse(d.os));
      mergeInto(browser, parse(d.browser));
      mergeInto(pageCounts, parse(d.topPages));
    }

    // ── Distinct-identity figures ─────────────────────────────────────────
    // These CANNOT be summed across days (one person active on three days is one
    // unique user, not three), so they come from firstSeenByIdentity.lastTimestamp
    // via by_lastTimestamp — a two-field table, far cheaper than raw events.
    const IDENT_CAP = 12000;
    const countActiveSince = async (floor: number, ceil: number) => {
      const rows = await ctx.db
        .query("firstSeenByIdentity")
        .withIndex("by_lastTimestamp", (q: any) =>
          q.gte("lastTimestamp", floor).lte("lastTimestamp", ceil)
        )
        .take(IDENT_CAP + 1);
      return { n: Math.min(rows.length, IDENT_CAP), capped: rows.length > IDENT_CAP };
    };
    const uniq = await countActiveSince(loBound, Math.min(hiBound, now));
    const wauR = await countActiveSince(anchor - 7 * DAY_MS, anchor);
    const mauR = await countActiveSince(anchor - 30 * DAY_MS, anchor);

    // `lastTimestamp` answers "was this identity active in the window" EXACTLY
    // only when the window runs up to now. For a historical window (to < now) an
    // identity active then AND since has a lastTimestamp beyond the window, so it
    // is missed — flagged rather than silently wrong.
    const trailing = hiBound >= now - 60 * 1000;
    const uniqueUsers = uniq.n;
    const returning = Math.max(0, uniqueUsers - newVisitors);

    const MIN = 60;
    const dailyActive = days.map((d) => ({ date: d.date, users: d.activeIdentities ?? 0 }));
    const topPages = Object.entries(pageCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([path, count]) => ({ path, count }));

    // Days in range with no roll-up row (backfill not run yet, or a cron miss).
    const expectedDays = Math.max(
      0,
      Math.round((awstDateKeyToMs(toKey) - awstDateKeyToMs(fromKey)) / DAY_MS) + 1
    );
    const daysMissing = Math.max(0, expectedDays - days.length);

    return {
      sessions: sessionsTotal,
      uniqueUsers,
      pageviews,
      pageviewsPerSession: sessionsTotal > 0 ? round2(pageviews / sessionsTotal) : 0,
      sessionsPerUser: uniqueUsers > 0 ? round2(sessionsTotal / uniqueUsers) : 0,
      avgSessionMin: sessionsMeasured ? round2(secondsTotal / sessionsMeasured / MIN) : 0,
      // Medians cannot be summed, so a multi-day range reports the median OF THE
      // DAILY MEDIANS — representative, not the true pooled median.
      medianSessionMin: dayMedians.length ? round2(median(dayMedians) / MIN) : 0,
      wau: wauR.n,
      mau: mauR.n,
      newVisitors,
      returning,
      device,
      os,
      browser,
      dailyActive,
      topPages,
      // Honesty flags. Nothing here is capped in normal operation — these exist
      // so the UI never presents an incomplete figure as a total.
      truncated: false,
      mauTruncated: mauR.capped || wauR.capped,
      uniqueUsersExact: trailing && !uniq.capped,
      daysMissing,
      analysedFrom: days.length ? awstDateKeyToMs(days[0].date) : loBound,
      analysedEvents: pageviews,
    };
  },
});

// ============================================================================
// C2.5 — BOOKING-FLOW FUNNEL (per-step conversion, drop-off, time-in-step)
// ============================================================================
// The conversion ladder is one booking ATTEMPT (a fresh flowId starts at
// slot_select). calendar_open is a session-level engagement signal above the
// ladder, counted separately (it precedes the per-attempt flowId).
const CORE_STEPS = [
  "slot_select",
  "modal_open",
  "continue_to_payment",
  "checkout_redirect",
  "booking_confirmed",
];
const ALL_STEPS = [
  "calendar_open",
  "slot_select",
  "modal_open",
  "variant_chosen",
  "duration_chosen",
  "continue_to_payment",
  "checkout_redirect",
  "booking_confirmed",
  "booking_abandoned",
];
const STEP_LABELS: Record<string, string> = {
  calendar_open: "Calendar opened",
  slot_select: "Slot selected",
  modal_open: "Booking modal opened",
  variant_chosen: "Machine type chosen",
  duration_chosen: "Duration chosen",
  continue_to_payment: "Continue to payment",
  checkout_redirect: "Redirected to checkout",
  booking_confirmed: "Booking confirmed",
  booking_abandoned: "Booking abandoned",
};

export const getBookingFunnel = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()), fromMs: v.optional(v.number()), toMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to, args.fromMs, args.toMs);
    const stepSet = new Set(ALL_STEPS);

    const events = (
      await ctx.db
        .query("analytics")
        .withIndex("by_type_timestamp", (q: any) =>
          q.eq("type", "event").gte("timestamp", Number.isFinite(fromMs) ? fromMs : 0)
        )
        .collect()
    ).filter((e: any) => e.timestamp <= toMs && e.name && stepSet.has(e.name));

    // flowId -> { step -> earliest ts }
    const flows = new Map<string, Record<string, number>>();
    for (const e of events as any[]) {
      const meta = safeParseJson(e.metadata);
      const flowId = meta.flowId ?? e.sessionId ?? "";
      if (!flowId) continue;
      const f = flows.get(flowId) ?? {};
      if (f[e.name] === undefined || e.timestamp < f[e.name]) f[e.name] = e.timestamp;
      flows.set(flowId, f);
    }

    const stepCounts: Record<string, number> = {};
    for (const s of ALL_STEPS) stepCounts[s] = 0;
    const transitionTimes: Record<string, number[]> = {};
    const timeToBook: number[] = [];
    let redirected = 0;
    let confirmedAfterRedirect = 0;

    for (const f of flows.values()) {
      for (const s of ALL_STEPS) if (f[s] !== undefined) stepCounts[s]++;
      // consecutive CORE transitions
      for (let i = 0; i < CORE_STEPS.length - 1; i++) {
        const a = f[CORE_STEPS[i]];
        const b = f[CORE_STEPS[i + 1]];
        if (a !== undefined && b !== undefined && b >= a) {
          const key = `${CORE_STEPS[i]}→${CORE_STEPS[i + 1]}`;
          (transitionTimes[key] = transitionTimes[key] ?? []).push(b - a);
        }
      }
      const start = f["slot_select"] ?? f["modal_open"];
      const done = f["booking_confirmed"];
      if (start !== undefined && done !== undefined && done >= start) timeToBook.push(done - start);
      if (f["checkout_redirect"] !== undefined) {
        redirected++;
        if (f["booking_confirmed"] !== undefined) confirmedAfterRedirect++;
      }
    }

    const SEC = 1000;
    const ladder = CORE_STEPS.map((s, i) => {
      const count = stepCounts[s];
      const prev = i > 0 ? stepCounts[CORE_STEPS[i - 1]] : count;
      const top = stepCounts[CORE_STEPS[0]] || 1;
      return {
        step: s,
        label: STEP_LABELS[s],
        count,
        pctOfTop: Math.round((count / top) * 100),
        pctOfPrev: prev > 0 ? Math.round((count / prev) * 100) : 100,
        dropFromPrev: Math.max(0, prev - count),
      };
    });

    const transitions = Object.entries(transitionTimes).map(([key, arr]) => ({
      transition: key,
      medianSec: round2(median(arr) / SEC),
      avgSec: round2(arr.reduce((s, x) => s + x, 0) / arr.length / SEC),
      samples: arr.length,
    }));

    // calendar_open precedes the per-attempt flowId, so count it from raw events.
    const calendarOpens = (events as any[]).filter((e) => e.name === "calendar_open").length;

    return {
      totalFlows: flows.size,
      calendarOpens,
      ladder,
      transitions,
      variantChosen: stepCounts["variant_chosen"],
      durationChosen: stepCounts["duration_chosen"],
      abandoned: stepCounts["booking_abandoned"],
      checkoutAbandonRatePct: redirected > 0 ? Math.round(((redirected - confirmedAfterRedirect) / redirected) * 100) : 0,
      medianTimeToBookSec: timeToBook.length ? round2(median(timeToBook) / SEC) : 0,
      avgTimeToBookSec: timeToBook.length ? round2(timeToBook.reduce((s, x) => s + x, 0) / timeToBook.length / SEC) : 0,
      conversionPct: stepCounts["slot_select"] > 0 ? Math.round((stepCounts["booking_confirmed"] / stepCounts["slot_select"]) * 100) : 0,
    };
  },
});

// ============================================================================
// C2.8 — DOOR-CODE ACCESS LEAD TIME (when people open the app to grab their code)
// ============================================================================
export const getCodeAccessLeadTime = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()), fromMs: v.optional(v.number()), toMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to, args.fromMs, args.toMs);
    const events = (
      await ctx.db
        .query("analytics")
        .withIndex("by_name_timestamp", (q: any) =>
          q.eq("name", "code_view").gte("timestamp", Number.isFinite(fromMs) ? fromMs : 0)
        )
        .collect()
    ).filter((e: any) => e.timestamp <= toMs);

    const leads: number[] = []; // minutes before booking start
    const buckets = {
      after_start: 0, // already started / past
      lt22: 0, // < 22 min before
      m22_60: 0, // 22–60 min
      h1_6: 0, // 1–6 h
      h6_24: 0, // 6–24 h
      gt24: 0, // > 24 h
    };
    for (const e of events as any[]) {
      const meta = safeParseJson(e.metadata);
      const lead = typeof meta.leadMinutes === "number" ? meta.leadMinutes : null;
      if (lead === null) continue;
      leads.push(lead);
      if (lead < 0) buckets.after_start++;
      else if (lead < 22) buckets.lt22++;
      else if (lead < 60) buckets.m22_60++;
      else if (lead < 360) buckets.h1_6++;
      else if (lead < 1440) buckets.h6_24++;
      else buckets.gt24++;
    }

    return {
      total: leads.length,
      medianLeadMin: leads.length ? Math.round(median(leads)) : 0,
      avgLeadMin: leads.length ? Math.round(leads.reduce((s, x) => s + x, 0) / leads.length) : 0,
      buckets,
    };
  },
});

// ============================================================================
// C2.4 — PUSH analytics (sends/delivery/CTR by category + platform, opt-in)
// ============================================================================
export const getPushAnalytics = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()), fromMs: v.optional(v.number()), toMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to, args.fromMs, args.toMs);
    const events = (
      await ctx.db
        .query("pushEvents")
        .withIndex("by_at", (q: any) => q.gte("at", Number.isFinite(fromMs) ? fromMs : 0))
        .collect()
    ).filter((e: any) => e.at <= toMs);

    const totals = { sent: 0, failed: 0, pruned: 0, delivered: 0, clicked: 0 };
    const byCategory = new Map<string, { sent: number; delivered: number; clicked: number }>();
    const byPlatform = new Map<string, { sent: number; delivered: number; clicked: number }>();
    for (const e of events as any[]) {
      if (e.type in totals) (totals as any)[e.type]++;
      const cat = e.category ?? "unknown";
      const c = byCategory.get(cat) ?? { sent: 0, delivered: 0, clicked: 0 };
      if (e.type === "sent") c.sent++;
      else if (e.type === "delivered") c.delivered++;
      else if (e.type === "clicked") c.clicked++;
      byCategory.set(cat, c);
      const plat = e.platform ?? "other";
      const p = byPlatform.get(plat) ?? { sent: 0, delivered: 0, clicked: 0 };
      if (e.type === "sent") p.sent++;
      else if (e.type === "delivered") p.delivered++;
      else if (e.type === "clicked") p.clicked++;
      byPlatform.set(plat, p);
    }

    // Opt-in rate: distinct subscribed emails ÷ active (non-deactivated) customers.
    const subs = await ctx.db.query("pushSubscriptions").collect();
    const subEmails = new Set((subs as any[]).map((s) => (s.email ?? "").toLowerCase()).filter(Boolean));
    const customers = await ctx.db.query("customers").collect();
    const activeCustomers = (customers as any[]).filter((c) => !c.deactivatedAt && (c.role === "customer" || c.role === "user" || c.role === "coach")).length;

    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
    return {
      totals,
      deliveryRatePct: pct(totals.delivered, totals.sent),
      ctrPct: pct(totals.clicked, totals.delivered || totals.sent),
      clickPerSentPct: pct(totals.clicked, totals.sent),
      subscribedDevices: subs.length,
      subscribedAccounts: subEmails.size,
      activeCustomers,
      optInRatePct: pct(subEmails.size, activeCustomers),
      byCategory: Array.from(byCategory.entries()).map(([category, v2]) => ({
        category,
        ...v2,
        deliveryPct: pct(v2.delivered, v2.sent),
        ctrPct: pct(v2.clicked, v2.delivered || v2.sent),
      })).sort((a, b) => b.sent - a.sent),
      byPlatform: Array.from(byPlatform.entries()).map(([platform, v2]) => ({
        platform,
        ...v2,
        deliveryPct: pct(v2.delivered, v2.sent),
        ctrPct: pct(v2.clicked, v2.delivered || v2.sent),
      })).sort((a, b) => b.sent - a.sent),
    };
  },
});

// ============================================================================
// C2.6 + push — WAITLIST OFFER response analytics (accept/decline/no-action time)
// ============================================================================
export const getWaitlistAnalytics = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()), fromMs: v.optional(v.number()), toMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to, args.fromMs, args.toMs);
    const events = (
      await ctx.db
        .query("waitlistOfferEvents")
        .withIndex("by_at", (q: any) => q.gte("at", Number.isFinite(fromMs) ? fromMs : 0))
        .collect()
    ).filter((e: any) => e.at <= toMs);

    let offered = 0, accepted = 0, declined = 0, expired = 0;
    const acceptLat: number[] = [];
    const declineLat: number[] = [];
    for (const e of events as any[]) {
      if (e.action === "offered") offered++;
      else if (e.action === "accepted") { accepted++; if (typeof e.latencyMs === "number") acceptLat.push(e.latencyMs); }
      else if (e.action === "declined") { declined++; if (typeof e.latencyMs === "number") declineLat.push(e.latencyMs); }
      else if (e.action === "expired") expired++;
    }
    const responses = accepted + declined;
    const MIN = 60 * 1000;
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
    return {
      offered,
      accepted,
      declined,
      expired,
      responses,
      conversionPct: pct(accepted, offered),
      declineRatePct: pct(declined, offered),
      noActionPct: pct(expired, offered), // never pressed a button
      responseRatePct: pct(responses, offered),
      medianAcceptMin: acceptLat.length ? round2(median(acceptLat) / MIN) : 0,
      avgAcceptMin: acceptLat.length ? round2(acceptLat.reduce((s, x) => s + x, 0) / acceptLat.length / MIN) : 0,
      medianDeclineMin: declineLat.length ? round2(median(declineLat) / MIN) : 0,
      avgDeclineMin: declineLat.length ? round2(declineLat.reduce((s, x) => s + x, 0) / declineLat.length / MIN) : 0,
    };
  },
});

// ============================================================================
// SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part C1 — WAITLIST DEMAND. The waitlist
// is the only place the business records demand it FAILED to serve; nothing
// read it. Keyed on the SESSION date (what was wanted, when), not the join
// date, via the `waitlist.by_date` index. Every row counts as one unit of
// demand whatever its outcome; outcome is reported alongside so "unserved"
// (never even offered a lane) is visible separately from "offered but lost".
// ============================================================================
const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const getWaitlistDemand = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()), fromMs: v.optional(v.number()), toMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    return await computeWaitlistDemand(ctx, args);
  },
});

export async function computeWaitlistDemand(
  ctx: any,
  args: { from?: string; to?: string; fromMs?: number; toMs?: number }
) {
  {
    const { fromMs, toMs } = rangeMs(args.from, args.to, args.fromMs, args.toMs);
    const fromKey = Number.isFinite(fromMs) ? awstDateKey(fromMs) : "0000-00-00";
    const toKey = Number.isFinite(toMs) ? awstDateKey(toMs) : "9999-12-31";
    const rows = await ctx.db
      .query("waitlist")
      .withIndex("by_date", (q: any) => q.gte("date", fromKey).lte("date", toKey))
      .collect();

    const poolOf = (laneId: string) => (laneId === "*bm" ? "bm" : laneId === "*ru" ? "ru" : "any");
    const emailOf = (e: any) => String(e.userEmail ?? "").toLowerCase().trim();
    const dowOf = (date: string) => awstParts(awstDateKeyToMs(date)).dow;

    type Cell = { entries: number; customers: Set<string>; dates: Set<string> };
    const recurring = new Map<string, Cell & { dow: number; hour: number; pool: string }>();
    const sessions = new Map<string, { date: string; hour: number; pool: string; entries: number; customers: Set<string> }>();
    const byHour = new Map<number, number>();
    const byDow = new Map<number, number>();
    const byPool: Record<string, number> = { bm: 0, ru: 0, any: 0 };
    const customers = new Set<string>();
    let booked = 0, open = 0, neverOffered = 0, offeredLost = 0;

    for (const e of rows as any[]) {
      const pool = poolOf(e.laneId);
      const st = e.status ?? "waiting";
      const email = emailOf(e);
      customers.add(email);
      byPool[pool] = (byPool[pool] ?? 0) + 1;
      if (st === "booked") booked++;
      else if (st === "waiting" || st === "offered") open++;
      else if (typeof e.offeredAt === "number") offeredLost++;
      else neverOffered++;

      const dow = dowOf(e.date);
      const rk = `${dow}|${e.hour}|${pool}`;
      const rc = recurring.get(rk) ?? { dow, hour: e.hour, pool, entries: 0, customers: new Set(), dates: new Set() };
      rc.entries++; rc.customers.add(email); rc.dates.add(e.date);
      recurring.set(rk, rc);

      const sk = `${e.date}|${e.hour}|${pool}`;
      const sc = sessions.get(sk) ?? { date: e.date, hour: e.hour, pool, entries: 0, customers: new Set() };
      sc.entries++; sc.customers.add(email);
      sessions.set(sk, sc);

      byHour.set(e.hour, (byHour.get(e.hour) ?? 0) + 1);
      byDow.set(dow, (byDow.get(dow) ?? 0) + 1);
    }

    const total = rows.length;
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
    const cells = [...recurring.values()].map((c) => ({
      dow: c.dow,
      dowLabel: DOW_LABEL[c.dow],
      hour: c.hour,
      pool: c.pool,
      entries: c.entries,
      customers: c.customers.size,
      dates: c.dates.size,
    }));
    return {
      total,
      uniqueCustomers: customers.size,
      byPool,
      outcomes: { booked, open, neverOffered, offeredLost },
      servedPct: pct(booked, total),
      neverOfferedPct: pct(neverOffered, total),
      // Every (weekday, hour, pool) cell — the UI draws the heatmap from this.
      cells: cells.sort((a, b) => a.dow - b.dow || a.hour - b.hour),
      topRecurring: [...cells].sort((a, b) => b.entries - a.entries || b.customers - a.customers).slice(0, 15),
      topSessions: [...sessions.values()]
        .map((s) => ({ date: s.date, dowLabel: DOW_LABEL[dowOf(s.date)], hour: s.hour, pool: s.pool, entries: s.entries, customers: s.customers.size }))
        .sort((a, b) => b.entries - a.entries || a.date.localeCompare(b.date))
        .slice(0, 10),
      byHour: [...byHour.entries()].map(([hour, entries]) => ({ hour, entries })).sort((a, b) => a.hour - b.hour),
      byDow: [...byDow.entries()].map(([dow, entries]) => ({ dow, dowLabel: DOW_LABEL[dow], entries })).sort((a, b) => a.dow - b.dow),
    };
  }
}
