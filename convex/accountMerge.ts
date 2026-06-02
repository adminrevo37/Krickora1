/**
 * SPEC_MERGE_DUPLICATE_ACCOUNTS — combine two customer accounts into one.
 *
 * Use case: a person signed up twice with different emails. Merge folds the
 * LOSER (`L`) into the SURVIVOR (`S`), reassigning every customer-referencing
 * table from L to S, summing credit, then retiring L:
 *   - L's customers row is SOFT-deleted (deactivatedAt + mergedIntoCustomerId,
 *     credit zeroed, email tombstoned so it's freed + can't be reactivated).
 *   - L's Better Auth login is HARD-deleted (the person logs in with S's email).
 *
 * DESTRUCTIVE → admin-gated + requireAdminUnlocked, a mandatory preview/dry-run
 * (previewAccountMerge, no writes), and an explicit `confirm: true` on commit.
 *
 * BLOCKED if either account is a coach/admin (Inspector decision 2026-06-02 —
 * demote to customer first; never silently fold a coach's payments/statements
 * into a customer). Customer↔customer only.
 *
 * A Convex mutation is one transaction, so mergeAccounts is atomic — it either
 * fully commits or fully rolls back. The repoints are also written to be
 * re-runnable (they key off L's id/email, which no longer match once moved).
 */
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { components } from "./_generated/api";
import { requireAdmin, requireAdminUnlocked, writeRoleAudit } from "./lib/adminGuard";
import { recordCreditMovement } from "./lib/credit";

const norm = (e: string) => e.toLowerCase().trim();
const round2 = (n: number) => Math.round(n * 100) / 100;

// Resolve the Better Auth user `_id` for an email — this is the value stored on
// bookings.userId / waitlist.userId (= identity.subject). null if no login.
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

// Collect the loser's OWN bookings (by email OR by the loser's auth subject).
async function collectLoserBookings(ctx: any, loserEmail: string, loserSubject: string | null) {
  const byEmail = await ctx.db
    .query("bookings")
    .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", loserEmail))
    .collect();
  const byUid = loserSubject
    ? await ctx.db.query("bookings").withIndex("by_userId", (q: any) => q.eq("userId", loserSubject)).collect()
    : [];
  const map = new Map<string, any>();
  for (const b of [...byEmail, ...byUid]) map.set(b._id, b);
  return [...map.values()];
}

/**
 * Read-only analysis shared by the preview and the commit's safety re-check.
 * Throws ConvexError on hard errors (missing account, self-merge); returns
 * `blockers` (must be empty to proceed) + `warnings` otherwise.
 */
