/**
 * Admin second-factor gate (SPEC_SECURITY_HARDENING #2).
 *
 * On entering /admin, the admin re-enters their OWN account password
 * (verifyAdminPassword, in adminGateActions.ts — "use node"). On success an
 * `adminUnlocks` row is written with a TTL (siteSettings.adminUnlockMinutes).
 * Sensitive admin mutations call requireAdminUnlocked (lib/adminGuard.ts).
 *
 * The whole gate is inert unless siteSettings.adminGateEnabled === true, so it
 * can ship before the UI prompt without locking anyone out.
 *
 * NOTE: queries can't read the clock — getAdminGateStatus returns expiresAt and
 * the client decides if it's still valid (Date.now() < expiresAt).
 */
import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";

// Client polls this to decide whether to show the unlock prompt.
export const getAdminGateStatus = query({
  args: {},
  handler: async (ctx) => {
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const enabled = settings?.adminGateEnabled === true;
    const caller = await getCallerContext(ctx);
    if (!caller.identity || !caller.isAdmin || !caller.email) {
      return { enabled, expiresAt: null as number | null };
    }
    const unlock = await ctx.db
      .query("adminUnlocks")
      .withIndex("by_email", (q: any) => q.eq("email", caller.email))
      .first();
    return { enabled, expiresAt: unlock?.expiresAt ?? null };
  },
});

// Explicit lock (e.g. "Lock admin" button / on sign-out).
export const lockAdmin = mutation({
  args: {},
  handler: async (ctx) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity || !caller.email) return { success: false };
    const unlock = await ctx.db
      .query("adminUnlocks")
      .withIndex("by_email", (q: any) => q.eq("email", caller.email))
      .first();
    if (unlock) await ctx.db.delete(unlock._id);
    return { success: true };
  },
});

// Written by verifyAdminPassword (action) after a successful password check.
export const recordAdminUnlockInternal = internalMutation({
  args: { email: v.string(), expiresAt: v.number() },
  handler: async (ctx, { email, expiresAt }) => {
    const existing = await ctx.db
      .query("adminUnlocks")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (existing) await ctx.db.patch(existing._id, { expiresAt });
    else await ctx.db.insert("adminUnlocks", { email, expiresAt });
  },
});

// Read by verifyAdminPassword (action) — actions have no ctx.db.
export const getAdminGateConfigInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    return {
      adminUnlockMinutes: settings?.adminUnlockMinutes ?? 45,
      adminGateEnabled: settings?.adminGateEnabled === true,
    };
  },
});
