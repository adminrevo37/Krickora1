/**
 * One-off admin cleanup — hard-delete a CUSTOMER account and every row that
 * references it. Built 2026-06-20 to remove the "Bree Thomas" TEST account
 * (Inspector authorised). Modelled on the table map in accountMerge.ts, but it
 * DELETES instead of repointing.
 *
 * QUIET by design: unlike mutations.deleteBooking it issues NO account credit,
 * sends NO cancellation email, and fires NO push — it just removes data. It
 * DOES delete any Google Calendar events the bookings carry (so no stranded
 * door-code events).
 *
 * SAFETY: requireAdmin; refuses to delete a coach/admin row (customers only);
 * refuses to delete the calling admin's own account; dryRun returns counts with
 * no writes. DESTRUCTIVE + irreversible → always dryRun first, then confirm:true.
 */
import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { components, internal } from "./_generated/api";
import { requireAdminUnlocked, writeRoleAudit } from "./lib/adminGuard";

const norm = (e: string) => (e ?? "").toLowerCase().trim();

// Resolve the Better Auth subject (= identity.subject, stored on bookings.userId).
async function resolveSubject(ctx: any, email: string): Promise<string | null> {
  try {
    const u = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", value: email }],
    });
    return (u as any)?._id ?? null;
  } catch {
    return null;
  }
}

// Hard-delete a Better Auth login (user + its sessions + accounts). Mirrors
// accountMerge.deleteAuthLogin / users.adminDeleteUser. Best-effort.
async function deleteAuthLogin(ctx: any, email: string): Promise<boolean> {
  const authUser = await ctx
    .runQuery(components.betterAuth.adapter.findOne, { model: "user", where: [{ field: "email", value: email }] })
    .catch(() => null);
  if (!authUser) return false;
  const uid = (authUser as any)._id;
  for (const model of ["session", "account"]) {
    try {
      const rows: any = await ctx
        .runQuery(components.betterAuth.adapter.findMany, { model, where: [{ field: "userId", value: uid }] } as any)
        .catch(() => null);
      const list = Array.isArray(rows) ? rows : rows?.page ?? rows?.docs ?? [];
      for (const r of list) {
        await ctx.runMutation(components.betterAuth.adapter.deleteOne, { model, where: [{ field: "_id", value: r._id }] } as any).catch(() => {});
      }
    } catch (e) { console.error(`adminCleanup: clear ${model} failed`, e); }
  }
  try {
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, { model: "user", where: [{ field: "_id", value: uid }] } as any);
  } catch (e) { console.error("adminCleanup: delete auth user failed", e); }
  return true;
}

/**
 * Delete a customer + all referencing rows. dryRun:true (default) returns the
 * counts WITHOUT writing; pass confirm:true to actually delete.
 */
