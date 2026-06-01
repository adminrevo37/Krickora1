import { query, mutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";
import { PRICE_DEFAULTS } from "./lib/priceDefaults";

export const isRegistrationLocked = query({
  args: {},
  handler: async (ctx) => {
    const s = await ctx.db.query("siteSettings").withIndex("by_key", (q: any) => q.eq("key", "global")).first();
    return !!(s as any)?.registrationLocked;
  },
});

export const isRegistrationLockedInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const s = await ctx.db.query("siteSettings").withIndex("by_key", (q: any) => q.eq("key", "global")).first();
    return !!(s as any)?.registrationLocked;
  },
});

export const findCustomerByEmailInternal = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const c = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", email)).first();
    return c ? { _id: c._id, email: c.email } : null;
  },
});

export const setRegistrationLocked = mutation({
  args: { locked: v.boolean() },
  handler: async (ctx, { locked }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.query("siteSettings").withIndex("by_key", (q: any) => q.eq("key", "global")).first();
    if (existing) {
      await ctx.db.patch(existing._id, { registrationLocked: locked });
      return existing._id;
    }
    return await ctx.db.insert("siteSettings", {
      key: "global",
      customerPricePerHour: PRICE_DEFAULTS.customerPerHour,
      customerPrice90Min: 55,
      trumanPricePerHour: PRICE_DEFAULTS.trumanPerHour,
      trumanPrice90Min: 70,
      coachPer30Min: PRICE_DEFAULTS.coachPer30Min,
      coachPerHour: PRICE_DEFAULTS.coachPerHour,
      cancellationHoursBefore: 2,
      openingHour: 7,
      closingHour: 21,
      minBookingNoticeMinutes: 10,
      coachBookingWindowDays: 7,
      customerOpenDay: "sunday",
      customerOpenHour: 19,
      registrationLocked: locked,
    });
  },
});
