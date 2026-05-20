import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

export const triggerSetPassword = mutation({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, api.adminPassword.adminSetPassword, args);
    return { scheduled: true };
  },
});