export const adminDeleteCustomerCascade = mutation({
  args: { customerId: v.id("customers"), dryRun: v.optional(v.boolean()), confirm: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    // ADM-5 (audit 2026-06): hard-deletes a customer + all their financial history.
    // Stronger gate than the less-destructive account-merge → require the admin
    // second-factor unlock, and audit the action (below) before any write.
    const admin = await requireAdminUnlocked(ctx);
    const dryRun = args.dryRun !== false && args.confirm !== true; // default to dry-run unless explicitly confirmed

    const cust = await ctx.db.get(args.customerId);
    if (!cust) throw new ConvexError("No customer found with that id.");
    const email = norm((cust as any).email);

    // Safety: never cascade-delete a coach/admin via this tool.
    if ((cust as any).role === "coach" || (cust as any).role === "admin") {
      throw new ConvexError(`Refusing to delete a ${(cust as any).role} account (${email}). This tool is customers-only.`);
    }
    // Safety: don't let an admin delete their own account.
    if (email && email === norm((admin as any).email ?? "")) {
      throw new ConvexError("You cannot delete your own account.");
    }

    const subject = await resolveSubject(ctx, email);

    // ── Collect every referencing row ──────────────────────────────────────
    const bookingsByEmail = await ctx.db.query("bookings").withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", email)).collect();
    const bookingsByUid = subject
      ? await ctx.db.query("bookings").withIndex("by_userId", (q: any) => q.eq("userId", subject)).collect()
      : [];
    const ownBookings = new Map<string, any>();
    for (const b of [...bookingsByEmail, ...bookingsByUid]) ownBookings.set(b._id, b);

    const allBookings = await ctx.db.query("bookings").collect();
    const mateLinkBookings = allBookings.filter(
      (b: any) => !ownBookings.has(b._id) && Array.isArray(b.mates) && b.mates.some((m: any) => m.customerId === args.customerId)
    );

    const athletes = await ctx.db.query("athletes").withIndex("by_account", (q: any) => q.eq("accountCustomerId", args.customerId)).collect();
    const creditLedger = await ctx.db.query("creditLedger").withIndex("by_customerId", (q: any) => q.eq("customerId", args.customerId)).collect();
    const allFriendships = await ctx.db.query("friendships").collect();
    const friendships = allFriendships.filter((f: any) => f.ownerId === args.customerId || f.mateId === args.customerId);
    const allInvites = await ctx.db.query("bookingInvites").collect();
    const bookingInvites = allInvites.filter((i: any) => i.invitedByCustomerId === args.customerId || i.joinedByCustomerId === args.customerId);
    const payments = await ctx.db.query("payments").withIndex("by_coachId", (q: any) => q.eq("coachId", args.customerId)).collect();
    const stripePayments = await ctx.db.query("stripePayments").withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", email)).collect();
    const allWaitlist = await ctx.db.query("waitlist").collect();
    const waitlist = allWaitlist.filter((w: any) => norm(w.userEmail) === email || (subject && w.userId === subject));
    const allWaitlistNotifs = await ctx.db.query("waitlistNotifications").collect().catch(() => []);
    const waitlistNotifications = (allWaitlistNotifs as any[]).filter((n: any) => norm(n.userEmail) === email || (subject && n.userId === subject));
    const allRedemptions = await ctx.db.query("discountRedemptions").collect();
    const discountRedemptions = allRedemptions.filter((r: any) => norm(r.customerEmail) === email);
    const adjCustomer = await ctx.db.query("statementAdjustments").withIndex("by_subject", (q: any) => q.eq("subjectType", "customer").eq("subjectId", args.customerId)).collect();
    const adjCoach = await ctx.db.query("statementAdjustments").withIndex("by_subject", (q: any) => q.eq("subjectType", "coach").eq("subjectId", args.customerId)).collect();
    const adminUnlocks = await ctx.db.query("adminUnlocks").withIndex("by_email", (q: any) => q.eq("email", email)).collect().catch(() => []);
    const pushSubs = await ctx.db.query("pushSubscriptions").withIndex("by_email", (q: any) => q.eq("email", email)).collect();
    const pushPrefs = await ctx.db.query("pushPreferences").withIndex("by_email", (q: any) => q.eq("email", email)).collect();

    const counts = {
      customer: { id: args.customerId, name: (cust as any).name, email, role: (cust as any).role, creditBalance: (cust as any).creditBalance ?? 0, hasLogin: subject != null },
      ownBookings: ownBookings.size,
      gcalEventsToDelete: [...ownBookings.values()].filter((b: any) => b.googleCalendarEventId).length,
      mateLinksToStrip: mateLinkBookings.length,
      athletes: athletes.length,
      creditLedger: creditLedger.length,
      friendships: friendships.length,
      bookingInvites: bookingInvites.length,
      payments: payments.length,
      stripePayments: stripePayments.length,
      waitlist: waitlist.length,
      waitlistNotifications: waitlistNotifications.length,
      discountRedemptions: discountRedemptions.length,
      statementAdjustments: adjCustomer.length + adjCoach.length,
      adminUnlocks: (adminUnlocks as any[]).length,
      pushSubscriptions: pushSubs.length,
      pushPreferences: pushPrefs.length,
    };

    if (dryRun) return { dryRun: true, willDelete: counts };

    // ADM-5: audit the destructive cascade BEFORE any write (best-effort, never blocks).
    await writeRoleAudit(ctx, {
      targetEmail: email,
      field: "accountDeleted",
      oldValue: (cust as any).role ?? "customer",
      newValue: `cascade-delete (${ownBookings.size} bookings, ${athletes.length} athletes)`,
      changedByEmail: (admin as any).email ?? "",
    });

    // ── DELETE (confirm:true) ──────────────────────────────────────────────
    // 1. Google Calendar events on own bookings (best-effort, scheduled).
    for (const b of ownBookings.values()) {
      if ((b as any).googleCalendarEventId) {
        await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
          googleCalendarEventId: (b as any).googleCalendarEventId,
          laneCalendarEventIds: (b as any).googleCalendarEventIds,
        });
      }
    }
    // 2. Own bookings.
    for (const b of ownBookings.values()) await ctx.db.delete(b._id);
    // 3. Strip her out of other people's mate arrays (don't delete their bookings).
    for (const b of mateLinkBookings) {
      const mates = (b.mates as any[]).filter((m: any) => m.customerId !== args.customerId);
      await ctx.db.patch(b._id, { mates });
    }
    // 4. The rest.
    for (const x of athletes) await ctx.db.delete(x._id);
    for (const x of creditLedger) await ctx.db.delete(x._id);
    for (const x of friendships) await ctx.db.delete(x._id);
    for (const x of bookingInvites) await ctx.db.delete(x._id);
    for (const x of payments) await ctx.db.delete(x._id);
    for (const x of stripePayments) await ctx.db.delete(x._id);
    for (const x of waitlist) await ctx.db.delete(x._id);
    for (const x of waitlistNotifications) await ctx.db.delete(x._id);
    for (const x of discountRedemptions) await ctx.db.delete(x._id);
    for (const x of adjCustomer) await ctx.db.delete(x._id);
    for (const x of adjCoach) await ctx.db.delete(x._id);
    for (const x of adminUnlocks as any[]) await ctx.db.delete(x._id);
    for (const x of pushSubs) await ctx.db.delete(x._id);
    for (const x of pushPrefs) await ctx.db.delete(x._id);
    // 5. Better Auth login.
    const loginDeleted = await deleteAuthLogin(ctx, email);
    // 6. The customers row LAST.
    await ctx.db.delete(args.customerId);

    return { dryRun: false, deleted: { ...counts, loginDeleted } };
  },
});
