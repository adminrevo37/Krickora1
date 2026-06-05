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
import { platformFromEndpoint } from "./lib/analyticsHelpers";

// SPEC_ANALYTICS_BUILD_2026-06 C2.4 — the service worker beacons delivered/clicked
// events back to this Convex deployment's HTTP action. CONVEX_SITE_URL is provided
// automatically by the Convex runtime (the *.convex.site origin).
function pushBeaconUrl(): string | undefined {
  const site = process.env.CONVEX_SITE_URL;
  return site ? `${site}/push/beacon` : undefined;
}

function configureVapid(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@revolutionsports.com.au";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  return true;
}

type PushAction = { action: string; title: string; url?: string };

type Payload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  // SPEC_PUSH_NOTIFICATIONS_V2 §8 — notification action buttons (Android/desktop
  // render them; iOS Safari/PWA ignores them → the body tap is the fallback).
  actions?: PushAction[];
};

// Send one payload to a set of subscriptions; prune dead ones. `meta` (when
// supplied) drives the pushEvents analytics log: one sent/failed/pruned row per
// device, tagged with the recipient + per-device platform (C2.4). The SW beacon
// fields (b=beacon URL, c=category) ride inside the payload so the service worker
// can report delivered/clicked.
async function deliver(
  ctx: any,
  subs: Array<{ id: any; endpoint: string; p256dh: string; auth: string }>,
  payload: Payload,
  meta?: { category?: string; email?: string; tag?: string; log?: boolean }
): Promise<number> {
  const beacon = pushBeaconUrl();
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/",
    tag: payload.tag,
    actions: payload.actions,
    b: beacon,
    c: meta?.category,
  });
  const shouldLog = meta?.log !== false;
  const logEvent = async (type: string, endpoint: string) => {
    if (!shouldLog) return;
    try {
      await ctx.runMutation(internal.pushNotifications.logPushEvent, {
        at: Date.now(),
        type,
        category: meta?.category,
        platform: platformFromEndpoint(endpoint),
        email: meta?.email,
        tag: meta?.tag ?? payload.tag,
      });
    } catch {
      /* logging must never break a send */
    }
  };
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body
      );
      sent++;
      await logEvent("sent", s.endpoint);
    } catch (err: any) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) {
        // Subscription expired/unsubscribed — prune it.
        await ctx.runMutation(internal.pushNotifications.prunePushSubscription, { id: s.id });
        await logEvent("pruned", s.endpoint);
      } else {
        console.error(`[push] send failed (${code ?? "?"}) to ${s.endpoint.slice(0, 40)}…: ${err?.message}`);
        await logEvent("failed", s.endpoint);
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
    actions: v.optional(
      v.array(v.object({ action: v.string(), title: v.string(), url: v.optional(v.string()) }))
    ),
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
      actions: args.actions,
    }, { category: args.category, email: args.email, tag: args.tag });
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
    }, { category: "test-push", email, tag: "test-push" });
    return sent > 0
      ? { success: true, sent }
      : { success: false, reason: "Could not deliver to your devices — they may have expired. Try re-enabling." };
  },
});
