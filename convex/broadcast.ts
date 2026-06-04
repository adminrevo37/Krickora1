// SPEC_ADMIN_BROADCAST — targeted push + email-fallback broadcasts.
//
// Admin composes a message and sends it to a chosen audience as PUSH, with an
// automatic EMAIL fallback to anyone not push-reachable (so the comms always
// lands). Audience is resolved from the booking calendar (day/week/month/custom
// range) or "all customers", filtered by recipient type (customer / coach /
// athlete-child→parent), deduped per person.
//
// Reuses: convex/push.ts sendPushInternal (we pass a non-event category so the
// per-event toggles don't gate broadcasts — see §4), the Resend transport in
// convex/lib/email.ts ("announcement" template), and the global push kill-switch.
//
// Tiers:
//   - announcement (normal): dropped for users with receiveAnnouncements=false.
//   - urgent: ignores all prefs; reaches every selected recipient.
//   - promotional (flag): additionally dropped for receiveMarketing=false; email
//     carries a one-click unsubscribe link.

import {
  query,
  mutation,
  action,
  internalAction,
  internalMutation,
} from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";
import { sendTemplateEmail } from "./lib/email";
import { makeUnsubscribeUrl } from "./lib/unsubscribe";

const BATCH = 25; // recipients processed per scheduled slice
// Category passed to sendPushInternal. Not a real per-event category, so
// getPushDeliveryContext reads it as ABSENT → categoryEnabled=true → broadcasts
// are NOT gated by the per-event push toggles (only the kill-switch applies).
const BROADCAST_PUSH_CATEGORY = "broadcast";

type RecipientRow = {
  customerId: string;
  name: string;
  email: string;
  types: string[];
  childNames: string[];
  pushReachable: boolean;
};

// ── Audience resolution (shared with SPEC_INAPP_BANNERS) ──────────────────────
// scope 'all' → every customer / coach account; period scopes → accounts with a
// confirmed booking in [scopeStart, scopeEnd] (YYYY-MM-DD inclusive). Returns one
// deduped row per unique person with reachability + child references.
export const resolveBroadcastAudience = query({
  args: {
    scope: v.string(), // 'day'|'week'|'month'|'range'|'all'
    scopeStart: v.optional(v.string()), // YYYY-MM-DD
    scopeEnd: v.optional(v.string()),
    recipientTypes: v.array(v.string()), // subset of ['customer','coach','athlete']
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const types = new Set(args.recipientTypes);
    if (types.size === 0) return { recipients: [], counts: { total: 0, push: 0, email: 0 } };

    // Reachability inputs (one pass each — small tables in beta).
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const killSwitchOn = settings?.pushEnabledGlobal ?? true;
    const subs = await ctx.db.query("pushSubscriptions").collect();
    const pushEmails = new Set<string>();
    for (const s of subs) pushEmails.add((s.email || "").toLowerCase().trim());
    const reachable = (email: string) =>
      killSwitchOn && pushEmails.has(email.toLowerCase().trim());

    // All customers, indexed by _id and by email (for booker/mate lookups).
    const customers = await ctx.db.query("customers").collect();
    const byId = new Map<string, any>();
    const byEmail = new Map<string, any>();
    for (const c of customers) {
      if ((c as any).deactivatedAt) continue; // skip merged/soft-deleted accounts
      byId.set(c._id, c);
      byEmail.set((c.email || "").toLowerCase().trim(), c);
    }

    const out = new Map<string, RecipientRow>();
    const add = (cust: any, type: string, childName?: string) => {
      if (!cust) return;
      const id = cust._id as string;
      let row = out.get(id);
      if (!row) {
        row = {
          customerId: id,
          name: cust.name || cust.email || "Unknown",
          email: (cust.email || "").toLowerCase().trim(),
          types: [],
          childNames: [],
          pushReachable: reachable(cust.email || ""),
        };
        out.set(id, row);
      }
      if (!row.types.includes(type)) row.types.push(type);
      if (childName && !row.childNames.includes(childName)) row.childNames.push(childName);
    };

    if (args.scope === "all") {
      for (const c of byId.values()) {
        const role = c.role;
        if (types.has("coach") && role === "coach") add(c, "coach");
        // "customer" = any non-coach, non-admin account (incl. legacy 'user').
        if (types.has("customer") && role !== "coach" && role !== "admin") add(c, "customer");
      }
      if (types.has("athlete")) {
        const athletes = await ctx.db.query("athletes").collect();
        for (const a of athletes) {
          const parent = byId.get(a.accountCustomerId as unknown as string);
          if (parent) add(parent, "athlete", a.name);
        }
      }
    } else {
      const start = (args.scopeStart || "").trim();
      const end = (args.scopeEnd || "").trim();
      if (!start || !end) {
        return { recipients: [], counts: { total: 0, push: 0, email: 0 } };
      }
      const bookings = await ctx.db
        .query("bookings")
        .withIndex("by_date", (q: any) => q.gte("date", start).lte("date", end))
        .collect();
      // Athlete-id → athlete row cache for child→parent resolution.
      const athleteCache = new Map<string, any>();
      for (const b of bookings) {
        if (b.status !== "confirmed") continue;
        const booker = byEmail.get((b.customerEmail || "").toLowerCase().trim());
        if ((b as any).isCoachBooking) {
          if (types.has("coach")) add(booker, "coach");
        } else {
          if (types.has("customer")) add(booker, "customer");
          if (types.has("customer") && Array.isArray((b as any).mates)) {
            for (const m of (b as any).mates) {
              add(byId.get(m.customerId as unknown as string), "customer");
            }
          }
        }
        if (types.has("athlete") && Array.isArray((b as any).athleteSlots)) {
          for (const slot of (b as any).athleteSlots) {
            const aid = slot.athleteId as unknown as string | undefined;
            if (!aid) continue; // legacy slots without athleteId can't resolve a parent
            let athlete = athleteCache.get(aid);
            if (athlete === undefined) {
              athlete = await ctx.db.get(aid as any);
              athleteCache.set(aid, athlete);
            }
            if (athlete) {
              const parent = byId.get(athlete.accountCustomerId as unknown as string);
              if (parent) add(parent, "athlete", athlete.name);
            }
          }
        }
      }
    }

    const recipients = Array.from(out.values())
      .filter((r) => r.email)
      .sort((a, b) => a.name.localeCompare(b.name));
    const push = recipients.filter((r) => r.pushReachable).length;
    return {
      recipients,
      counts: { total: recipients.length, push, email: recipients.length - push },
    };
  },
});

