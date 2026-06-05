// SPEC_PWA_PUSH_NOTIFICATIONS — push subscription + preference store (NON-node).
// The actual send (web-push) lives in convex/push.ts ("use node"); this file
// holds the mutations/queries the UI calls plus the internal helpers the node
// action reads. Subscriptions + preferences are keyed by the caller's account
// email (the stable per-person login identity).

import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { isPushCategory } from "./lib/pushCategories";
import { requireAdmin } from "./lib/adminGuard";

// SPEC_PUSH_NOTIFICATIONS_V2 §4 — email slugs auto-silenced the FIRST time an
// account enables push (so the alert arrives via push, not a duplicate email).
// Only flipped if the user hasn't already made an explicit choice for the slug,
// and only once ever (guarded by pushPreferences.pushEmailDefaultsApplied).
const SUPERSEDE_EMAIL_SLUGS = ["mate-alerts", "athlete-allocation", "coach-allocation"];

async function requireEmail(ctx: any): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Please sign in.");
  const email = (identity.email ?? "").toLowerCase().trim();
  if (!email) throw new ConvexError("Your account has no email on file.");
  return email;
}

// ── Subscribe this device (called after the OS push permission is granted) ────
export const subscribePush = mutation({
  args: {
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    deviceLabel: v.string(),
  },
  handler: async (ctx, args) => {
    const email = await requireEmail(ctx);
    const identity = await ctx.auth.getUserIdentity();
    const now = Date.now();
    // SPEC_PUSH_NOTIFICATIONS_V2 §4 — did this account have ANY subscribed device
    // before this call? If not, this is its first-ever push-enable → run the
    // one-time email auto-off after the insert succeeds.
    const priorSubs = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .collect();
    const isFirstEverEnable = priorSubs.length === 0;
    // Upsert by endpoint (re-subscribing the same device refreshes its keys).
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q: any) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        email,
        userId: identity?.subject,
        p256dh: args.p256dh,
        auth: args.auth,
        deviceLabel: args.deviceLabel,
        lastSeenAt: now,
      });
      return existing._id;
    }
    const insertedId = await ctx.db.insert("pushSubscriptions", {
      email,
      userId: identity?.subject,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      deviceLabel: args.deviceLabel,
      createdAt: now,
      lastSeenAt: now,
    });
    // §4 — first device ever for this account: silence the superseded emails once.
    if (isFirstEverEnable) {
      await ctx.scheduler.runAfter(0, internal.pushNotifications.applyPushSupersedesEmailDefaults, {
        email,
      });
    }
    return insertedId;
  },
});

// SPEC_PUSH_NOTIFICATIONS_V2 §4 — one-time auto-off. Disable the superseded email
// slugs for `email`, but ONLY those the user hasn't explicitly set, and ONLY once
// (guarded by pushPreferences.pushEmailDefaultsApplied). Idempotent + best-effort.
export const applyPushSupersedesEmailDefaults = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim();
    if (!email) return;

    // Once-only guard lives on the pushPreferences row.
    const pref = await ctx.db
      .query("pushPreferences")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (pref?.pushEmailDefaultsApplied) return;

    // Patch the customer's emailPrefs: add a disabled entry for each superseded
    // slug that has no explicit pref yet (never clobber a deliberate user choice).
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (customer) {
      const prefs: Array<{ slug: string; enabled: boolean }> = [
        ...(customer.emailPrefs ?? []),
      ];
      let changed = false;
      for (const slug of SUPERSEDE_EMAIL_SLUGS) {
        if (!prefs.some((p) => p.slug === slug)) {
          prefs.push({ slug, enabled: false });
          changed = true;
        }
      }
      if (changed) await ctx.db.patch(customer._id, { emailPrefs: prefs });
    }

    // Set the once-only guard (create the prefs row if it doesn't exist yet).
    if (pref) {
      await ctx.db.patch(pref._id, { pushEmailDefaultsApplied: true });
    } else {
      await ctx.db.insert("pushPreferences", {
        email,
        categories: {},
        pushEmailDefaultsApplied: true,
      });
    }
  },
});

// ── Remove a device (by endpoint) — only the owner can ────────────────────────
export const unsubscribePush = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const email = await requireEmail(ctx);
    const sub = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q: any) => q.eq("endpoint", args.endpoint))
      .first();
    if (sub && sub.email === email) {
      await ctx.db.delete(sub._id);
      return true;
    }
    return false;
  },
});

// ── The caller's subscribed devices (for the profile device list) ─────────────
export const listMyPushDevices = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = (identity?.email ?? "").toLowerCase().trim();
    if (!email) return [];
    const subs = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .collect();
    return subs.map((s) => ({
      endpoint: s.endpoint,
      deviceLabel: s.deviceLabel,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
    }));
  },
});

// ── The caller's per-category preferences (absent = ON) ───────────────────────
export const getMyPushPreferences = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = (identity?.email ?? "").toLowerCase().trim();
    if (!email) return {};
    const pref = await ctx.db
      .query("pushPreferences")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    return (pref?.categories ?? {}) as Record<string, boolean>;
  },
});

