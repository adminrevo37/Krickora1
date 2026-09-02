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
        .runQuery(components.betterAuth.adapter.findMany, { model, where: [{ field: "userId", value: uid }], paginationOpts: { numItems: 2000, cursor: null } } as any)
        .catch(() => null);
      const list = Array.isArray(rows) ? rows : rows?.page ?? rows?.docs ?? [];
      for (const r of list) {
        await ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model, where: [{ field: "_id", value: r._id }] } } as any).catch(() => {});
      }
    } catch (e) { console.error(`adminCleanup: clear ${model} failed`, e); }
  }
  try {
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model: "user", where: [{ field: "_id", value: uid }] } } as any);
  } catch (e) { console.error("adminCleanup: delete auth user failed", e); }
  return true;
}

/**
 * Collect every row that references a customer. Shared by the cascade delete and
 * the "strip history, keep the account" variant (2026-09-02 OPS-4 purge).
 */
async function collectCustomerRefs(ctx: any, customerId: any, email: string, subject: string | null) {
  const bookingsByEmail = await ctx.db.query("bookings").withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", email)).collect();
  const bookingsByUid = subject
    ? await ctx.db.query("bookings").withIndex("by_userId", (q: any) => q.eq("userId", subject)).collect()
    : [];
  const ownBookings = new Map<string, any>();
  for (const b of [...bookingsByEmail, ...bookingsByUid]) ownBookings.set(b._id, b);

  const allBookings = await ctx.db.query("bookings").collect();
  const mateLinkBookings = allBookings.filter(
    (b: any) => !ownBookings.has(b._id) && Array.isArray(b.mates) && b.mates.some((m: any) => m.customerId === customerId)
  );

  const athletes = await ctx.db.query("athletes").withIndex("by_account", (q: any) => q.eq("accountCustomerId", customerId)).collect();
  const creditLedger = await ctx.db.query("creditLedger").withIndex("by_customerId", (q: any) => q.eq("customerId", customerId)).collect();
  const allFriendships = await ctx.db.query("friendships").collect();
  const friendships = allFriendships.filter((f: any) => f.ownerId === customerId || f.mateId === customerId);
  const allInvites = await ctx.db.query("bookingInvites").collect();
  const bookingInvites = allInvites.filter((i: any) => i.invitedByCustomerId === customerId || i.joinedByCustomerId === customerId);
  const payments = await ctx.db.query("payments").withIndex("by_coachId", (q: any) => q.eq("coachId", customerId)).collect();
  const stripePayments = await ctx.db.query("stripePayments").withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", email)).collect();
  const allWaitlist = await ctx.db.query("waitlist").collect();
  const waitlist = allWaitlist.filter((w: any) => norm(w.userEmail) === email || (subject && w.userId === subject));
  const allWaitlistNotifs = await ctx.db.query("waitlistNotifications").collect().catch(() => []);
  const waitlistNotifications = (allWaitlistNotifs as any[]).filter((n: any) => norm(n.userEmail) === email || (subject && n.userId === subject));
  const allRedemptions = await ctx.db.query("discountRedemptions").collect();
  const discountRedemptions = allRedemptions.filter((r: any) => norm(r.customerEmail) === email);
  const adjCustomer = await ctx.db.query("statementAdjustments").withIndex("by_subject", (q: any) => q.eq("subjectType", "customer").eq("subjectId", customerId)).collect();
  const adjCoach = await ctx.db.query("statementAdjustments").withIndex("by_subject", (q: any) => q.eq("subjectType", "coach").eq("subjectId", customerId)).collect();
  const adminUnlocks = await ctx.db.query("adminUnlocks").withIndex("by_email", (q: any) => q.eq("email", email)).collect().catch(() => []);
  const pushSubs = await ctx.db.query("pushSubscriptions").withIndex("by_email", (q: any) => q.eq("email", email)).collect();
  const pushPrefs = await ctx.db.query("pushPreferences").withIndex("by_email", (q: any) => q.eq("email", email)).collect();

  return { ownBookings, mateLinkBookings, athletes, creditLedger, friendships, bookingInvites, payments, stripePayments, waitlist, waitlistNotifications, discountRedemptions, adjCustomer, adjCoach, adminUnlocks: adminUnlocks as any[], pushSubs, pushPrefs };
}

