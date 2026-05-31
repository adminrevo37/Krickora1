import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";
import { systemCancelBooking, bookingOccupiesLane } from "./lib/systemCancel";

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
    const adminEmail = (admin as any)?.email ?? undefined;

    // Auto-cancel every active booking that overlaps this block (checking the
    // primary lane AND additional lanes; laneId 'all' matches every lane),
    // auto-credit, and notify it was for maintenance (SPEC_ADMIN_AND_SETTINGS #1).
    // Query by date (not by_laneId_date) so multi-lane bookings whose PRIMARY lane
    // differs but which occupy this lane via additionalLaneIds are still caught.
    const dayBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
    const overlapping = dayBookings.filter((b) => {
      if (b.status === "cancelled") return false;
      if (!bookingOccupiesLane(b, args.laneId)) return false;
      const bEnd = b.startHour + b.duration / 60;
      return args.startHour < bEnd && endHour > b.startHour;
    });

    const reason = args.reason
      ? `Lane unavailable (maintenance): ${args.reason}`
      : "Lane unavailable for maintenance";
    const cancelled: any[] = [];
    for (const b of overlapping) {
      const summary = await systemCancelBooking(ctx, b, { reason, cancelledByEmail: adminEmail });
      if (summary) cancelled.push(summary);
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

    const blockId = await ctx.db.insert("laneBlocks", {
      laneId: args.laneId,
      date: args.date,
      startHour: args.startHour,
      duration: args.duration,
      reason: args.reason,
      createdAt: new Date().toISOString(),
      createdBy: adminEmail,
    });

    const totalCredit = cancelled.reduce((sum, c) => sum + (c.creditIssued ?? 0), 0);
    return {
      blockId,
      cancelledCount: cancelled.length,
      totalCreditIssued: Math.round(totalCredit * 100) / 100,
      cancelled,
    };
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