export const setMyPushPreference = mutation({
  args: { key: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const email = await requireEmail(ctx);
    if (!isPushCategory(args.key)) throw new ConvexError("Unknown notification category.");
    const existing = await ctx.db
      .query("pushPreferences")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    const next = { ...(existing?.categories ?? {}), [args.key]: args.enabled };
    if (existing) {
      await ctx.db.patch(existing._id, { categories: next });
    } else {
      await ctx.db.insert("pushPreferences", { email, categories: next });
    }
    return true;
  },
});

// ── Broadcast opt-outs (SPEC_ADMIN_BROADCAST §5) ──────────────────────────────
// receiveAnnouncements / receiveMarketing live on the same pushPreferences row.
// Absent = opted in (true). These affect BOTH push and email broadcast channels.

export const getMyAnnouncementPrefs = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = (identity?.email ?? "").toLowerCase().trim();
    if (!email) return { receiveAnnouncements: true, receiveMarketing: true };
    const pref = await ctx.db
      .query("pushPreferences")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    return {
      receiveAnnouncements: pref?.receiveAnnouncements !== false,
      receiveMarketing: pref?.receiveMarketing !== false,
    };
  },
});

export const setMyAnnouncementPref = mutation({
  args: { key: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const email = await requireEmail(ctx);
    if (args.key !== "receiveAnnouncements" && args.key !== "receiveMarketing") {
      throw new ConvexError("Unknown announcement preference.");
    }
    const existing = await ctx.db
      .query("pushPreferences")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { [args.key]: args.enabled });
    } else {
      await ctx.db.insert("pushPreferences", {
        email,
        categories: {},
        [args.key]: args.enabled,
      });
    }
    return true;
  },
});

// Unsubscribe-from-marketing setter (called by the /unsubscribe HTTP route after
// it verifies the email's token). Sets receiveMarketing=false by email; creates a
// prefs row if none exists. Best-effort, never throws.
export const setReceiveMarketingByEmailInternal = internalMutation({
  args: { email: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim();
    if (!email) return false;
    const existing = await ctx.db
      .query("pushPreferences")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { receiveMarketing: args.enabled });
    } else {
      await ctx.db.insert("pushPreferences", {
        email,
        categories: {},
        receiveMarketing: args.enabled,
      });
    }
    return true;
  },
});

// ── Internal helpers used by the node send action ─────────────────────────────

// Resolve everything the send action needs for one recipient+category in a
// single read: kill-switch, the category pref, and the recipient's devices.
export const getPushDeliveryContext = internalQuery({
  args: { email: v.string(), category: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim();
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const globalEnabled = settings?.pushEnabledGlobal ?? true;

    const pref = await ctx.db
      .query("pushPreferences")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    const cat = (pref?.categories ?? {}) as Record<string, boolean>;
    // Absent key = ON.
    const categoryEnabled = cat[args.category] !== false;

    const subs = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .collect();

    return {
      globalEnabled,
      categoryEnabled,
      subs: subs.map((s) => ({
        id: s._id,
        endpoint: s.endpoint,
        p256dh: s.p256dh,
        auth: s.auth,
      })),
    };
  },
});

// Just the caller's own devices + kill-switch (for the test-push button, which
// bypasses category prefs).
export const getMyPushDevicesInternal = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim();
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const subs = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .collect();
    return {
      // The test button bypasses the global kill-switch (explicit user action),
      // so we return it only for context; the action ignores it for tests.
      globalEnabled: settings?.pushEnabledGlobal ?? true,
      subs: subs.map((s) => ({ id: s._id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth })),
    };
  },
});

// Emails of all admins (for admin-ops fan-out).
export const getAdminPushEmails = internalQuery({
  args: {},
  handler: async (ctx) => {
    const admins = await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", "admin"))
      .collect();
    return admins.map((a) => a.email.toLowerCase().trim()).filter(Boolean);
  },
});

// SPEC_PUSH_NOTIFICATIONS_V2 §3.4 — one-time migration. Default the session-
// reminder EMAIL off for every existing account that hasn't explicitly set it
// (the 22-min push now replaces it). Idempotent: skips rows that already carry a
// booking-reminder pref. Run once from the admin app after deploy.
export const migratePushV2Defaults = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const customers = await ctx.db.query("customers").collect();
    let patched = 0;
    for (const c of customers) {
      const prefs: Array<{ slug: string; enabled: boolean }> = c.emailPrefs ?? [];
      if (prefs.some((p) => p.slug === "booking-reminder")) continue;
      await ctx.db.patch(c._id, {
        emailPrefs: [...prefs, { slug: "booking-reminder", enabled: false }],
      });
      patched++;
    }
    return { customersScanned: customers.length, patched };
  },
});

// Prune a dead subscription (called by the node action on a 404/410).
export const prunePushSubscription = internalMutation({
  args: { id: v.id("pushSubscriptions") },
  handler: async (ctx, args) => {
    const s = await ctx.db.get(args.id);
    if (s) await ctx.db.delete(args.id);
    return true;
  },
});