/** Delete the bookings (+ their calendar events) in `ownBookings`. */
async function deleteOwnBookings(ctx: any, ownBookings: Map<string, any>) {
  for (const b of ownBookings.values()) {
    if ((b as any).googleCalendarEventId) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
        googleCalendarEventId: (b as any).googleCalendarEventId,
        laneCalendarEventIds: (b as any).googleCalendarEventIds,
      });
    }
  }
  for (const b of ownBookings.values()) await ctx.db.delete(b._id);
}

/**
 * Cascade-delete a customer + all referencing rows. The public mutation below
 * wraps this with the admin gate + audit; the 2026-09-02 OPS-4 purge called it
 * from a temporary token-gated mutation with allowCoach for the test coach.
 */
export async function cascadeDeleteCustomer(
  ctx: any,
  opts: { customerId: any; confirm: boolean; allowCoach?: boolean; adminEmail?: string }
) {
  const cust = await ctx.db.get(opts.customerId);
  if (!cust) throw new ConvexError("No customer found with that id.");
  const email = norm((cust as any).email);
  if (!opts.allowCoach && ((cust as any).role === "coach" || (cust as any).role === "admin")) {
    throw new ConvexError(`Refusing to delete a ${(cust as any).role} account (${email}). This tool is customers-only.`);
  }
  if ((cust as any).role === "admin") throw new ConvexError("Refusing to delete an admin account.");
  if (opts.adminEmail && email && email === norm(opts.adminEmail)) {
    throw new ConvexError("You cannot delete your own account.");
  }
  const subject = await resolveSubject(ctx, email);
  const r = await collectCustomerRefs(ctx, opts.customerId, email, subject);

  const counts = {
    customer: { id: opts.customerId, name: (cust as any).name, email, role: (cust as any).role, creditBalance: (cust as any).creditBalance ?? 0, hasLogin: subject != null },
    ownBookings: r.ownBookings.size,
    gcalEventsToDelete: [...r.ownBookings.values()].filter((b: any) => b.googleCalendarEventId).length,
    mateLinksToStrip: r.mateLinkBookings.length,
    athletes: r.athletes.length,
    creditLedger: r.creditLedger.length,
    friendships: r.friendships.length,
    bookingInvites: r.bookingInvites.length,
    payments: r.payments.length,
    stripePayments: r.stripePayments.length,
    waitlist: r.waitlist.length,
    waitlistNotifications: r.waitlistNotifications.length,
    discountRedemptions: r.discountRedemptions.length,
    statementAdjustments: r.adjCustomer.length + r.adjCoach.length,
    adminUnlocks: r.adminUnlocks.length,
    pushSubscriptions: r.pushSubs.length,
    pushPreferences: r.pushPrefs.length,
  };
  if (!opts.confirm) return { dryRun: true as const, willDelete: counts };

  await writeRoleAudit(ctx, {
    targetEmail: email,
    field: "accountDeleted",
    oldValue: (cust as any).role ?? "customer",
    newValue: `cascade-delete (${r.ownBookings.size} bookings, ${r.athletes.length} athletes)`,
    changedByEmail: opts.adminEmail ?? "system",
  });

  await deleteOwnBookings(ctx, r.ownBookings);
  for (const b of r.mateLinkBookings) {
    const mates = (b.mates as any[]).filter((m: any) => m.customerId !== opts.customerId);
    await ctx.db.patch(b._id, { mates });
  }
  for (const x of r.athletes) await ctx.db.delete(x._id);
  for (const x of r.creditLedger) await ctx.db.delete(x._id);
  for (const x of r.friendships) await ctx.db.delete(x._id);
  for (const x of r.bookingInvites) await ctx.db.delete(x._id);
  for (const x of r.payments) await ctx.db.delete(x._id);
  for (const x of r.stripePayments) await ctx.db.delete(x._id);
  for (const x of r.waitlist) await ctx.db.delete(x._id);
  for (const x of r.waitlistNotifications) await ctx.db.delete(x._id);
  for (const x of r.discountRedemptions) await ctx.db.delete(x._id);
  for (const x of r.adjCustomer) await ctx.db.delete(x._id);
  for (const x of r.adjCoach) await ctx.db.delete(x._id);
  for (const x of r.adminUnlocks) await ctx.db.delete(x._id);
  for (const x of r.pushSubs) await ctx.db.delete(x._id);
  for (const x of r.pushPrefs) await ctx.db.delete(x._id);
  const loginDeleted = await deleteAuthLogin(ctx, email);
  await ctx.db.delete(opts.customerId);
  return { dryRun: false as const, deleted: { ...counts, loginDeleted } };
}

