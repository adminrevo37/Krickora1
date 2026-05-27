/**
 * User management mutations — admin-only operations.
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";

export const makeAdmin = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const normalizedEmail = email.toLowerCase().trim();
    const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", value: normalizedEmail }],
    });
    if (!authUser) throw new Error(`No auth user found with email "${normalizedEmail}".`);
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: { model: "user", where: [{ field: "_id", value: authUser._id }], update: { role: "admin" } as any },
    });
    const customer = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", normalizedEmail)).first();
    if (customer) await ctx.db.patch(customer._id, { role: "admin" });
    return { success: true, message: `${normalizedEmail} is now an admin.` };
  },
});

export const adminChangeEmail = mutation({
  args: { currentEmail: v.string(), newEmail: v.string() },
  handler: async (ctx, { currentEmail, newEmail }) => {
    await requireAdmin(ctx);
    const oldE = currentEmail.toLowerCase().trim();
    const newE = newEmail.toLowerCase().trim();
    const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user", where: [{ field: "email", value: oldE }],
    });
    if (authUser) {
      try {
        await ctx.runMutation(components.betterAuth.adapter.updateOne, {
          input: { model: "user", where: [{ field: "_id", value: authUser._id }], update: { email: newE } as any },
        });
      } catch (err) {
        console.error("Failed to update auth user email:", err);
      }
    }
    const customer = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", oldE)).first();
    if (customer) await ctx.db.patch(customer._id, { email: newE });
    return { success: true };
  },
});

export const adminUpdateUserProfile = mutation({
  args: { email: v.string(), name: v.optional(v.string()), phone: v.optional(v.string()), role: v.optional(v.string()), coachTier: v.optional(v.string()), color: v.optional(v.string()) },
  handler: async (ctx, { email, name, phone, role, coachTier, color }) => {
    await requireAdmin(ctx);
    const normalizedEmail = email.toLowerCase().trim();
    // Sync name to Better Auth user record — wrapped in try/catch so an adapter
    // failure doesn't prevent the customer record from being updated.
    if (name !== undefined) {
      try {
        const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "user", where: [{ field: "email", value: normalizedEmail }],
        });
        if (authUser) {
          await ctx.runMutation(components.betterAuth.adapter.updateOne, {
            input: { model: "user", where: [{ field: "_id", value: authUser._id }], update: { name: name.trim() } as any },
          });
        }
      } catch (e) {
        console.error("adminUpdateUserProfile: failed to sync name to auth user:", e);
      }
    }
    const customer = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", normalizedEmail)).first();
    if (customer) {
      const updates: Record<string, any> = {};
      if (name !== undefined) updates.name = name.trim();
      if (phone !== undefined) updates.phone = phone.trim() || undefined;
      if (role !== undefined) updates.role = role;
      if (coachTier !== undefined) updates.coachTier = coachTier || undefined;
      if (color !== undefined) updates.color = color || undefined;
      if (Object.keys(updates).length > 0) await ctx.db.patch(customer._id, updates);
    }
    return { success: true };
  },
});

export const adminDeleteUser = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const admin = await requireAdmin(ctx);
    const normalizedEmail = email.toLowerCase().trim();
    if (admin.email?.toLowerCase?.().trim?.() === normalizedEmail) {
      throw new Error("You cannot delete your own account.");
    }
    // Delete from customers table
    const customer = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", normalizedEmail)).first();
    if (customer) await ctx.db.delete(customer._id);
    // Delete waitlist entries
    const waitlistEntries = await ctx.db.query("waitlist").collect();
    for (const w of waitlistEntries) {
      if (w.userEmail?.toLowerCase?.() === normalizedEmail) await ctx.db.delete(w._id);
    }
    // Delete waitlist notifications
    const waitlistNotifs = await ctx.db.query("waitlistNotifications").collect();
    for (const n of waitlistNotifs) {
      if (n.userEmail?.toLowerCase?.() === normalizedEmail) await ctx.db.delete(n._id);
    }
    // Delete from Better Auth — find user, then delete sessions/accounts one-by-one, then user
    const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user", where: [{ field: "email", value: normalizedEmail }],
    });
    if (authUser) {
      try {
        // Delete sessions for this user
        try {
          const sessions: any = await ctx.runQuery(components.betterAuth.adapter.findMany, {
            model: "session",
            where: [{ field: "userId", value: authUser._id }],
          } as any);
          const sessionList = Array.isArray(sessions) ? sessions : (sessions?.docs ?? []);
          for (const s of sessionList) {
            await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
              model: "session", where: [{ field: "_id", value: s._id }],
            } as any).catch(() => {});
          }
        } catch (e) {
          console.error("Failed to clear sessions:", e);
        }
        // Delete accounts for this user
        try {
          const accounts: any = await ctx.runQuery(components.betterAuth.adapter.findMany, {
            model: "account",
            where: [{ field: "userId", value: authUser._id }],
          } as any);
          const accountList = Array.isArray(accounts) ? accounts : (accounts?.docs ?? []);
          for (const a of accountList) {
            await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
              model: "account", where: [{ field: "_id", value: a._id }],
            } as any).catch(() => {});
          }
        } catch (e) {
          console.error("Failed to clear accounts:", e);
        }
        // Delete the user record
        await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
          model: "user", where: [{ field: "_id", value: authUser._id }],
        } as any);
      } catch (err) {
        console.error("Failed to delete auth user:", err);
      }
    }
    return { success: true };
  },
});

export const setCoachColor = mutation({
  args: { email: v.string(), color: v.string() },
  handler: async (ctx, { email, color }) => {
    await requireAdmin(ctx);
    const normalizedEmail = email.toLowerCase().trim();
    const customer = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", normalizedEmail)).first();
    if (!customer) throw new Error("User not found");
    await ctx.db.patch(customer._id, { color });
    return { success: true };
  },
});
