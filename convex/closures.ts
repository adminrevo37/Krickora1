import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";
import { systemCancelBooking } from "./lib/systemCancel";

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

// Count active (non-cancelled) bookings on a date — used to warn the admin
// before a closure auto-cancels them.
export const countActiveBookingsOnDate = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
    return bookings.filter((b) => b.status !== "cancelled").length;
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
      throw new ConvexError("This date is already marked as closed.");
    }

    // Auto-cancel every active booking on that date, auto-credit the customers,
    // and notify them it was a closure (SPEC_ADMIN_AND_SETTINGS #1).
    const adminEmail = (admin as any)?.email ?? undefined;
    const reason = args.reason
      ? `Facility closed: ${args.reason}`
      : "Facility closed on this date";
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();

    const cancelled: any[] = [];
    for (const b of bookings) {
      const summary = await systemCancelBooking(ctx, b, { reason, cancelledByEmail: adminEmail });
      if (summary) cancelled.push(summary);
    }

    const closureId = await ctx.db.insert("closures", {
      date: args.date,
      reason: args.reason,
      createdAt: new Date().toISOString(),
      createdBy: adminEmail,
    });

    const totalCredit = cancelled.reduce((sum, c) => sum + (c.creditIssued ?? 0), 0);
    return {
      closureId,
      cancelledCount: cancelled.length,
      totalCreditIssued: Math.round(totalCredit * 100) / 100,
      cancelled,
    };
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
