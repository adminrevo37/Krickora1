import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const getUpcomingBookingsForWeek = internalQuery({
  args: { startDate: v.string(), endDate: v.string() },
  handler: async (ctx, args) => {
    // COST-8/INT-2 (audit 2026-06): read only the requested week via the by_date
    // index instead of scanning the whole (ever-growing) bookings table. `date` is a
    // zero-padded YYYY-MM-DD string, so lexicographic range == chronological range.
    return await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.gte("date", args.startDate).lte("date", args.endDate))
      .collect();
  },
});

export const getAllCustomersWithEmail = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("customers").collect();
  },
});
