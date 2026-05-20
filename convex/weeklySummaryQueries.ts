import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const getUpcomingBookingsForWeek = internalQuery({
  args: { startDate: v.string(), endDate: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("bookings").collect();
    return all.filter((b) => b.date >= args.startDate && b.date <= args.endDate);
  },
});

export const getAllCustomersWithEmail = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("customers").collect();
  },
});
