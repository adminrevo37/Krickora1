"use node";
// SPEC_PWA_PUSH_NOTIFICATIONS §5.3 — Web Push sender (Node action). Signs payloads
// with VAPID and POSTs to each device's push endpoint via the `web-push` package.
// Subscriptions + category prefs + the global kill-switch are read from
// convex/pushNotifications.ts; dead endpoints (404/410) are pruned.
//
// Env (Convex deployment): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// When unset, sendPush no-ops gracefully (like the email path before its key).

import { internalAction, action } from "./_generated/server";
import { DIRECT_ACTION_CATEGORIES } from "./notifications";
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

// PUSH_BACKEND_SPEC (2026-09-05) — a subscription row is now EITHER a Web Push
// device (VAPID crypto, `platform` ABSENT) or a native Expo device
// (`platform === "expo"`, the ExponentPushToken living in `endpoint`).
// ⚠️ Test `=== "expo"`, never `=== "web"`: no existing row carries "web".
type Sub = {
  id: any;
  endpoint: string;
  platform?: string;
  p256dh?: string;
  auth?: string;
};

type LogEvent = (type: string, endpoint: string) => Promise<void>;

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const EXPO_SEND_CHUNK = 100; // Expo's documented maximum messages per request.
const EXPO_ANDROID_CHANNEL_ID = "default"; // MUST match ANDROID_CHANNEL_ID in the app's src/lib/push.ts.

