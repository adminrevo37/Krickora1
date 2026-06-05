// SPEC_ANALYTICS_BUILD_2026-06 — usage, booking-flow funnel, push delivery/CTR,
// waitlist-offer response latency, and door-code access lead-time analytics.
// Admin-only. Reads the `analytics`, `pushEvents`, `waitlistOfferEvents`,
// `pushSubscriptions` and `customers` tables.

import { query } from "./_generated/server";
import { v } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";
import {
  awstDateKey,
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

function rangeMs(from?: string, to?: string): { fromMs: number; toMs: number } {
  return {
    fromMs: from ? Date.parse(from + "T00:00:00+08:00") : -Infinity,
    toMs: to ? Date.parse(to + "T23:59:59+08:00") : Infinity,
  };
}

// ============================================================================
// C2.3 — APP USAGE (DAU/WAU/MAU, sessions, session length, pages, device split)
// ============================================================================
export const getUsageAnalytics = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to);
    const allEvents = await ctx.db.query("analytics").collect();

    // First-ever timestamp per identity (all-time) for new-vs-returning.
    const idOf = (e: any) => e.userId ?? e.sessionId ?? "";
    const firstSeen = new Map<string, number>();
    for (const e of allEvents as any[]) {
      const id = idOf(e);
      if (!id) continue;
      const prev = firstSeen.get(id);
      if (prev === undefined || e.timestamp < prev) firstSeen.set(id, e.timestamp);
    }

    const events = (allEvents as any[]).filter((e) => e.timestamp >= fromMs && e.timestamp <= toMs);

    const sessions = new Set<string>();
    const users = new Set<string>();
    let pageviews = 0;
    const pageCounts = new Map<string, number>();
    const sessionSpan = new Map<string, { min: number; max: number; count: number }>();
    const sessionUA = new Map<string, string>();
    const dayUsers = new Map<string, Set<string>>();

    for (const e of events) {
      const id = idOf(e);
      if (e.sessionId) sessions.add(e.sessionId);
      if (id) users.add(id);
      if (e.type === "pageview") {
        pageviews++;
        let path = "/";
        try { path = new URL(e.url ?? "").pathname || "/"; } catch { path = e.url ?? "/"; }
        pageCounts.set(path, (pageCounts.get(path) ?? 0) + 1);
      }
      if (e.sessionId) {
        const span = sessionSpan.get(e.sessionId) ?? { min: e.timestamp, max: e.timestamp, count: 0 };
        span.min = Math.min(span.min, e.timestamp);
        span.max = Math.max(span.max, e.timestamp);
        span.count++;
        sessionSpan.set(e.sessionId, span);
        if (e.userAgent && !sessionUA.has(e.sessionId)) sessionUA.set(e.sessionId, e.userAgent);
      }
      const dk = awstDateKey(e.timestamp);
      const set = dayUsers.get(dk) ?? new Set<string>();
      if (id) set.add(id);
      dayUsers.set(dk, set);
    }

    // Session lengths (sessions with ≥2 events).
    const lengths: number[] = [];
    for (const span of sessionSpan.values()) {
      if (span.count >= 2) lengths.push(span.max - span.min);
    }

    // New vs returning (identities active in range).
    let newVisitors = 0;
    let returning = 0;
    for (const id of users) {
      const first = firstSeen.get(id) ?? 0;
      if (first >= fromMs) newVisitors++;
      else returning++;
    }

    // WAU / MAU relative to the range end (or now if open-ended).
    const anchor = Number.isFinite(toMs) ? toMs : Date.now();
    const wau = new Set<string>();
    const mau = new Set<string>();
    for (const e of allEvents as any[]) {
      const id = idOf(e);
      if (!id) continue;
      if (e.timestamp >= anchor - 7 * DAY_MS && e.timestamp <= anchor) wau.add(id);
      if (e.timestamp >= anchor - 30 * DAY_MS && e.timestamp <= anchor) mau.add(id);
    }

    // Device / OS / browser split (one vote per session by its first UA).
    const device: Record<string, number> = {};
    const os: Record<string, number> = {};
    const browser: Record<string, number> = {};
    for (const ua of sessionUA.values()) {
      const p = parseUserAgent(ua);
      device[p.device] = (device[p.device] ?? 0) + 1;
      os[p.os] = (os[p.os] ?? 0) + 1;
      browser[p.browser] = (browser[p.browser] ?? 0) + 1;
    }

    const dailyActive = Array.from(dayUsers.entries())
      .sort()
      .map(([date, set]) => ({ date, users: set.size }));
    const topPages = Array.from(pageCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([path, count]) => ({ path, count }));

    const MIN = 60 * 1000;
    return {
      sessions: sessions.size,
      uniqueUsers: users.size,
      pageviews,
      pageviewsPerSession: sessions.size > 0 ? round2(pageviews / sessions.size) : 0,
      sessionsPerUser: users.size > 0 ? round2(sessions.size / users.size) : 0,
      avgSessionMin: lengths.length ? round2(lengths.reduce((s, x) => s + x, 0) / lengths.length / MIN) : 0,
      medianSessionMin: lengths.length ? round2(median(lengths) / MIN) : 0,
      wau: wau.size,
      mau: mau.size,
      newVisitors,
      returning,
      device,
      os,
      browser,
      dailyActive,
      topPages,
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
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to);
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
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to);
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
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to);
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
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await isAdmin(ctx))) return null;
    const { fromMs, toMs } = rangeMs(args.from, args.to);
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