async function analyzeMerge(
  ctx: any,
  rawLoser: string,
  rawSurvivor: string,
  adminEmail: string
) {
  const loserEmail = norm(rawLoser);
  const survivorEmail = norm(rawSurvivor);

  if (!loserEmail || !survivorEmail) throw new ConvexError("Both emails are required.");
  if (loserEmail === survivorEmail) throw new ConvexError("Cannot merge an account into itself.");

  const loser = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", loserEmail)).first();
  const survivor = await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", survivorEmail)).first();
  if (!loser) throw new ConvexError(`No customer found with email "${loserEmail}".`);
  if (!survivor) throw new ConvexError(`No customer found with email "${survivorEmail}".`);

  const blockers: string[] = [];
  const warnings: string[] = [];

  // Decision 2026-06-02: block if EITHER side is a coach/admin.
  const elevated = (role?: string) => role === "coach" || role === "admin";
  if (elevated(loser.role)) blockers.push(`The losing account (${loserEmail}) is a ${loser.role} — demote it to "customer" before merging.`);
  if (elevated(survivor.role)) blockers.push(`The surviving account (${survivorEmail}) is a ${survivor.role} — demote it to "customer" before merging.`);

  // Never let an admin merge their own account away (mirrors adminDeleteUser).
  const a = norm(adminEmail ?? "");
  if (a && (a === loserEmail || a === survivorEmail)) {
    blockers.push("You cannot merge your own account. Have another admin run the merge.");
  }

  if (loser.deactivatedAt || loser.mergedIntoCustomerId) {
    blockers.push(`The losing account (${loserEmail}) is already deactivated/merged.`);
  }
  if (survivor.deactivatedAt || survivor.mergedIntoCustomerId) {
    blockers.push(`The surviving account (${survivorEmail}) is deactivated/merged — pick a live survivor.`);
  }

  const loserSubject = await resolveSubject(ctx, loserEmail);
  const survivorSubject = await resolveSubject(ctx, survivorEmail);
  if (!survivorSubject) {
    warnings.push("The surviving account has no login record — merged bookings will still match by email, but its My-Bookings filter can't be repointed by user id.");
  }

  // ── Counts (what WOULD move) ────────────────────────────────────────────
  const loserBookings = await collectLoserBookings(ctx, loserEmail, loserSubject);
  const allBookings = await ctx.db.query("bookings").collect();
  const bookingMateLinks = allBookings.filter(
    (b: any) => Array.isArray(b.mates) && b.mates.some((m: any) => m.customerId === loser._id)
  ).length;

  const athletes = await ctx.db.query("athletes").withIndex("by_account", (q: any) => q.eq("accountCustomerId", loser._id)).collect();
  const creditLedger = await ctx.db.query("creditLedger").withIndex("by_customerId", (q: any) => q.eq("customerId", loser._id)).collect();
  const allFriendships = await ctx.db.query("friendships").collect();
  const friendships = allFriendships.filter((f: any) => f.ownerId === loser._id || f.mateId === loser._id).length;
  const allInvites = await ctx.db.query("bookingInvites").collect();
  const bookingInvites = allInvites.filter((i: any) => i.invitedByCustomerId === loser._id || i.joinedByCustomerId === loser._id).length;
  const payments = await ctx.db.query("payments").withIndex("by_coachId", (q: any) => q.eq("coachId", loser._id)).collect();
  const stripePayments = await ctx.db.query("stripePayments").withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", loserEmail)).collect();
  const allWaitlist = await ctx.db.query("waitlist").collect();
  const waitlist = allWaitlist.filter((w: any) => norm(w.userEmail ?? "") === loserEmail || (loserSubject && w.userId === loserSubject)).length;
  const allWaitlistNotifs = await ctx.db.query("waitlistNotifications").collect();
  const waitlistNotifications = allWaitlistNotifs.filter((n: any) => norm(n.userEmail ?? "") === loserEmail || (loserSubject && n.userId === loserSubject)).length;
  const allRedemptions = await ctx.db.query("discountRedemptions").collect();
  const discountRedemptions = allRedemptions.filter((r: any) => norm(r.customerEmail ?? "") === loserEmail).length;
  const adjCustomer = await ctx.db.query("statementAdjustments").withIndex("by_subject", (q: any) => q.eq("subjectType", "customer").eq("subjectId", loser._id)).collect();
  const adjCoach = await ctx.db.query("statementAdjustments").withIndex("by_subject", (q: any) => q.eq("subjectType", "coach").eq("subjectId", loser._id)).collect();

  // Same-named athletes across both accounts → informational (duplicates likely).
  const survivorAthletes = await ctx.db.query("athletes").withIndex("by_account", (q: any) => q.eq("accountCustomerId", survivor._id)).collect();
  const survivorAthleteNames = new Set(survivorAthletes.map((x: any) => (x.name ?? "").toLowerCase().trim()));
  const dupAthletes = athletes
    .map((x: any) => (x.name ?? "").toLowerCase().trim())
    .filter((n: string) => n && survivorAthleteNames.has(n));
  if (dupAthletes.length) {
    warnings.push(`Both accounts have an athlete named: ${[...new Set(dupAthletes)].join(", ")}. They will be kept as separate athletes under the survivor — remove the duplicate afterwards if needed.`);
  }

  const loserCredit = round2(loser.creditBalance ?? 0);
  const survivorCredit = round2(survivor.creditBalance ?? 0);

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    loser: { _id: loser._id, email: loserEmail, name: loser.name, role: loser.role, creditBalance: loserCredit, hasLogin: loserSubject != null },
    survivor: { _id: survivor._id, email: survivorEmail, name: survivor.name, role: survivor.role, creditBalance: survivorCredit, hasLogin: survivorSubject != null },
    mergedCreditBalance: round2(loserCredit + survivorCredit),
    counts: {
      bookings: loserBookings.length,
      bookingMateLinks,
      athletes: athletes.length,
      creditLedger: creditLedger.length,
      friendships,
      bookingInvites,
      payments: payments.length,
      stripePayments: stripePayments.length,
      waitlist,
      waitlistNotifications,
      discountRedemptions,
      statementAdjustments: adjCustomer.length + adjCoach.length,
    },
    // internal — used by the commit path
    _loser: loser,
    _survivor: survivor,
    _loserSubject: loserSubject,
    _survivorSubject: survivorSubject,
  };
}

