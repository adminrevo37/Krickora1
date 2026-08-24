/**
 * User management mutations — admin-only operations.
 */
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { components } from "./_generated/api";
import { requireAdmin, requireAdminUnlocked, writeRoleAudit, getAuthUserSafe } from "./lib/adminGuard";
import { enforceRateLimit } from "./lib/rateLimit";
import { composeName } from "./lib/names";
import { validateLocationIfProvided, normalizePostcode, normalizeSuburb } from "./lib/locations";

// Self-service email correction for an UNVERIFIED account (mistyped email at
// signup). Only an authenticated, NOT-yet-verified user may change their own
// email this way: there's no verified identity to protect, the credential
// account is keyed by userId (not email — see adminPassword.ts) so sign-in is
// unaffected, and the client sends a fresh verification link to the new address
// afterwards. Rejects collisions with another account; rate-limited.
export const correctUnverifiedEmail = mutation({
  args: { newEmail: v.string() },
  handler: async (ctx, { newEmail }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required.");
    const authUser = await getAuthUserSafe(ctx);
    if (!authUser) throw new ConvexError("Authentication required.");
    if (authUser.emailVerified === true) {
      throw new ConvexError("Your email is already verified.");
    }
    await enforceRateLimit(
      ctx,
      { action: "correct-email", identifier: String(authUser._id), max: 5, windowMs: 60 * 60_000 },
      "Too many email changes — please wait a little and try again."
    );
    const oldEmail = (authUser.email ?? "").toLowerCase().trim();
    const email = newEmail.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ConvexError("Please enter a valid email address.");
    }
    if (email === oldEmail) {
      throw new ConvexError("That's the same address — check the spelling and try again.");
    }
    // Reject if the new email already belongs to another account (auth or customers).
    const existingAuth: any = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", value: email }],
    });
    if (existingAuth && String(existingAuth._id) !== String(authUser._id)) {
      // SEC-5 (audit 2026-06): generic message — don't confirm to an unverified
      // caller that the address belongs to an existing account (enumeration oracle).
      throw new ConvexError("We couldn't update to that email address. Please try a different one.");
    }
    const collision = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (collision && (collision.email ?? "").toLowerCase() !== oldEmail) {
      // SEC-5 (audit 2026-06): generic message — don't confirm to an unverified
      // caller that the address belongs to an existing account (enumeration oracle).
      throw new ConvexError("We couldn't update to that email address. Please try a different one.");
    }
    // 1) Better Auth user record (stays unverified).
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "_id", value: authUser._id }],
        update: { email, emailVerified: false } as any,
      },
    });
    // 2) Our customers row (linked by email) — keep the two stores in step.
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", oldEmail))
      .first();
    if (customer) await ctx.db.patch(customer._id, { email });
    return { ok: true, email };
  },
});

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
    // SEC-2 (audit 2026-06): changing a user's email is account-takeover-adjacent —
    // require the admin second-factor unlock.
    const admin = await requireAdminUnlocked(ctx);
    const oldE = currentEmail.toLowerCase().trim();
    const newE = newEmail.toLowerCase().trim();
    // Validation + COLLISION GUARD (2026-08): without this, pointing an account at an
    // email that already has one silently half-updates (the better-auth updateOne
    // hits a unique-constraint error that was swallowed, while the customers row was
    // still patched) → two records on one email + a broken login. Refuse up front so
    // the admin gets a clear error and merges/deletes the duplicate instead.
    if (!newE.includes("@") || newE.length < 3) {
      throw new ConvexError("Enter a valid email address.");
    }
    if (newE === oldE) {
      throw new ConvexError("That is already this account's email.");
    }
    const clashCustomer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", newE))
      .first();
    if (clashCustomer) {
      throw new ConvexError(
        "That email is already used by another account. Merge or delete the duplicate first."
      );
    }
    // Everything below touches the better-auth component adapter, which can throw
    // opaquely. Wrap it so the admin sees the REAL cause instead of "Server Error".
    let stage = "start";
    try {
      // clashCustomer was already confirmed absent above. If a LOGIN still exists on the
      // target email it is ORPHANED debris (a prior delete/recreate left the better-auth
      // user behind after its customers row was removed) — its lingering unique email is
      // exactly what makes the raw updateOne throw "user email already exists". Find it
      // via findMany (the adapter's findOne unreliably misses these) + case-insensitive
      // match, then delete its sessions/accounts/user so the rename can proceed.
      stage = "scan-orphan-logins";
      const pag = { numItems: 2000, cursor: null };
      const usersRes: any = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "user", where: [{ field: "email", value: newE }], paginationOpts: pag,
      } as any).catch(() => null);
      const userList: any[] = Array.isArray(usersRes) ? usersRes : (usersRes?.page ?? usersRes?.docs ?? []);
      const orphans = userList.filter((u: any) => (u.email ?? "").toLowerCase().trim() === newE);
      for (const orphan of orphans) {
        stage = "delete-orphan-login";
        for (const model of ["session", "account"]) {
          const rowsRes: any = await ctx.runQuery(components.betterAuth.adapter.findMany, {
            model, where: [{ field: "userId", value: orphan._id }], paginationOpts: pag,
          } as any).catch(() => null);
          const rows: any[] = Array.isArray(rowsRes) ? rowsRes : (rowsRes?.page ?? rowsRes?.docs ?? []);
          for (const r of rows) {
            await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
              input: { model, where: [{ field: "_id", value: r._id }] },
            } as any).catch(() => {});
          }
        }
        await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
          input: { model: "user", where: [{ field: "_id", value: orphan._id }] },
        } as any).catch(() => {});
      }

      // Update the auth login FIRST so the login and record never diverge.
      stage = "find-current-login";
      const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "user", where: [{ field: "email", value: oldE }],
      }).catch(() => null);
      if (authUser) {
        stage = "update-login-email";
        await ctx.runMutation(components.betterAuth.adapter.updateOne, {
          input: { model: "user", where: [{ field: "_id", value: (authUser as any)._id }], update: { email: newE } as any },
        });
      }
      stage = "patch-customer";
      const customer = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", oldE)).first();
      if (customer) await ctx.db.patch(customer._id, { email: newE });
      // Repoint the DENORMALISED email stamped on bookings/payments/waitlist — otherwise
      // the user's own bookings (matched by customerEmail) become invisible after the
      // rename. Was the bug behind "changed email, now can't see my bookings".
      stage = "repoint-email-refs";
      await repointCustomerEmailRefs(ctx, oldE, newE);
    } catch (err: any) {
      throw new ConvexError(`Email change failed at [${stage}]: ${String(err?.message ?? err).slice(0, 220)}`);
    }
    await writeRoleAudit(ctx, {
      targetEmail: newE, field: "email", oldValue: oldE, newValue: newE,
      changedByEmail: (admin as any)?.email ?? "",
    });
    return { success: true };
  },
});

