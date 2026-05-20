import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";

// List lane blocks for a given date
export const listByDate = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("laneBlocks")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
  },
});

// List all lane blocks (admin view)
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("laneBlocks").collect();
  },
});

export const addLaneBlock = mutation({
  args: {
    laneId: v.string(),
    date: v.string(),
    startHour: v.number(),
    duration: v.number(), // minutes
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const endHour = args.startHour + args.duration / 60;

    // Conflict check against existing bookings
    const laneBookings = await ctx.db
      .query("bookings")
      .withIndex("by_laneId_date", (q: any) =>
        q.eq("laneId", args.laneId).eq("date", args.date)
      )
      .collect();
    const hasBookingConflict = laneBookings.some((b) => {
      if (b.status === "cancelled") return false;
      const bEnd = b.startHour + b.duration / 60;
      return args.startHour < bEnd && endHour > b.startHour;
    });
    if (hasBookingConflict) {
      throw new Error("Cannot block this lane — there is an existing booking during this time.");
    }

    // Conflict check against other blocks
    const existingBlocks = await ctx.db
      .query("laneBlocks")
      .withIndex("by_laneId_date", (q: any) => q.eq("laneId", args.laneId).eq("date", args.date))
      .collect();
    const hasBlockConflict = existingBlocks.some((b) => {
      const bEnd = b.startHour + b.duration / 60;
      return args.startHour < bEnd && endHour > b.startHour;
    });
    if (hasBlockConflict) {
      throw new Error("This time range overlaps an existing lane block.");
    }

    return await ctx.db.insert("laneBlocks", {
      laneId: args.laneId,
      date: args.date,
      startHour: args.startHour,
      duration: args.duration,
      reason: args.reason,
      createdAt: new Date().toISOString(),
      createdBy: (admin as any)?.email ?? undefined,
    });
  },
});

export const removeLaneBlock = mutation({
  args: { id: v.id("laneBlocks") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return true;
  },
});