/** Dry-run: what WOULD move + conflicts. No writes. Admin only. */
export const previewAccountMerge = query({
  args: { loserEmail: v.string(), survivorEmail: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const result = await analyzeMerge(ctx, args.loserEmail, args.survivorEmail, (admin as any).email ?? "");
    // strip internal fields from the query result
    const { _loser, _survivor, _loserSubject, _survivorSubject, ...pub } = result as any;
    return pub;
  },
});

// Hard-delete a Better Auth login (user + its sessions + accounts). Mirrors the
// loop in users.adminDeleteUser. Best-effort — never throws.
async function deleteAuthLogin(ctx: any, email: string) {
  const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "email", value: email }],
  }).catch(() => null);
  if (!authUser) return;
  try {
    const sessions: any = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: (authUser as any)._id }],
    } as any).catch(() => null);
    const sessionList = Array.isArray(sessions) ? sessions : (sessions?.docs ?? sessions?.page ?? []);
    for (const s of sessionList) {
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, { model: "session", where: [{ field: "_id", value: s._id }] } as any).catch(() => {});
    }
  } catch (e) { console.error("merge: clear sessions failed:", e); }
  try {
    const accounts: any = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "account",
      where: [{ field: "userId", value: (authUser as any)._id }],
    } as any).catch(() => null);
    const accountList = Array.isArray(accounts) ? accounts : (accounts?.docs ?? accounts?.page ?? []);
    for (const acc of accountList) {
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, { model: "account", where: [{ field: "_id", value: acc._id }] } as any).catch(() => {});
    }
  } catch (e) { console.error("merge: clear accounts failed:", e); }
  try {
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, { model: "user", where: [{ field: "_id", value: (authUser as any)._id }] } as any);
  } catch (e) { console.error("merge: delete auth user failed:", e); }
}

/**
 * Commit the merge. Admin-gated + requireAdminUnlocked + explicit confirm.
 * Re-runs analyzeMerge as a safety re-check, then performs all reassignments.
 */
