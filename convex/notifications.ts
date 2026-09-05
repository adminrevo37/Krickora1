// NOTIFICATIONS INBOX (Inspector, 2026-09-03).
//
// "If clicking on a push notification it should take you to a notifications
// centre in your home screen app, so you can read the full message." A push is
// ephemeral and iOS truncates the body; nothing stored it. Now every customer /
// coach push writes a row here first (push.ts sendPushInternal), delivery or not,
// so email-only accounts get the same inbox. Retention 7 days (retention.ts).
import { internalMutation, mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";

// Categories whose push TAP still goes straight to the action (a 15-min hold
// does not survive a detour through an inbox). Their inbox row is still written.
export const DIRECT_ACTION_CATEGORIES = new Set(["waitlist-offers", "extend-offer"]);
const SKIP_CATEGORIES = new Set(["admin-ops"]);
const MAX_LIST = 100;

/** Called by sendPushInternal BEFORE delivery. Returns the row id, or null if skipped. */
export const recordInternal = internalMutation({
  args: {
    email: v.string(),
    title: v.string(),
    body: v.string(),
    category: v.string(),
    url: v.optional(v.string()),
    actions: v.optional(v.array(v.object({ action: v.string(), title: v.string(), url: v.optional(v.string()) }))),
    tag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (SKIP_CATEGORIES.has(args.category)) return null;
    // The "expiring soon" nudge would duplicate the offer row it belongs to.
    if ((args.tag ?? "").startsWith("waitlist-expiry-")) return null;
    const id = await ctx.db.insert("notifications", {
      email: args.email.toLowerCase().trim(),
      title: args.title,
      body: args.body,
      category: args.category,
      url: args.url,
      actions: args.actions?.map((a) => ({ title: a.title, url: a.url })),
      tag: args.tag,
      sentAt: Date.now(),
    });
    return String(id);
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const caller = await getCallerContext(ctx);
    const email = (caller.email ?? "").toLowerCase().trim();
    if (!email) return [];
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_email_sentAt", (q: any) => q.eq("email", email))
      .order("desc")
      .take(MAX_LIST);
    return rows.map((r: any) => ({
      id: String(r._id),
      title: r.title,
      body: r.body,
      category: r.category,
      url: r.url ?? null,
      actions: r.actions ?? [],
      sentAt: r.sentAt,
      readAt: r.readAt ?? null,
    }));
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const caller = await getCallerContext(ctx);
    const email = (caller.email ?? "").toLowerCase().trim();
    if (!email) return 0;
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_email_sentAt", (q: any) => q.eq("email", email))
      .order("desc")
      .take(MAX_LIST);
    return rows.filter((r: any) => !r.readAt).length;
  },
});

export const markRead = mutation({
  // L3 (SECURITY review 2026-09-05b): was a bare ctx.db.get on the raw string,
  // which resolves an id from ANY table; the owner check (`row.email === caller`)
  // happened to be satisfied by the caller's own customers row too, and only the
  // schema (no `readAt` on customers) stopped the patch. The id is now pinned to
  // the notifications table via normalizeId. The arg stays v.string() (not
  // v.id) so the web client's call signature is unchanged — the check is
  // server-side either way.
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    const email = (caller.email ?? "").toLowerCase().trim();
    if (!email) throw new ConvexError("Please sign in.");
    const id = ctx.db.normalizeId("notifications", args.id);
    if (!id) return { ok: false };
    const row: any = await ctx.db.get(id);
    if (!row || String(row.email ?? "").toLowerCase() !== email) return { ok: false };
    if (!row.readAt) await ctx.db.patch(row._id, { readAt: Date.now() });
    return { ok: true };
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const caller = await getCallerContext(ctx);
    const email = (caller.email ?? "").toLowerCase().trim();
    if (!email) throw new ConvexError("Please sign in.");
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_email_sentAt", (q: any) => q.eq("email", email))
      .order("desc")
      .take(MAX_LIST);
    let n = 0;
    const now = Date.now();
    for (const r of rows as any[]) {
      if (!r.readAt) { await ctx.db.patch(r._id, { readAt: now }); n++; }
    }
    return { marked: n };
  },
});