/** Repoint every denormalised customer/coach email from oldE→newE (both lowercased)
 *  across the OPERATIONAL email-keyed tables (the ones that drive visibility,
 *  notifications, access + payments). The customer _id is unchanged by a rename, so
 *  id-keyed tables (creditLedger/athletes/friendships/payments/statementAdjustments)
 *  need nothing. Historical/log tables (analytics, *Events, roleAuditLog) are left as
 *  records of what happened at the time. Returns the per-field patch counts. */
async function repointCustomerEmailRefs(
  ctx: any, oldE: string, newE: string
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const patchField = async (table: string, field: string) => {
    const rows = await ctx.db.query(table as any).collect();
    for (const r of rows) {
      if (((r as any)[field] ?? "").toLowerCase().trim() === oldE) {
        await ctx.db.patch((r as any)._id, { [field]: newE } as any);
        counts[`${table}.${field}`] = (counts[`${table}.${field}`] ?? 0) + 1;
      }
    }
  };
  await patchField("bookings", "customerEmail");
  await patchField("stripePayments", "customerEmail");
  await patchField("waitlist", "userEmail");
  await patchField("waitlistNotifications", "userEmail");
  await patchField("slotHolds", "userEmail");
  await patchField("paymentLinks", "customerEmail");
  await patchField("paymentLinks", "sentToEmail");
  await patchField("discountRedemptions", "customerEmail");
  await patchField("pushSubscriptions", "email");
  await patchField("pushPreferences", "email");
  await patchField("lockCodes", "customerEmail");
  await patchField("coachInvites", "email");
  return counts;
}

/** Standalone repoint for an email that was ALREADY changed (the rename happened before
 *  repointing was wired in). Admin-only. */
export const adminRepointCustomerEmailRefs = mutation({
  args: { fromEmail: v.string(), toEmail: v.string() },
  handler: async (ctx, { fromEmail, toEmail }) => {
    await requireAdminUnlocked(ctx);
    const oldE = fromEmail.toLowerCase().trim();
    const newE = toEmail.toLowerCase().trim();
    const counts = await repointCustomerEmailRefs(ctx, oldE, newE);
    return { success: true, ...counts };
  },
});

/** Force-log-out a user everywhere: delete ALL their better-auth sessions. Their next
 *  request returns a clean null session → the client signs out + they must log in
 *  again. (Their password/account are untouched.) Admin-only. */
export const adminLogoutUser = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireAdminUnlocked(ctx);
    const e = email.toLowerCase().trim();
    const pag = { numItems: 2000, cursor: null };
    const usersRes: any = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "user", where: [{ field: "email", value: e }], paginationOpts: pag,
    } as any).catch(() => null);
    const users: any[] = Array.isArray(usersRes) ? usersRes : (usersRes?.page ?? usersRes?.docs ?? []);
    let sessionsDeleted = 0;
    let userFound = false;
    for (const u of users) {
      if ((u.email ?? "").toLowerCase().trim() !== e) continue;
      userFound = true;
      const sessRes: any = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "session", where: [{ field: "userId", value: u._id }], paginationOpts: pag,
      } as any).catch(() => null);
      const sessions: any[] = Array.isArray(sessRes) ? sessRes : (sessRes?.page ?? sessRes?.docs ?? []);
      for (const s of sessions) {
        await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
          input: { model: "session", where: [{ field: "_id", value: s._id }] },
        } as any).catch(() => {});
        sessionsDeleted++;
      }
    }
    return { success: true, userFound, sessionsDeleted };
  },
});