export const mergeAccounts = mutation({
  args: { loserEmail: v.string(), survivorEmail: v.string(), confirm: v.boolean() },
  handler: async (ctx, args) => {
    const admin = await requireAdminUnlocked(ctx);
    if (!args.confirm) throw new ConvexError("Merge not confirmed.");

    const a = await analyzeMerge(ctx, args.loserEmail, args.survivorEmail, (admin as any).email ?? "");
    if (!a.ok) throw new ConvexError(`Cannot merge: ${a.blockers.join(" ")}`);

    const loser = (a as any)._loser;
    const survivor = (a as any)._survivor;
    const loserEmail = a.loser.email;
    const survivorEmail = a.survivor.email;
    const loserSubject: string | null = (a as any)._loserSubject;
    const survivorSubject: string | null = (a as any)._survivorSubject;
    const now = new Date().toISOString();

    // ── athletes ────────────────────────────────────────────────────────
    const athletes = await ctx.db.query("athletes").withIndex("by_account", (q: any) => q.eq("accountCustomerId", loser._id)).collect();
    for (const x of athletes) await ctx.db.patch(x._id, { accountCustomerId: survivor._id });

    // ── creditLedger (repoint history; balances merged separately below) ──
    const ledger = await ctx.db.query("creditLedger").withIndex("by_customerId", (q: any) => q.eq("customerId", loser._id)).collect();
    for (const l of ledger) await ctx.db.patch(l._id, { customerId: survivor._id });

    // ── friendships: repoint L→S, drop self-pairs + duplicates ────────────
    const allFriendships = await ctx.db.query("friendships").collect();
    const finalPairs = new Set<string>();
    // pass 1: register pairs that are NOT affected by the repoint
    for (const f of allFriendships) {
      if (f.ownerId !== loser._id && f.mateId !== loser._id) finalPairs.add(`${f.ownerId}|${f.mateId}`);
    }
    // pass 2: process affected rows
    for (const f of allFriendships) {
      if (f.ownerId !== loser._id && f.mateId !== loser._id) continue;
      const owner = f.ownerId === loser._id ? survivor._id : f.ownerId;
      const mate = f.mateId === loser._id ? survivor._id : f.mateId;
      if (owner === mate) { await ctx.db.delete(f._id); continue; }        // self-pair
      const key = `${owner}|${mate}`;
      if (finalPairs.has(key)) { await ctx.db.delete(f._id); continue; }   // duplicate
      finalPairs.add(key);
      await ctx.db.patch(f._id, { ownerId: owner, mateId: mate });
    }

    // ── bookingInvites ────────────────────────────────────────────────────
    const allInvites = await ctx.db.query("bookingInvites").collect();
    for (const i of allInvites) {
      const patch: Record<string, any> = {};
      if (i.invitedByCustomerId === loser._id) patch.invitedByCustomerId = survivor._id;
      if (i.joinedByCustomerId === loser._id) patch.joinedByCustomerId = survivor._id;
      if (Object.keys(patch).length) await ctx.db.patch(i._id, patch);
    }

    // ── bookings: own bookings (owner fields) + mate links ────────────────
    const allBookings = await ctx.db.query("bookings").collect();
    for (const b of allBookings) {
      const patch: Record<string, any> = {};
      const isLoserOwned =
        (b.customerEmail?.toLowerCase?.() === loserEmail) ||
        (loserSubject != null && b.userId === loserSubject);
      if (isLoserOwned) {
        patch.customerEmail = survivorEmail;
        patch.customerName = survivor.name;
        if (survivorSubject) patch.userId = survivorSubject;
      }
      if (Array.isArray(b.mates) && b.mates.length) {
        const ownerEmail = isLoserOwned ? survivorEmail : (b.customerEmail?.toLowerCase?.() ?? "");
        const seen = new Set<string>();
        const deduped: any[] = [];
        for (const m of b.mates) {
          const id = m.customerId === loser._id ? survivor._id : m.customerId;
          if (seen.has(id)) continue;              // dedupe
          if (ownerEmail === survivorEmail && id === survivor._id) continue; // drop self-mate
          seen.add(id);
          deduped.push(id === m.customerId ? m : { ...m, customerId: id });
        }
        if (JSON.stringify(deduped) !== JSON.stringify(b.mates)) patch.mates = deduped;
      }
      if (Object.keys(patch).length) await ctx.db.patch(b._id, patch);
    }

    // ── payments (coachId = customers._id string; normally none for a customer) ──
    const payments = await ctx.db.query("payments").withIndex("by_coachId", (q: any) => q.eq("coachId", loser._id)).collect();
    for (const p of payments) await ctx.db.patch(p._id, { coachId: survivor._id });

    // ── stripePayments (by customerEmail) ─────────────────────────────────
    const stripePayments = await ctx.db.query("stripePayments").withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", loserEmail)).collect();
    for (const sp of stripePayments) await ctx.db.patch(sp._id, { customerEmail: survivorEmail, customerName: survivor.name });

    // ── waitlist ──────────────────────────────────────────────────────────
    const allWaitlist = await ctx.db.query("waitlist").collect();
    for (const w of allWaitlist) {
      const match = norm(w.userEmail ?? "") === loserEmail || (loserSubject != null && w.userId === loserSubject);
      if (!match) continue;
      const patch: Record<string, any> = { userEmail: survivorEmail };
      if (survivorSubject) patch.userId = survivorSubject;
      if (survivor.name) patch.userName = survivor.name;
      await ctx.db.patch(w._id, patch);
    }

    // ── waitlistNotifications ─────────────────────────────────────────────
    const allWaitlistNotifs = await ctx.db.query("waitlistNotifications").collect();
    for (const n of allWaitlistNotifs) {
      const match = norm(n.userEmail ?? "") === loserEmail || (loserSubject != null && n.userId === loserSubject);
      if (!match) continue;
      const patch: Record<string, any> = { userEmail: survivorEmail };
      if (survivorSubject) patch.userId = survivorSubject;
      if (survivor.name) patch.userName = survivor.name;
      await ctx.db.patch(n._id, patch);
    }

    // ── discountRedemptions (by customerEmail — note: shifts perCustomerLimit) ──
    const allRedemptions = await ctx.db.query("discountRedemptions").collect();
    for (const r of allRedemptions) {
      if (norm(r.customerEmail ?? "") === loserEmail) await ctx.db.patch(r._id, { customerEmail: survivorEmail });
    }

    // ── statementAdjustments (both subject types) ─────────────────────────
    for (const st of ["customer", "coach"]) {
      const adj = await ctx.db.query("statementAdjustments").withIndex("by_subject", (q: any) => q.eq("subjectType", st).eq("subjectId", loser._id)).collect();
      for (const x of adj) await ctx.db.patch(x._id, { subjectId: survivor._id });
    }

    // ── adminUnlocks (delete loser's) ─────────────────────────────────────
    const unlocks = await ctx.db.query("adminUnlocks").withIndex("by_email", (q: any) => q.eq("email", loserEmail)).collect();
    for (const u of unlocks) await ctx.db.delete(u._id);

    // ── merge credit: add loser's balance onto survivor + one ledger row ──
    const loserCredit = round2(loser.creditBalance ?? 0);
    if (loserCredit > 0) {
      await recordCreditMovement(ctx, {
        customer: survivor,
        delta: loserCredit,
        reason: "admin_adjust",
        note: `Merged from ${loserEmail} (account merge)`,
      });
    }

    // ── hard-delete loser's login (frees the auth email) ──────────────────
    await deleteAuthLogin(ctx, loserEmail);

    // ── soft-delete + tombstone the loser customers row (LAST) ────────────
    // Tombstone the email so by_email lookups can't reactivate it and the
    // address is freed for reuse; credit zeroed (already moved to survivor).
    await ctx.db.patch(loser._id, {
      deactivatedAt: now,
      mergedIntoCustomerId: survivor._id,
      creditBalance: 0,
      email: `merged::${loser._id}::${loserEmail}`,
    });

    await writeRoleAudit(ctx, {
      targetEmail: loserEmail,
      field: "merged",
      oldValue: loserEmail,
      newValue: `→ ${survivorEmail}`,
      changedByEmail: (admin as any).email ?? "",
    });

    return {
      success: true,
      survivorEmail,
      loserEmail,
      mergedCredit: loserCredit,
      moved: a.counts,
    };
  },
});
