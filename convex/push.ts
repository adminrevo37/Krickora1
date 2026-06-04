"use node";
// SPEC_PWA_PUSH_NOTIFICATIONS §5.3 — Web Push sender (Node action). Signs payloads
// with VAPID and POSTs to each device's push endpoint via the `web-push` package.
// Subscriptions + category prefs + the global kill-switch are read from
// convex/pushNotifications.ts; dead endpoints (404/410) are pruned.
//
// Env (Convex deployment): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// When unset, sendPush no-ops gracefully (like the email path before its key).

import { internalAction, action } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import webpush from "web-push";

function configureVapid(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@revolutionsports.com.au";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  return true;
}

type Payload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

// Send one payload to a set of subscriptions; prune dead ones.
async function deliver(
  ctx: any,
  subs: Array<{ id: any; endpoint: string; p256dh: string; auth: string }>,
  payload: Payload
): Promise<number> {
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/",
    tag: payload.tag,
  });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body
      );
      sent++;
    } catch (err: any) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) {
        // Subscription expired/unsubscribed — prune it.
        await ctx.runMutation(internal.pushNotifications.prunePushSubscription, { id: s.id });
      } else {
        console.error(`[push] send failed (${code ?? "?"}) to ${s.endpoint.slice(0, 40)}…: ${err?.message}`);
      }
    }
  }
  return sent;
}

// ── Core helper: push one category event to one recipient (by email) ──────────
export const sendPushInternal = internalAction({
  args: {
    email: v.string(),
    category: v.string(),
    title: v.string(),
    body: v.string(),
    url: v.optional(v.string()),
    tag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!configureVapid()) {
      console.log("[push] VAPID keys not set — skipping send");
      return { success: false, reason: "not configured" };
    }
    const c = await ctx.runQuery(internal.pushNotifications.getPushDeliveryContext, {
      email: args.email,
      category: args.category,
    });
    if (!c.globalEnabled) return { success: false, reason: "push disabled globally" };
    if (!c.categoryEnabled) return { success: false, reason: "category off" };
    if (c.subs.length === 0) return { success: false, reason: "no devices" };
    const sent = await deliver(ctx, c.subs, {
      title: args.title,
      body: args.body,
      url: args.url,
      tag: args.tag,
    });
    return { success: sent > 0, sent };
  },
});

// ── Admin-ops fan-out: push to every admin's devices ──────────────────────────
export const sendAdminPush = internalAction({
  args: {
    title: v.string(),
    body: v.string(),
    url: v.optional(v.string()),
    tag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const emails: string[] = await ctx.runQuery(internal.pushNotifications.getAdminPushEmails, {});
    for (const email of emails) {
      await ctx.runAction(internal.push.sendPushInternal, {
        email,
        category: "admin-ops",
        title: args.title,
        body: args.body,
        url: args.url,
        tag: args.tag,
      });
    }
    return { success: true, admins: emails.length };
  },
});

// ── Test push (§5.6) — immediate, to the caller's own devices; bypasses category
// prefs + the global kill-switch (explicit user-initiated test). ──────────────
export const sendTestPush = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; sent?: number; reason?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Please sign in.");
    const email = (identity.email ?? "").toLowerCase().trim();
    if (!email) throw new ConvexError("Your account has no email on file.");
    if (!configureVapid()) {
      return { success: false, reason: "Push is not configured on the server yet." };
    }
    const ctxData: { globalEnabled: boolean; subs: Array<{ id: any; endpoint: string; p256dh: string; auth: string }> } =
      await ctx.runQuery(internal.pushNotifications.getMyPushDevicesInternal, { email });
    if (ctxData.subs.length === 0) {
      return { success: false, reason: "No subscribed devices — enable notifications on this device first." };
    }
    const sent = await deliver(ctx, ctxData.subs, {
      title: "Cricket Revolution",
      body: "✓ Push notifications are working.",
      url: "/profile",
      tag: "test-push",
    });
    return sent > 0
      ? { success: true, sent }
      : { success: false, reason: "Could not deliver to your devices — they may have expired. Try re-enabling." };
  },
});