// Optional — only needed if "Push Security" (enhanced security) is switched on
// for the Expo account. Guarded the same way configureVapid() is: absent is a
// supported configuration, not an error.
function expoAuthHeaders(): Record<string, string> {
  const token = process.env.EXPO_ACCESS_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Send one payload to a set of subscriptions; prune dead ones.
 *
 * THE TRANSPORT SPLIT LIVES HERE, not in sendPushInternal — because sendTestPush
 * calls deliver() DIRECTLY. Put the fan-out one level up and the "Send test
 * notification" button silently keeps testing web-only while reporting success.
 *
 * `meta` (when supplied) drives the pushEvents analytics log: one sent/failed/
 * pruned row per device, tagged with the recipient + per-device platform (C2.4).
 */
async function deliver(
  ctx: any,
  subs: Array<Sub>,
  payload: Payload,
  meta?: { category?: string; email?: string; tag?: string; log?: boolean }
): Promise<number> {
  const shouldLog = meta?.log !== false;
  const logEvent: LogEvent = async (type: string, endpoint: string) => {
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

  const webSubs = subs.filter((s) => s.platform !== "expo");
  const expoSubs = subs.filter((s) => s.platform === "expo");

  let sent = 0;
  if (webSubs.length > 0) {
    // VAPID is required only when a WEB device is in the list. Checking it here
    // (rather than before the subscription lookup, as sendPushInternal used to)
    // means a missing VAPID key can no longer block delivery to native devices.
    if (configureVapid()) {
      sent += await deliverWeb(ctx, webSubs, payload, meta?.category, logEvent);
    } else {
      console.log(`[push] VAPID keys not set — skipping ${webSubs.length} web device(s)`);
    }
  }
  if (expoSubs.length > 0) {
    sent += await deliverExpo(ctx, expoSubs, payload, meta, logEvent);
  }
  return sent;
}

/** Web Push (VAPID). Body verbatim as before — the service worker parses the
 *  one-letter b/c keys (b = beacon URL, c = category) to report delivered/clicked. */
async function deliverWeb(
  ctx: any,
  subs: Array<Sub>,
  payload: Payload,
  category: string | undefined,
  logEvent: LogEvent
): Promise<number> {
  const beacon = pushBeaconUrl();
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/",
    tag: payload.tag,
    actions: payload.actions,
    b: beacon,
    c: category,
  });
  let sent = 0;
  for (const s of subs) {
    if (!s.p256dh || !s.auth) {
      // Schema-level p256dh/auth are optional since the native split; a web row
      // missing them is unsendable. subscribePush refuses to create one, so this
      // is a floor, not an expected path.
      console.error(`[push] web sub ${s.endpoint.slice(0, 40)}… has no VAPID keys — skipping`);
      await logEvent("failed", s.endpoint);
      continue;
    }
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

/**
 * Native (Expo) push. PUSH_BACKEND_SPEC §5.
 *
 * ⚠️ A 200 from Expo is ACCEPTANCE, not delivery — real failures surface only in
 * receipts (see checkPushReceipts). We count `status: "ok"` toward `sent` and log
 * a `sent` event, which matches the web path's own semantics ("handed to the push
 * service").
 *
 * Isolation is deliberate at three levels, because Android FCM is not yet
 * provisioned for this project and WILL error per-ticket:
 *   - one failing TICKET never affects the others in its chunk;
 *   - one failing CHUNK never aborts the remaining chunks;
 *   - a network/HTTP failure degrades to `failed` events and never throws out of
 *     deliver(), which would abort the caller's whole mutation/action chain.
 */
async function deliverExpo(
  ctx: any,
  subs: Array<Sub>,
  payload: Payload,
  meta: { category?: string; email?: string; tag?: string; log?: boolean } | undefined,
  logEvent: LogEvent
): Promise<number> {
  const category = meta?.category;
  // Time-critical categories carry the same 15-minute life as the hold they are
  // about; a waitlist offer delivered six hours late is worse than none. The rest
  // get a day — a door code arriving after a phone comes back online still matters.
  const ttl = category && DIRECT_ACTION_CATEGORIES.has(category) ? 15 * 60 : 24 * 60 * 60;

  let sent = 0;
  const tickets: Array<{ ticketId: string; subscriptionId: any; email?: string; category?: string }> = [];

  for (let i = 0; i < subs.length; i += EXPO_SEND_CHUNK) {
    const chunk = subs.slice(i, i + EXPO_SEND_CHUNK);
    const messages = chunk.map((s) => ({
      to: s.endpoint,
      title: payload.title,
      body: payload.body,
      // `data.url` is the client contract: useNotificationTapRouter reads
      // response.notification.request.content.data.url. It MUST be the same
      // tapUrl the web payload gets, or DIRECT_ACTION_CATEGORIES behave
      // differently on the two transports. `actions` is passed through because
      // the app's router already reads it; Expo renders no buttons for it
      // (that needs pre-registered categoryIdentifiers — out of scope).
      data: {
        url: payload.url ?? "/",
        category,
        tag: payload.tag,
        actions: payload.actions,
      },
      sound: "default",
      channelId: EXPO_ANDROID_CHANNEL_ID,
      priority: "high",
      ttl,
    }));

    let json: any = null;
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          ...expoAuthHeaders(),
        },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[push] expo HTTP ${res.status}: ${text.slice(0, 300)}`);
        for (const s of chunk) await logEvent("failed", s.endpoint);
        continue; // next chunk — never abort the whole send
      }
      json = await res.json();
    } catch (err: any) {
      console.error(`[push] expo request failed: ${err?.message ?? err}`);
      for (const s of chunk) await logEvent("failed", s.endpoint);
      continue;
    }

    // One ticket per message, IN REQUEST ORDER.
    const data: any[] = Array.isArray(json?.data) ? json.data : [];
    if (data.length !== chunk.length) {
      console.error(`[push] expo returned ${data.length} tickets for ${chunk.length} messages`);
    }
    for (let k = 0; k < chunk.length; k++) {
      const s = chunk[k];
      const ticket = data[k];
      if (!ticket) {
        await logEvent("failed", s.endpoint);
        continue;
      }
      if (ticket.status === "ok") {
        sent++;
        await logEvent("sent", s.endpoint);
        if (typeof ticket.id === "string" && ticket.id) {
          tickets.push({
            ticketId: ticket.id,
            subscriptionId: s.id,
            email: meta?.email,
            category,
          });
        }
        continue;
      }
      const code = ticket?.details?.error;
      if (code === "DeviceNotRegistered") {
        // Same treatment as a web 404/410: the token is dead, drop the row.
        await ctx.runMutation(internal.pushNotifications.prunePushSubscription, { id: s.id });
        await logEvent("pruned", s.endpoint);
      } else {
        // MessageTooBig / MessageRateExceeded / InvalidCredentials /
        // MismatchSenderId — KEEP the row. The last two are a SERVER
        // misconfiguration (e.g. the missing FCM credential), and pruning a
        // perfectly good token because our own credentials are wrong would be
        // unrecoverable without the user re-enabling notifications by hand.
        console.error(
          `[push] expo ticket error (${code ?? "?"}) for ${s.endpoint.slice(0, 30)}…: ${ticket?.message ?? ""}`
        );
        await logEvent("failed", s.endpoint);
      }
    }
  }

  // Park the accepted tickets so the hourly receipt check can prune tokens that
  // APNs/FCM has retired. Best-effort: a failure here costs a prune, not a send.
  if (tickets.length > 0 && meta?.log !== false) {
    for (let i = 0; i < tickets.length; i += EXPO_SEND_CHUNK) {
      try {
        await ctx.runMutation(internal.pushNotifications.recordPushTicketsInternal, {
          tickets: tickets.slice(i, i + EXPO_SEND_CHUNK),
        });
      } catch (e) {
        console.error("[push] could not record expo tickets", e);
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
    // NOTIFICATIONS INBOX (2026-09-03) — store the message FIRST, delivered or not,
    // so it can be re-read in the app (and email-only accounts get an inbox too).
    let inboxId: string | null = null;
    try {
      inboxId = await ctx.runMutation(internal.notifications.recordInternal, {
        email: args.email,
        title: args.title,
        body: args.body,
        category: args.category,
        url: args.url,
        actions: args.actions,
        tag: args.tag,
      });
    } catch (e) {
      console.error("[push] inbox record failed (continuing with delivery)", e);
    }
    // Tap target: time-sensitive categories keep their direct action (a 15-min
    // hold must not detour through an inbox); everything else opens the message.
    const tapUrl =
      inboxId && !DIRECT_ACTION_CATEGORIES.has(args.category)
        ? `/notifications?n=${inboxId}`
        : args.url;

    // PUSH_BACKEND_SPEC §4a — the VAPID check USED to sit here, ahead of the
    // subscription lookup, and returned { success:false, reason:"not configured" }.
    // That would abort before knowing whether any recipient is native, so it is
    // now inside deliver(), which applies it only to the web half.
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
      url: tapUrl,
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
    // No VAPID gate here either — a native-only account has no web device and
    // must still be able to prove its own push works (§4a).
    const ctxData: { globalEnabled: boolean; subs: Array<Sub> } =
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

// ── PUSH_BACKEND_SPEC §6 — Expo push receipts (the prune path) ────────────────
// Web Push self-cleans: a dead endpoint answers 404/410 at send time. Expo does
// NOT — a token whose app has been uninstalled returns `ok` at send time and only
// reports DeviceNotRegistered in its receipt, which is not available for ~15 min.
// Without this, dead native tokens are never pruned and pushSubscriptions grows
// monotonically. Driven by an hourly cron; silent when there is nothing to read.
const RECEIPT_MIN_AGE_MS = 15 * 60 * 1000; // Expo: receipts are not immediate.
const RECEIPT_GIVE_UP_MS = 6 * 60 * 60 * 1000; // stop retrying an id Expo never returns
const RECEIPT_CHUNK = 1000; // Expo's documented maximum ids per getReceipts call
const RECEIPT_MAX_PASSES = 5;

export const checkPushReceipts = internalAction({
  args: {},
  handler: async (ctx) => {
    let checked = 0;
    let pruned = 0;
    for (let pass = 0; pass < RECEIPT_MAX_PASSES; pass++) {
      const due: Array<{
        id: any;
        ticketId: string;
        subscriptionId: any;
        email?: string;
        category?: string;
        createdAt: number;
      }> = await ctx.runQuery(internal.pushNotifications.listDuePushTicketsInternal, {
        olderThanMs: RECEIPT_MIN_AGE_MS,
        limit: RECEIPT_CHUNK,
      });
      if (due.length === 0) break;

      let receipts: Record<string, any> = {};
      let requestOk = false;
      try {
        const res = await fetch(EXPO_RECEIPTS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
            ...expoAuthHeaders(),
          },
          body: JSON.stringify({ ids: due.map((t) => t.ticketId) }),
        });
        if (res.ok) {
          const json: any = await res.json();
          receipts = (json?.data ?? {}) as Record<string, any>;
          requestOk = true;
        } else {
          const text = await res.text().catch(() => "");
          console.error(`[push] receipts HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
      } catch (err: any) {
        console.error(`[push] receipts request failed: ${err?.message ?? err}`);
      }

      const now = Date.now();
      const toDelete: any[] = [];
      for (const t of due) {
        const r = requestOk ? receipts[t.ticketId] : undefined;
        if (!r) {
          // Expo does not know this id (yet). Retry next hour, but give up after
          // RECEIPT_GIVE_UP_MS so a permanently-unknown id cannot pin the row.
          if (now - t.createdAt > RECEIPT_GIVE_UP_MS) toDelete.push(t.id);
          continue;
        }
        toDelete.push(t.id);
        if (r.status === "error" && r?.details?.error === "DeviceNotRegistered") {
          try {
            await ctx.runMutation(internal.pushNotifications.prunePushSubscription, {
              id: t.subscriptionId,
            });
            pruned++;
            await ctx.runMutation(internal.pushNotifications.logPushEvent, {
              at: Date.now(),
              type: "pruned",
              category: t.category,
              platform: "expo",
              email: t.email,
            });
          } catch (e) {
            console.error("[push] receipt prune failed", e);
          }
        } else if (r.status === "error") {
          // A delivery error that is NOT the token's fault (rate limit, bad
          // credentials). Keep the row; only log it.
          console.error(`[push] receipt error (${r?.details?.error ?? "?"}): ${r?.message ?? ""}`);
        }
      }
      if (toDelete.length > 0) {
        for (let i = 0; i < toDelete.length; i += 100) {
          try {
            await ctx.runMutation(internal.pushNotifications.deletePushTicketsInternal, {
              ids: toDelete.slice(i, i + 100),
            });
          } catch (e) {
            console.error("[push] ticket cleanup failed", e);
          }
        }
      }
      checked += due.length;
      // A short page means the queue is drained for this run.
      if (due.length < RECEIPT_CHUNK) break;
      if (!requestOk) break; // Expo is unreachable — stop, retry next hour.
    }
    return { checked, pruned };
  },
});
