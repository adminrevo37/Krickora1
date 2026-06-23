import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, getAuthUserSafe, resolveIsAdmin } from "./lib/adminGuard";
import { Id } from "./_generated/dataModel";

// ============================================================================
// GOOGLE CALENDAR TOKEN MUTATIONS (internal - used by googleCalendar.ts)
// ============================================================================

export const saveTokens = internalMutation({
  args: {
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(),
    calendarId: v.string(),
    connectedEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert("googleCalendarTokens", {
      key: "default",
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      expiresAt: args.expiresAt,
      calendarId: args.calendarId,
      connectedEmail: args.connectedEmail,
      connectedAt: new Date().toISOString(),
    });
  },
});

export const getTokens = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
  },
});

export const updateAccessToken = internalMutation({
  args: {
    accessToken: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        accessToken: args.accessToken,
        expiresAt: args.expiresAt,
      });
    }
  },
});

export const deleteTokens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const setCalendarId = internalMutation({
  args: { calendarId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        calendarId: args.calendarId,
      });
    }
  },
});

export const setBookingCalendarEventId = internalMutation({
  args: {
    bookingId: v.string(),
    googleCalendarEventId: v.string(),
  },
  handler: async (ctx, args) => {
    // INT-1 (audit 2026-06): bookingId is always a stringified bookings _id, so a
    // direct get replaces the full-table scan this ran on every calendar create/sync.
    const target = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (target) {
      await ctx.db.patch(target._id, {
        googleCalendarEventId: args.googleCalendarEventId,
      });
    }
  },
});

export const setBookingLaneCalendarEventIds = internalMutation({
  args: {
    bookingId: v.string(),
    eventEntries: v.array(
      v.object({
        laneId: v.string(),
        calendarId: v.string(),
        eventId: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    // INT-1 (audit 2026-06): direct get instead of a full-table scan.
    const target = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (target) {
      const existing = target.googleCalendarEventIds ?? [];
      const merged = [...existing];
      for (const entry of args.eventEntries) {
        const idx = merged.findIndex(e => e.laneId === entry.laneId);
        if (idx >= 0) merged[idx] = entry;
        else merged.push(entry);
      }
      await ctx.db.patch(target._id, {
        googleCalendarEventIds: merged,
      });
    }
  },
});

// ============================================================================
// LANE CALENDAR MAPPING MUTATIONS — ADMIN ONLY
// ============================================================================

export const setLaneCalendarMapping = mutation({
  args: {
    laneId: v.string(),
    calendarId: v.string(),
    calendarName: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("laneCalendarMappings")
      .withIndex("by_laneId", (q: any) => q.eq("laneId", args.laneId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        calendarId: args.calendarId,
        calendarName: args.calendarName,
      });
      return existing._id;
    }
    return await ctx.db.insert("laneCalendarMappings", {
      laneId: args.laneId,
      calendarId: args.calendarId,
      calendarName: args.calendarName,
    });
  },
});

export const removeLaneCalendarMapping = mutation({
  args: { laneId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("laneCalendarMappings")
      .withIndex("by_laneId", (q: any) => q.eq("laneId", args.laneId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

// Admin-only (audit 2026-06-10 security #7): leaks every lane's Google Calendar
// ID. Non-throwing (returns [] for non-admins) so it's safe to subscribe from any
// context; only the admin calendar-settings page needs the data.
export const listLaneCalendarMappings = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthUserSafe(ctx);
    if (!(await resolveIsAdmin(ctx, (user as any)?.email))) return [];
    return await ctx.db.query("laneCalendarMappings").collect();
  },
});

// Internal version for actions
export const getLaneCalendarMappingsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("laneCalendarMappings").collect();
  },
});

// Get all active (non-cancelled) bookings for bulk sync
export const getAllActiveBookings = internalQuery({
  args: {},
  handler: async (ctx) => {
    // INT-7 (audit 2026-06): read only confirmed rows via by_status instead of
    // scanning the entire table (incl. every cancelled/past row) then JS-filtering.
    return await ctx.db
      .query("bookings")
      .withIndex("by_status", (q: any) => q.eq("status", "confirmed"))
      .collect();
  },
});

// ============================================================================
// PUBLIC QUERIES
// ============================================================================

// Admin-only (audit 2026-06-10 security #7): exposes the connected Google account
// email + calendar ID. Non-throwing — returns the disconnected shape for
// non-admins so any subscriber renders safely; only the admin settings page uses it.
export const isConnected = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthUserSafe(ctx);
    if (!(await resolveIsAdmin(ctx, (user as any)?.email))) {
      return { connected: false, email: null, calendarId: null, connectedAt: null };
    }
    const tokens = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (!tokens) return { connected: false, email: null, calendarId: null, connectedAt: null };
    return {
      connected: true,
      email: tokens.connectedEmail,
      calendarId: tokens.calendarId,
      connectedAt: tokens.connectedAt,
    };
  },
});
