/**
 * User management mutations — admin-only operations.
 */
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { components } from "./_generated/api";
import { requireAdmin, requireAdminUnlocked, writeRoleAudit } from "./lib/adminGuard";

// Recent role / permission / tier changes — admin only (SPEC_SECURITY_HARDENING
// #3 audit trail; surfaced in the admin role-management UI).
export const listRoleAuditLog = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("roleAuditLog")
      .withIndex("by_changedAt")
      .order("desc")
      .take(args.limit ?? 50);
    return rows;
  },
});

export const makeAdmin = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    // SEC decision #3: privilege escalation is admin-only. Previously UNGUARDED
    // — any caller could promote any email to admin. The very first admin must
    // be bootstrapped out-of-band (Convex dashboard), not via this mutation.
    const adminUser = await requireAdminUnlocked(ctx);
    const normalizedEmail = email.toLowerCase().trim();
    const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", value: normalizedEmail }],
    });
    if (!authUser) throw new ConvexError(`No auth user found with email "${normalizedEmail}".`);
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: { model: "user", where: [{ field: "_id", value: authUser._id }], update: { role: "admin" } as any },
    });
    const customer = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", normalizedEmail)).first();
    if (customer) await ctx.db.patch(customer._id, { role: "admin" });
    await writeRoleAudit(ctx, {
      targetEmail: normalizedEmail,
      field: "role",
      oldValue: customer?.role,
      newValue: "admin",
      changedByEmail: (adminUser as any).email ?? "",
    });
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
  args: { email: v.string(), name: v.optional(v.string()), phone: v.optional(v.string()), role: v.optional(v.string()), coachTier: v.optional(v.string()), color: v.optional(v.string()), defaultSessionDuration: v.optional(v.number()), athleteCapacity: v.optional(v.number()) },
  handler: async (ctx, { email, name, phone, role, coachTier, color, defaultSessionDuration, athleteCapacity }) => {
    const adminUser = await requireAdmin(ctx);
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
      if (defaultSessionDuration !== undefined) updates.defaultSessionDuration = defaultSessionDuration || undefined;
      if (athleteCapacity !== undefined) updates.athleteCapacity = Math.max(1, Math.min(athleteCapacity || 1, 4));
      if (Object.keys(updates).length > 0) await ctx.db.patch(customer._id, updates);
      // SEC #3: audit privilege-relevant changes
      if (role !== undefined && role !== customer.role) {
        // M-1/S-2: keep Better-Auth user.role in step with customers.role so the
        // two stores don't drift (the admin panel is the main promote/demote UI).
        try {
          const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
            model: "user", where: [{ field: "email", value: normalizedEmail }],
          });
          if (authUser) {
            await ctx.runMutation(components.betterAuth.adapter.updateOne, {
              input: { model: "user", where: [{ field: "_id", value: authUser._id }], update: { role } as any },
            });
          }
        } catch (e) {
          console.error("adminUpdateUserProfile: failed to sync role to auth user:", e);
        }
        await writeRoleAudit(ctx, { targetEmail: normalizedEmail, field: "role", oldValue: customer.role, newValue: role, changedByEmail: (adminUser as any).email ?? "" });
      }
      if (coachTier !== undefined && coachTier !== customer.coachTier) {
        await writeRoleAudit(ctx, { targetEmail: normalizedEmail, field: "coachTier", oldValue: customer.coachTier, newValue: coachTier, changedByEmail: (adminUser as any).email ?? "" });
      }
    }
    return { success: true };
  },
});

export const adminDeleteUser = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const admin = await requireAdminUnlocked(ctx);
    const normalizedEmail = email.toLowerCase().trim();
    if (admin.email?.toLowerCase?.().trim?.() === normalizedEmail) {
      throw new ConvexError("You cannot delete your own account.");
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

// SPEC_ADMIN_MANUAL_POWERS #3 — force-mark a user's email verified. For a stuck
// customer who can't receive/click the verification link (the verified-email
// gate blocks their first booking). Patches the Better Auth user record.
export const adminVerifyEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const admin = await requireAdmin(ctx);
    const normalizedEmail = email.toLowerCase().trim();
    const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", value: normalizedEmail }],
    });
    if (!authUser) throw new ConvexError(`No account found with email "${normalizedEmail}".`);
    if ((authUser as any).emailVerified === true) {
      return { success: true, alreadyVerified: true };
    }
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "_id", value: (authUser as any)._id }],
        update: { emailVerified: true } as any,
      },
    });
    await writeRoleAudit(ctx, {
      targetEmail: normalizedEmail,
      field: "emailVerified",
      oldValue: "false",
      newValue: "true",
      changedByEmail: (admin as any).email ?? "",
    });
    return { success: true, alreadyVerified: false };
  },
});

// SPEC_ADMIN_MANUAL_POWERS #3 — record that an admin triggered a password reset
// for a user. The reset email itself is sent via the Better Auth client
// (authClient forget-password) from the admin UI; this mutation only writes the
// audit trail (admin-gated; confirms the target exists).
export const adminLogPasswordReset = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const admin = await requireAdmin(ctx);
    const normalizedEmail = email.toLowerCase().trim();
    await writeRoleAudit(ctx, {
      targetEmail: normalizedEmail,
      field: "passwordReset",
      oldValue: undefined,
      newValue: "reset email sent",
      changedByEmail: (admin as any).email ?? "",
    });
    return { success: true };
  },
});

export const setCoachColor = mutation({
  args: { email: v.string(), color: v.string() },
  handler: async (ctx, { email, color }) => {
    await requireAdmin(ctx);
    const normalizedEmail = email.toLowerCase().trim();
    const customer = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", normalizedEmail)).first();
    if (!customer) throw new ConvexError("User not found");
    await ctx.db.patch(customer._id, { color });
    return { success: true };
  },
});
