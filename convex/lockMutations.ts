import { mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireAdminUnlocked } from "./lib/adminGuard";
import { Id } from "./_generated/dataModel";

// ============================================================================
// LOCK CODE MUTATIONS (internal - used by locks.ts actions)
// ============================================================================

export const createLockCode = internalMutation({
  args: {
    bookingId: v.string(),
    accessCode: v.string(),
    deviceIds: v.array(v.string()),
    seamAccessCodeIds: v.array(v.string()),
    status: v.string(),
    startsAt: v.string(),
    endsAt: v.string(),
    customerName: v.string(),
    customerEmail: v.string(),
    laneId: v.string(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Remove any existing lock code for this booking
    const existing = await ctx.db
      .query("lockCodes")
      .withIndex("by_bookingId", (q: any) => q.eq("bookingId", args.bookingId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }

    return await ctx.db.insert("lockCodes", {
      bookingId: args.bookingId,
      accessCode: args.accessCode,
      deviceIds: args.deviceIds,
      seamAccessCodeIds: args.seamAccessCodeIds,
      status: args.status,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      laneId: args.laneId,
      createdAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      errorMessage: args.errorMessage,
    });
  },
});

export const updateLockCodeStatus = internalMutation({
  args: {
    bookingId: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("lockCodes")
      .withIndex("by_bookingId", (q: any) => q.eq("bookingId", args.bookingId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        lastSyncAt: new Date().toISOString(),
      });
    }
  },
});

export const updateBookingLockStatus = internalMutation({
  args: {
    bookingId: v.string(),
    lockSyncStatus: v.string(),
  },
  handler: async (ctx, args) => {
    // ADM-3 (audit 2026-06): bookingId is a stringified bookings _id — direct get
    // instead of a full-table scan on every lock-status update.
    const target = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (target) {
      await ctx.db.patch(target._id, {
        lockSyncStatus: args.lockSyncStatus,
      });
    }
  },
});

export const getLockCodeByBooking = internalQuery({
  args: { bookingId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("lockCodes")
      .withIndex("by_bookingId", (q: any) => q.eq("bookingId", args.bookingId))
      .first();
  },
});

export const getDeviceMappingsByLane = internalQuery({
  args: { laneId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("lockDeviceMappings")
      .withIndex("by_laneId", (q: any) => q.eq("laneId", args.laneId))
      .collect();
  },
});

export const getLockSettings = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("lockSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
  },
});

// ============================================================================
// PUBLIC MUTATIONS (for admin UI) — ADMIN ONLY
// ============================================================================

export const saveLockSettings = mutation({
  args: {
    provider: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    codeLeadTimeMinutes: v.optional(v.number()),
    codeTrailTimeMinutes: v.optional(v.number()),
    defaultDeviceIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireAdminUnlocked(ctx); // ADM-2: physical-access config → second-factor
    const existing = await ctx.db
      .query("lockSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();

    const defaults = {
      key: "global" as const,
      provider: "seam",
      enabled: false,
      codeLeadTimeMinutes: 15,
      codeTrailTimeMinutes: 15,
      defaultDeviceIds: [] as string[],
    };

    if (existing) {
      const updates = Object.fromEntries(
        Object.entries(args).filter(([_, v]) => v !== undefined)
      );
      await ctx.db.patch(existing._id, updates);
      return existing._id;
    } else {
      const merged = {
        ...defaults,
        ...Object.fromEntries(
          Object.entries(args).filter(([_, v]) => v !== undefined)
        ),
      };
      return await ctx.db.insert("lockSettings", merged);
    }
  },
});

export const setLaneDeviceMapping = mutation({
  args: {
    laneId: v.string(),
    deviceId: v.string(),
    deviceName: v.string(),
    lockBrand: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdminUnlocked(ctx); // ADM-2: physical-access config → second-factor
    const existing = await ctx.db
      .query("lockDeviceMappings")
      .withIndex("by_laneId", (q: any) => q.eq("laneId", args.laneId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        deviceId: args.deviceId,
        deviceName: args.deviceName,
        lockBrand: args.lockBrand,
      });
      return existing._id;
    }
    return await ctx.db.insert("lockDeviceMappings", {
      laneId: args.laneId,
      deviceId: args.deviceId,
      deviceName: args.deviceName,
      lockBrand: args.lockBrand,
    });
  },
});

export const removeLaneDeviceMapping = mutation({
  args: { laneId: v.string() },
  handler: async (ctx, args) => {
    await requireAdminUnlocked(ctx); // ADM-2: physical-access config → second-factor
    const existing = await ctx.db
      .query("lockDeviceMappings")
      .withIndex("by_laneId", (q: any) => q.eq("laneId", args.laneId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

// ============================================================================
// PUBLIC QUERIES (for admin UI) — ADMIN ONLY
// ============================================================================

export const getLockSettingsPublic = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("lockSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
  },
});

export const listLaneDeviceMappings = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("lockDeviceMappings").collect();
  },
});

export const listLockCodes = mutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const codes = await ctx.db.query("lockCodes").order("desc").collect();
    return codes.slice(0, args.limit ?? 50);
  },
});