/**
 * Strip a customer's HISTORY but keep the account (login, profile, athletes,
 * saved mates, push): bookings (+ calendar events), Stripe payment rows, credit
 * ledger + balance, waitlist rows, discount redemptions, statement adjustments.
 * Built for the 2026-09-02 OPS-4 purge (Inspector: keep the ceramics test login,
 * remove everything it did).
 */
export async function stripCustomerHistory(ctx: any, opts: { customerId: any; confirm: boolean }) {
  const cust = await ctx.db.get(opts.customerId);
  if (!cust) throw new ConvexError("No customer found with that id.");
  const email = norm((cust as any).email);
  const subject = await resolveSubject(ctx, email);
  const r = await collectCustomerRefs(ctx, opts.customerId, email, subject);
  const counts = {
    customer: { id: opts.customerId, name: (cust as any).name, email, role: (cust as any).role, creditBalance: (cust as any).creditBalance ?? 0 },
    ownBookings: r.ownBookings.size,
    gcalEventsToDelete: [...r.ownBookings.values()].filter((b: any) => b.googleCalendarEventId).length,
    mateLinksToStrip: r.mateLinkBookings.length,
    creditLedger: r.creditLedger.length,
    payments: r.payments.length,
    stripePayments: r.stripePayments.length,
    waitlist: r.waitlist.length,
    waitlistNotifications: r.waitlistNotifications.length,
    discountRedemptions: r.discountRedemptions.length,
    statementAdjustments: r.adjCustomer.length + r.adjCoach.length,
  };
  if (!opts.confirm) return { dryRun: true as const, willDelete: counts };
  await deleteOwnBookings(ctx, r.ownBookings);
  for (const b of r.mateLinkBookings) {
    const mates = (b.mates as any[]).filter((m: any) => m.customerId !== opts.customerId);
    await ctx.db.patch(b._id, { mates });
  }
  for (const x of r.creditLedger) await ctx.db.delete(x._id);
  for (const x of r.payments) await ctx.db.delete(x._id);
  for (const x of r.stripePayments) await ctx.db.delete(x._id);
  for (const x of r.waitlist) await ctx.db.delete(x._id);
  for (const x of r.waitlistNotifications) await ctx.db.delete(x._id);
  for (const x of r.discountRedemptions) await ctx.db.delete(x._id);
  for (const x of r.adjCustomer) await ctx.db.delete(x._id);
  for (const x of r.adjCoach) await ctx.db.delete(x._id);
  await ctx.db.patch(opts.customerId, { creditBalance: 0 } as any);
  return { dryRun: false as const, deleted: counts };
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
    // second-factor unlock, and audit the action before any write.
    const admin = await requireAdminUnlocked(ctx);
    const dryRun = args.dryRun !== false && args.confirm !== true; // default to dry-run unless explicitly confirmed
    return await cascadeDeleteCustomer(ctx, {
      customerId: args.customerId,
      confirm: !dryRun,
      adminEmail: (admin as any).email ?? "",
    });
  },
});
