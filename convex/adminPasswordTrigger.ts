import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";

// Admin-gated trigger that schedules the password set. Schedules the INTERNAL
// action (a scheduled action has no auth identity, so it cannot call the
// admin-gated public wrapper).
export const triggerSetPassword = mutation({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.scheduler.runAfter(0, internal.adminPassword.setPasswordInternal, args);
    return { scheduled: true };
  },
});
