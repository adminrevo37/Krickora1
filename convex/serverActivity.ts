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
  source: "page" | "push" | "email";
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
    await ctx.db.insert("emailEvents", {
      at: args.at,
      type: args.type.slice(0, 32),
      to: args.to ? args.to.toLowerCase().slice(0, 256) : undefined,
      subject: args.subject ? args.subject.slice(0, 256) : undefined,
      emailId: args.emailId ? args.emailId.slice(0, 128) : undefined,
    });
    return true;
  },
});

// ── Unified real-time activity feed (admin only) ──────────────────────────────
export const getServerActivity = query({
  args: {
    limit: v.optional(v.number()),
    sources: v.optional(v.array(v.string())), // subset of ['page','push','email']; empty/absent = all
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
