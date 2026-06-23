// SPEC_SERVER_ACTIVITY_FEED (2026-06) — a single real-time admin feed that merges
// the newest rows from analytics (page views + custom/session events), pushEvents
// and emailEvents into one server-time-ordered stream. Reactive: any insert into
// those tables re-runs getServerActivity and pushes the update to the admin UI
// (same mechanism as the bookings live feed, but far more granular).
//
// Email rows arrive from the Resend webhook (convex/http.ts -> /resend/webhook ->
// logEmailEventInternal). Page-view actor emails come from analytics.email
// (server-derived in analytics.trackEvent). Names are resolved from customers.

import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";

// Normalized row rendered by src/components/analytics/ServerActivityTab.tsx.
export type ActivityRow = {
  id: string;
  at: number; // server ms (formatted to AWST in the UI)
  source: "page" | "push" | "email" | "entry";
  kind: string; // page: 'pageview'|'session_start'|'session_end'|'event:<name>'
  //           push:  'sent'|'failed'|'pruned'|'delivered'|'clicked'
  //           email: 'sent'|'delivered'|'opened'|'clicked'|'bounced'|...
  email?: string;
  name?: string; // resolved customer display name
  label?: string; // page: url path · push: category · email: subject
  sub?: string; // page: event meta / session · push: tag
  platform?: string; // push platform
};

// ── Email lifecycle logger — called by the Resend webhook in http.ts ──────────
export const logEmailEventInternal = internalMutation({
  args: {
    at: v.number(),
    type: v.string(),
    to: v.optional(v.string()),
    subject: v.optional(v.string()),
    emailId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const to = args.to ? args.to.toLowerCase().slice(0, 256) : undefined;
    const type = args.type.slice(0, 32);
    await ctx.db.insert("emailEvents", {
      at: args.at,
      type,
      to,
      subject: args.subject ? args.subject.slice(0, 256) : undefined,
      emailId: args.emailId ? args.emailId.slice(0, 128) : undefined,
    });
    // Flag the matching customer so admin → Customers shows a "Bounced" badge
    // (catches mistyped / undeliverable addresses fast). Auto-cleared when a later
    // email to the same address delivers. Only the relevant lifecycle events do a
    // customer lookup (skip the high-volume sent/opened/clicked).
    if (to && (type === "bounced" || type === "complained")) {
      const c = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", to))
        .first();
      if (c) await ctx.db.patch(c._id, { emailBounced: true, emailBounceAt: args.at, emailBounceType: type });
    } else if (to && type === "delivered") {
      const c = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", to))
        .first();
      if (c && (c as any).emailBounced) await ctx.db.patch(c._id, { emailBounced: false });
    }
    return true;
  },
});