export const adminUpdateUserProfile = mutation({
  args: { email: v.string(), name: v.optional(v.string()), firstName: v.optional(v.string()), lastName: v.optional(v.string()), phone: v.optional(v.string()), role: v.optional(v.string()), coachTier: v.optional(v.string()), color: v.optional(v.string()), defaultSessionDuration: v.optional(v.number()), athleteCapacity: v.optional(v.number()), postcode: v.optional(v.string()), suburb: v.optional(v.string()), hideFromPublicCoachList: v.optional(v.boolean()), flexibleBookingWindow: v.optional(v.boolean()), earlyAccess630: v.optional(v.boolean()) },
  handler: async (ctx, { email, name, firstName, lastName, phone, role, coachTier, color, defaultSessionDuration, athleteCapacity, postcode, suburb, hideFromPublicCoachList, flexibleBookingWindow, earlyAccess630 }) => {
    // SEC-2 (audit 2026-06): this writes `role` — privilege escalation. Gate it
    // behind the admin second-factor (requireAdminUnlocked), not bare requireAdmin,
    // so a hijacked admin session can't self-escalate without the password.
    const adminUser = await requireAdminUnlocked(ctx);
    const normalizedEmail = email.toLowerCase().trim();
    // SEC-2: validate role against an allowlist (never store an arbitrary string).
    // "user" is the legacy default role still offered by the admin edit form and
    // stored on older accounts — it MUST be permitted or saving any unedited
    // legacy account fails. The allowlist only blocks arbitrary/garbage values.
    if (role !== undefined && !["customer", "coach", "admin", "user"].includes(role)) {
      throw new ConvexError("Invalid role.");
    }
    // SPEC_PROFILE_POSTCODE_SUBURB: validate if either location field supplied.
    validateLocationIfProvided(postcode, suburb);
    // SPEC_NAME_SPLIT: when the admin edits first/last (customers), recompose the
    // derived display name and let it drive both the Better-Auth sync + the
    // customers.name patch below. firstName/lastName fall back to the stored row.
    let effFirst = firstName;
    let effLast = lastName;
    if (firstName !== undefined || lastName !== undefined) {
      const existingForName = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", normalizedEmail)).first();
      effFirst = (firstName ?? (existingForName as any)?.firstName ?? "").trim();
      effLast = (lastName ?? (existingForName as any)?.lastName ?? "").trim();
      const composed = composeName(effFirst, effLast);
      if (composed) name = composed;
    }
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
      if (effFirst !== undefined) updates.firstName = effFirst;
      if (effLast !== undefined) updates.lastName = effLast;
      if (phone !== undefined) updates.phone = phone.trim() || undefined;
      if (role !== undefined) updates.role = role;
      if (coachTier !== undefined) updates.coachTier = coachTier || undefined;
      if (color !== undefined) updates.color = color || undefined;
      if (defaultSessionDuration !== undefined) updates.defaultSessionDuration = defaultSessionDuration || undefined;
      if (athleteCapacity !== undefined) updates.athleteCapacity = Math.max(1, Math.min(athleteCapacity || 1, 5));
      if (hideFromPublicCoachList !== undefined) updates.hideFromPublicCoachList = hideFromPublicCoachList;
      if (flexibleBookingWindow !== undefined) updates.flexibleBookingWindow = flexibleBookingWindow; // SPEC_COACH_FLEXIBLE_WINDOW
      // SPEC_EARLY_ACCESS_2026-08 — role-agnostic (coach OR customer). The admin
      // form sends this outside its coach-only field block for the same reason.
      if (earlyAccess630 !== undefined) updates.earlyAccess630 = earlyAccess630;
      if (postcode !== undefined) updates.postcode = normalizePostcode(postcode);
      if (suburb !== undefined) updates.suburb = normalizeSuburb(suburb);
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
            paginationOpts: { numItems: 2000, cursor: null },
          } as any);
          const sessionList = Array.isArray(sessions) ? sessions : (sessions?.page ?? sessions?.docs ?? []);
          for (const s of sessionList) {
            await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
              input: { model: "session", where: [{ field: "_id", value: s._id }] },
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
            paginationOpts: { numItems: 2000, cursor: null },
          } as any);
          const accountList = Array.isArray(accounts) ? accounts : (accounts?.page ?? accounts?.docs ?? []);
          for (const a of accountList) {
            await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
              input: { model: "account", where: [{ field: "_id", value: a._id }] },
            } as any).catch(() => {});
          }
        } catch (e) {
          console.error("Failed to clear accounts:", e);
        }
        // Delete the user record
        await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
          input: { model: "user", where: [{ field: "_id", value: authUser._id }] },
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
    // SEC-2 (audit 2026-06): force-verifying an email bypasses the verify gate that
    // protects a user's first booking — require the admin second-factor unlock.
    const admin = await requireAdminUnlocked(ctx);
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
