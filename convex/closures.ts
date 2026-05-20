import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";

// List all closures
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("closures").collect();
  },
});

// List closures from today forward
export const listUpcoming = query({
  args: {},
  handler: async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const all = await ctx.db.query("closures").collect();
    return all
      .filter((c) => c.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

// Check if a specific date is closed
export const isClosed = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    const found = await ctx.db
      .query("closures")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .first();
    return found !== null;
  },
});

export const addClosure = mutation({
  args: {
    date: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);

    // Prevent duplicates
    const existing = await ctx.db
      .query("closures")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .first();
    if (existing) {
      throw new Error("This date is already marked as closed.");
    }

    // Check for active bookings on that date
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
    const activeCount = bookings.filter((b) => b.status !== "cancelled").length;
    if (activeCount > 0) {
      throw new Error(
        `Cannot close this date — there ${activeCount === 1 ? "is" : "are"} ${activeCount} active booking${activeCount === 1 ? "" : "s"}. Cancel them first.`
      );
    }

    return await ctx.db.insert("closures", {
      date: args.date,
      reason: args.reason,
      createdAt: new Date().toISOString(),
      createdBy: (admin as any)?.email ?? undefined,
    });
  },
});

export const removeClosure = mutation({
  args: { id: v.id("closures") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return true;
  },
});