// ── Door-keypad entry logger — called by the /ha/entry webhook in http.ts ──────
export const logEntryEventInternal = internalMutation({
  args: {
    at: v.number(),
    ts: v.number(),
    bay: v.string(),
    codeHash: v.string(),
    result: v.string(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("entryEvents", {
      at: args.at,
      ts: args.ts,
      bay: args.bay.slice(0, 16),
      codeHash: args.codeHash.slice(0, 128),
      result: args.result.slice(0, 16),
      source: args.source.slice(0, 32),
    });
    return true;
  },
});

// ── Unified real-time activity feed (admin only) ──────────────────────────────
export const getServerActivity = query({
  args: {
    limit: v.optional(v.number()),
    sources: v.optional(v.array(v.string())), // subset of ['page','push','email','entry']; empty/absent = all
  },
  handler: async (ctx, args): Promise<ActivityRow[]> => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return [];
    const limit = Math.min(Math.max(args.limit ?? 150, 1), 400);
    const want = (s: string) =>
      !args.sources || args.sources.length === 0 || args.sources.includes(s);
    const perTable = limit; // read up to `limit` newest from each table, then merge + slice

    const rows: ActivityRow[] = [];

    // PAGE — analytics (default index = by _creationTime, i.e. true server time).
    if (want("page")) {
      const a = await ctx.db.query("analytics").order("desc").take(perTable);
      for (const e of a) {
        let label: string | undefined;
        try {
          label = e.url ? new URL(e.url).pathname : undefined;
        } catch {
          label = e.url ?? undefined;
        }
        const kind = e.type === "event" ? `event:${e.name ?? "?"}` : e.type;
        let sub: string | undefined;
        if (e.type === "event" && e.metadata) sub = e.metadata.slice(0, 160);
        else if (e.sessionId) sub = `sess ${e.sessionId.slice(0, 6)}`;
        rows.push({
          id: e._id,
          at: e._creationTime,
          source: "page",
          kind,
          email: (e as any).email ?? undefined,
          label,
          sub,
        });
      }
    }

    // PUSH — pushEvents (server `at`).
    if (want("push")) {
      const p = await ctx.db.query("pushEvents").withIndex("by_at").order("desc").take(perTable);
      for (const e of p) {
        rows.push({
          id: e._id,
          at: e.at,
          source: "push",
          kind: e.type,
          email: e.email ?? undefined,
          label: e.category ?? undefined,
          sub: e.tag ?? undefined,
          platform: e.platform ?? undefined,
        });
      }
    }

    // EMAIL — emailEvents (Resend webhook).
    if (want("email")) {
      const m = await ctx.db.query("emailEvents").withIndex("by_at").order("desc").take(perTable);
      for (const e of m) {
        rows.push({
          id: e._id,
          at: e.at,
          source: "email",
          kind: e.type,
          email: e.to ?? undefined,
          label: e.subject ?? undefined,
        });
      }
    }

    // ENTRY — door-keypad events (HA /ha/entry webhook). No PII: no email/name.
    if (want("entry")) {
      const en = await ctx.db.query("entryEvents").withIndex("by_at").order("desc").take(perTable);
      for (const e of en) {
        rows.push({
          id: e._id,
          at: e.at,
          source: "entry",
          kind: e.result, // valid | invalid | unknown
          label: e.bay ? `Bay ${e.bay}` : undefined,
          sub: e.codeHash ? `${e.codeHash.slice(0, 10)}…` : undefined,
        });
      }
    }

    // Merge by server time (newest first) and cap.
    rows.sort((x, y) => y.at - x.at);
    const top = rows.slice(0, limit);

    // Resolve actor display names from the distinct emails present.
    const emails = Array.from(
      new Set(top.map((r) => r.email).filter((e): e is string => !!e))
    );
    const nameByEmail = new Map<string, string>();
    for (const email of emails) {
      const c = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", email))
        .first();
      if (c?.name) nameByEmail.set(email, c.name);
    }
    for (const r of top) {
      if (r.email && nameByEmail.has(r.email)) r.name = nameByEmail.get(r.email);
    }
    return top;
  },
});

// New-customer registration feed — accounts newest-first (by Convex _creationTime),
// each flagged with whether they've LINKED A COACH (any of their athletes, incl.
// their own self-athlete, has an assigned coach). Reactive: a new row appears the
// instant someone registers; the coach badge flips the instant they link a coach.
// Companion to LiveFeedTab (bookings) + ServerActivityTab (page/push/email). Admin only.
export const getNewCustomers = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return null;
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);

    // Newest-registered first (Convex's default order is by _creationTime). Pull a
    // few extra so filtering out staff/merged rows still yields `limit` customers.
    const recent = await ctx.db.query("customers").order("desc").take(limit * 2 + 10);
    const customers = recent
      .filter((c: any) => c.role !== "coach" && c.role !== "admin")
      .filter((c: any) => !c.deactivatedAt && !c.mergedIntoCustomerId)
      .slice(0, limit);

    // LEAK-4/COST-9 (audit 2026-06): fetch only the DISPLAYED accounts' athletes via
    // the by_account index, instead of scanning the whole athletes table on every
    // customer/athlete write (this query is reactive in the admin live feed). Coach
    // links: which displayed accounts have an athlete with an assigned coach.
    const coachIdsByAccount = new Map<string, Set<string>>();
    for (const c of customers) {
      const accountAthletes = await ctx.db
        .query("athletes")
        .withIndex("by_account", (q: any) => q.eq("accountCustomerId", c._id))
        .collect();
      const set = new Set<string>();
      for (const a of accountAthletes) {
        for (const id of ((a as any).assignedCoachIds ?? []).filter(Boolean)) set.add(String(id));
      }
      if (set.size > 0) coachIdsByAccount.set(String(c._id), set);
    }
    // Coach id -> display name.
    const coaches = await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", "coach"))
      .collect();
    const coachName = new Map<string, string>();
    for (const c of coaches) coachName.set(String(c._id), (c as any).name ?? c.email);

    return customers.map((c: any) => {
      const ids = [...(coachIdsByAccount.get(String(c._id)) ?? [])];
      return {
        id: String(c._id),
        at: c._creationTime as number,
        name: c.name ?? (`${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email),
        email: c.email,
        suburb: c.suburb ?? null,
        postcode: c.postcode ?? null,
        referralSource: c.referralSource ?? null,
        hasLinkedCoach: ids.length > 0,
        coachNames: ids.map((id) => coachName.get(id)).filter(Boolean) as string[],
      };
    });
  },
});