// ── Send (admin mutation) ─────────────────────────────────────────────────────
// Takes the EXPLICIT recipient list the admin confirmed (unticked people are
// truly excluded). Applies the tier/promotional pref filter, writes the
// broadcasts row, and schedules the batched fan-out.
export const sendBroadcast = mutation({
  args: {
    title: v.string(),
    body: v.string(),
    link: v.optional(v.string()),
    broadcastType: v.string(), // 'announcement' | 'urgent'
    isPromotional: v.boolean(),
    alsoEmailAll: v.boolean(),
    scope: v.string(),
    scopeStart: v.optional(v.string()),
    scopeEnd: v.optional(v.string()),
    recipientTypes: v.array(v.string()),
    recipients: v.array(
      v.object({
        customerId: v.id("customers"),
        childNames: v.optional(v.array(v.string())),
      })
    ),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const title = args.title.trim();
    const body = args.body.trim();
    if (!title || !body) throw new ConvexError("A title and message are required.");
    if (args.broadcastType !== "announcement" && args.broadcastType !== "urgent") {
      throw new ConvexError("Invalid broadcast type.");
    }
    const isUrgent = args.broadcastType === "urgent";

    // Resolve email + apply the tier/promotional filter per recipient.
    const items: Array<{ email: string; childRef: string }> = [];
    const seen = new Set<string>();
    for (const r of args.recipients) {
      const cust = await ctx.db.get(r.customerId);
      if (!cust || (cust as any).deactivatedAt) continue;
      const email = ((cust as any).email || "").toLowerCase().trim();
      if (!email || seen.has(email)) continue;
      // Tier/promo filtering (urgent ignores everything).
      if (!isUrgent) {
        const pref = await ctx.db
          .query("pushPreferences")
          .withIndex("by_email", (q: any) => q.eq("email", email))
          .first();
        if (pref?.receiveAnnouncements === false) continue; // muted announcements
        if (args.isPromotional && pref?.receiveMarketing === false) continue; // marketing opt-out
      }
      seen.add(email);
      const childRef = (r.childNames ?? []).filter(Boolean).join(", ");
      items.push({ email, childRef });
    }

    if (items.length === 0) {
      throw new ConvexError("No reachable recipients after applying preferences.");
    }

    const broadcastId = await ctx.db.insert("broadcasts", {
      createdBy: (admin as any)._id ?? (admin as any).email ?? "",
      createdByName: (admin as any).name ?? undefined,
      createdAt: Date.now(),
      title,
      body,
      link: args.link?.trim() || undefined,
      broadcastType: args.broadcastType,
      isPromotional: args.isPromotional,
      scope: args.scope,
      scopeStart: args.scopeStart?.trim() || undefined,
      scopeEnd: args.scopeEnd?.trim() || undefined,
      recipientTypes: args.recipientTypes,
      alsoEmailAll: args.alsoEmailAll,
      recipientCount: items.length,
      pushCount: 0,
      emailCount: 0,
      status: "sending",
    });

    await ctx.scheduler.runAfter(0, internal.broadcast.processBroadcastBatch, {
      broadcastId,
      items,
      title,
      body,
      link: args.link?.trim() || undefined,
      isPromotional: args.isPromotional,
      alsoEmailAll: args.alsoEmailAll,
    });

    return { broadcastId, recipientCount: items.length };
  },
});

// ── Batched fan-out (internal action, scheduler-driven) ───────────────────────
export const processBroadcastBatch = internalAction({
  args: {
    broadcastId: v.id("broadcasts"),
    items: v.array(v.object({ email: v.string(), childRef: v.string() })),
    title: v.string(),
    body: v.string(),
    link: v.optional(v.string()),
    isPromotional: v.boolean(),
    alsoEmailAll: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const slice = args.items.slice(0, BATCH);
    const rest = args.items.slice(BATCH);
    let pushCount = 0;
    let emailCount = 0;

    for (const item of slice) {
      const childRef = item.childRef.trim();
      const pushBody = childRef ? `Re: ${childRef}\n${args.body}` : args.body;

      let sentPush = false;
      try {
        const res: any = await ctx.runAction(internal.push.sendPushInternal, {
          email: item.email,
          category: BROADCAST_PUSH_CATEGORY,
          title: args.title,
          body: pushBody,
          url: args.link || "/",
          tag: `broadcast-${args.broadcastId}`,
        });
        sentPush = res?.success === true;
      } catch (e: any) {
        console.error(`[broadcast] push failed for ${item.email}: ${e?.message ?? e}`);
      }
      if (sentPush) pushCount++;

      if (!sentPush || args.alsoEmailAll) {
        const unsubscribeUrl = args.isPromotional ? await makeUnsubscribeUrl(item.email) : "";
        const data: Record<string, string> = {
          title: args.title,
          body: args.body,
          childRef,
        };
        if (args.link) data.link = args.link;
        if (unsubscribeUrl) data.unsubscribeUrl = unsubscribeUrl;
        const r = await sendTemplateEmail("announcement", item.email, data);
        if (r.success) emailCount++;
      }
    }

    await ctx.runMutation(internal.broadcast.bumpBroadcastCounts, {
      broadcastId: args.broadcastId,
      push: pushCount,
      email: emailCount,
    });

    if (rest.length > 0) {
      await ctx.scheduler.runAfter(0, internal.broadcast.processBroadcastBatch, {
        broadcastId: args.broadcastId,
        items: rest,
        title: args.title,
        body: args.body,
        link: args.link,
        isPromotional: args.isPromotional,
        alsoEmailAll: args.alsoEmailAll,
      });
    } else {
      await ctx.runMutation(internal.broadcast.finalizeBroadcast, {
        broadcastId: args.broadcastId,
      });
    }
  },
});

export const bumpBroadcastCounts = internalMutation({
  args: { broadcastId: v.id("broadcasts"), push: v.number(), email: v.number() },
  handler: async (ctx, args) => {
    const b = await ctx.db.get(args.broadcastId);
    if (!b) return;
    await ctx.db.patch(args.broadcastId, {
      pushCount: (b.pushCount ?? 0) + args.push,
      emailCount: (b.emailCount ?? 0) + args.email,
    });
  },
});

export const finalizeBroadcast = internalMutation({
  args: { broadcastId: v.id("broadcasts") },
  handler: async (ctx, args) => {
    const b = await ctx.db.get(args.broadcastId);
    if (!b) return;
    await ctx.db.patch(args.broadcastId, { status: "sent" });
  },
});

// ── Test send to self (admin action) ──────────────────────────────────────────
// Sends the composed message ONLY to the calling admin's own email (push +
// email), bypassing prefs — a preview-in-hand check before the mass send.
export const sendTestBroadcast = action({
  args: {
    title: v.string(),
    body: v.string(),
    link: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Please sign in.");
    const email = (identity.email ?? "").toLowerCase().trim();
    if (!email) throw new ConvexError("Your account has no email on file.");
    const title = args.title.trim() || "Test broadcast";
    const body = args.body.trim() || "(no message)";

    let sentPush = false;
    try {
      const res: any = await ctx.runAction(internal.push.sendPushInternal, {
        email,
        category: BROADCAST_PUSH_CATEGORY,
        title,
        body,
        url: args.link || "/",
        tag: "broadcast-test",
      });
      sentPush = res?.success === true;
    } catch {
      /* fall through to email */
    }
    const data: Record<string, string> = { title, body };
    if (args.link) data.link = args.link;
    const r = await sendTemplateEmail("announcement", email, data);
    return {
      success: sentPush || r.success,
      reason: sentPush || r.success ? undefined : "Could not deliver a test (push + email both unavailable).",
    };
  },
});

// ── History (admin query) ──────────────────────────────────────────────────────
export const listBroadcasts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("broadcasts")
      .withIndex("by_createdAt")
      .order("desc")
      .take(args.limit ?? 50);
    return rows;
  },
});
