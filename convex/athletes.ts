// Child-athlete entities — SPEC_PARENT_ATHLETE_MODEL.
// Separates the ACCOUNT holder (customers) from the ATHLETE (trainee a coach
// sees). One account -> many athletes; per-athlete coach assignment lives here.
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { requireAdmin, getCallerContext } from "./lib/adminGuard";
import { getAWSTNow } from "./lib/bookingWindow";
import { composeName, splitName } from "./lib/names";

// ── helpers ─────────────────────────────────────────────────────────────────

// SPEC_PUSH_NOTIFICATIONS_V2 §6.4 — notify a coach that an athlete added/removed
// them from their roster. coachId is a customers _id; no-op for anything that
// doesn't resolve to a coach account. Best-effort (scheduled, never blocks).
async function notifyCoachRoster(
  ctx: any,
  coachId: string,
  athleteDisplay: string,
  added: boolean
): Promise<void> {
  if (!coachId) return;
  let coach: any = null;
  try {
    coach = await ctx.db.get(coachId as any);
  } catch {
    coach = null; // not a valid Id (e.g. a legacy email entry) — skip
  }
  if (!coach || coach.role !== "coach" || !coach.email) return;
  const name = (athleteDisplay ?? "").trim() || "An athlete";
  await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
    email: String(coach.email).toLowerCase().trim(),
    category: "coach-roster",
    title: added ? "New athlete on your roster" : "Athlete left your roster",
    body: added
      ? `${name} has added you as a coach. You can now allocate them sessions.`
      : `${name} is no longer on your roster.`,
    url: "/bookings",
    tag: `coach-roster-${coachId}`,
  });
}

// SPEC_PUSH_NOTIFICATIONS_V2 §6.2 — record a customer→coach link creation for the
// hourly admin digest's "added a coach" count.
async function logCoachAddEvent(ctx: any, accountId: string): Promise<void> {
  if (!accountId) return;
  await ctx.db.insert("coachLinkEvents", { accountId: accountId as any, at: Date.now() });
}

// Resolve the caller's own customers row (or null). Never throws.
async function getCallerCustomer(ctx: any): Promise<any | null> {
  const caller = await getCallerContext(ctx);
  if (!caller.identity || !caller.email) return null;
  return await ctx.db
    .query("customers")
    .withIndex("by_email", (q: any) => q.eq("email", caller.email))
    .first();
}

// Authorize the caller to manage `accountCustomerId`: own account or admin.
// Returns the resolved account customer id. Throws otherwise.
async function authorizeAccount(
  ctx: any,
  accountCustomerId?: string
): Promise<{ accountId: string; isAdmin: boolean }> {
  const caller = await getCallerContext(ctx);
  if (!caller.identity) throw new ConvexError("Authentication required.");
  const callerCustomer = await getCallerCustomer(ctx);
  // Default target = the caller's own account.
  const targetId = (accountCustomerId as string) || callerCustomer?._id;
  if (!targetId) throw new ConvexError("No account found for the current user.");
  if (caller.isAdmin) return { accountId: targetId, isAdmin: true };
  if (!callerCustomer || callerCustomer._id !== targetId) {
    throw new ConvexError("You can only manage your own athletes.");
  }
  return { accountId: targetId, isAdmin: false };
}

// Today's date key (YYYY-MM-DD) in AWST — for future-allocation checks.
function awstTodayKey(): string {
  const d = getAWSTNow();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Does this athlete have any future, non-cancelled coach-booking allocation?
async function hasFutureAllocations(ctx: any, athleteId: string): Promise<boolean> {
  const todayKey = awstTodayKey();
  const futureBookings = await ctx.db
    .query("bookings")
    .withIndex("by_date", (q: any) => q.gte("date", todayKey))
    .collect();
  return futureBookings.some(
    (b: any) =>
      b.status !== "cancelled" &&
      (b.athleteSlots ?? []).some((s: any) => s.athleteId === athleteId)
  );
}

// ── queries ───────────────────────────────────────────────────────────────

// List athletes under an account. Defaults to the caller's own account;
// admins may pass any accountCustomerId. Self/admin scoped.
export const listAthletesByAccount = query({
  args: { accountCustomerId: v.optional(v.id("customers")) },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    const callerCustomer = await getCallerCustomer(ctx);
    const targetId = (args.accountCustomerId as string) || callerCustomer?._id;
    if (!targetId) return [];
    if (!caller.isAdmin && (!callerCustomer || callerCustomer._id !== targetId)) {
      return [];
    }
    return await ctx.db
      .query("athletes")
      .withIndex("by_account", (q: any) => q.eq("accountCustomerId", targetId))
      .collect();
  },
});

// ── mutations: parent/admin self-management ─────────────────────────────────

export const createAthlete = mutation({
  args: {
    // SPEC_SIGNUP_UPDATES_2026-06 G3 — first/last are the new source fields.
    // `name` is kept optional for legacy single-name callers; when first/last are
    // supplied the display `name` is composed from them.
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    accountCustomerId: v.optional(v.id("customers")),
    dob: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId } = await authorizeAccount(ctx, args.accountCustomerId);
    // Prefer explicit first/last; fall back to splitting a single `name`.
    const givenFirst = (args.firstName ?? "").trim();
    const givenLast = (args.lastName ?? "").trim();
    const split = givenFirst || givenLast
      ? { firstName: givenFirst, lastName: givenLast }
      : splitName(args.name);
    const name = composeName(split.firstName, split.lastName);
    if (!name) throw new ConvexError("Athlete name is required.");
    return await ctx.db.insert("athletes", {
      accountCustomerId: accountId as any,
      name,
      firstName: split.firstName || undefined,
      lastName: split.lastName || undefined,
      assignedCoachIds: [],
      isSelf: false,
      dob: args.dob?.trim() || undefined,
      notes: args.notes?.trim() || undefined,
      createdAt: new Date().toISOString(),
    });
  },
});

export const updateAthlete = mutation({
  args: {
    athleteId: v.id("athletes"),
    // SPEC_SIGNUP_UPDATES_2026-06 G3 — edit via first/last; `name` recomposed.
    // Legacy single-name edits still honoured when first/last aren't supplied.
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    dob: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const athlete = await ctx.db.get(args.athleteId);
    if (!athlete) throw new ConvexError("Athlete not found.");
    await authorizeAccount(ctx, athlete.accountCustomerId);
    const updates: Record<string, any> = {};
    if (args.firstName !== undefined || args.lastName !== undefined) {
      // Compose from the new first/last, falling back to whatever the athlete
      // already has for the field not being changed.
      const first = (args.firstName ?? athlete.firstName ?? "").trim();
      const last = (args.lastName ?? athlete.lastName ?? "").trim();
      const composed = composeName(first, last);
      if (!composed) throw new ConvexError("Athlete name cannot be empty.");
      updates.firstName = first || undefined;
      updates.lastName = last || undefined;
      updates.name = composed;
    } else if (args.name !== undefined) {
      const n = args.name.trim();
      if (!n) throw new ConvexError("Athlete name cannot be empty.");
      const split = splitName(n);
      updates.name = n;
      updates.firstName = split.firstName || undefined;
      updates.lastName = split.lastName || undefined;
    }
    if (args.dob !== undefined) updates.dob = args.dob.trim() || undefined;
    if (args.notes !== undefined) updates.notes = args.notes.trim() || undefined;
    await ctx.db.patch(args.athleteId, updates);
    return args.athleteId;
  },
});

// Replace an athlete's full coach list (per-athlete coach assignment). The
// parent self-manages, or a coach/admin adds via addAthleteToCoach below.
export const setAthleteCoaches = mutation({
  args: {
    athleteId: v.id("athletes"),
    coachIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const athlete = await ctx.db.get(args.athleteId);
    if (!athlete) throw new ConvexError("Athlete not found.");
    await authorizeAccount(ctx, athlete.accountCustomerId);
    // De-dupe + drop empties.
    const coachIds = Array.from(
      new Set(args.coachIds.map((c) => c.trim()).filter(Boolean))
    );
    const prevCoaches = new Set<string>(athlete.assignedCoachIds ?? []);
    await ctx.db.patch(args.athleteId, { assignedCoachIds: coachIds });
    // §6.4 — notify newly-added / removed coaches; §6.2 — log the add for the digest.
    const added = coachIds.filter((c) => !prevCoaches.has(c));
    const removed = Array.from(prevCoaches).filter((c) => !coachIds.includes(c));
    for (const c of added) await notifyCoachRoster(ctx, c, athlete.name, true);
    for (const c of removed) await notifyCoachRoster(ctx, c, athlete.name, false);
    if (added.length > 0) await logCoachAddEvent(ctx, athlete.accountCustomerId);
    return args.athleteId;
  },
});

// SPEC_SIGNUP_UPDATES_2026-06 G2 — one-shot setup called by the signup follow-up
// (AuthModal) once the new account's auth token has attached. Writes the coaching
// data the customer entered on the signup form:
//   - selfCoachIds → the account's isSelf athlete (created if somehow missing)
//   - athletes[]   → one child athlete row each (first/last + coaches)
// Authorised to the CALLER'S OWN account only (reuses authorizeAccount). Convex
// mutations are transactional, so the AuthModal retry-until-token loop is safe:
// a call rejected for a lagging token rolls back entirely (no partial/dupe rows).
// Idempotent against an accidental second successful call: a child matching an
// existing athlete by composed name has its coaches merged instead of duplicated.
export const setupAthletesAtSignup = mutation({
  args: {
    selfCoachIds: v.optional(v.array(v.string())),
    athletes: v.optional(
      v.array(
        v.object({
          firstName: v.string(),
          lastName: v.string(),
          coachIds: v.array(v.string()),
        })
      )
    ),
  },
  handler: async (ctx, args) => {
    const { accountId } = await authorizeAccount(ctx);
    const now = new Date().toISOString();
    const clean = (ids: string[]) =>
      Array.from(new Set(ids.map((c) => c.trim()).filter(Boolean)));
    // §6.4/§6.2 — coaches newly linked during this signup (notify + digest log).
    const coachNotifs: Array<{ coachId: string; display: string }> = [];
    const account: any = await ctx.db.get(accountId as any);

    const existing = await ctx.db
      .query("athletes")
      .withIndex("by_account", (q: any) => q.eq("accountCustomerId", accountId))
      .collect();

    // ── self-athlete coaches (adult "I am being coached") ──
    const selfCoaches = clean(args.selfCoachIds ?? []);
    if (selfCoaches.length > 0) {
      let self = existing.find((a: any) => a.isSelf);
      const selfDisplay = account?.name ?? "An athlete";
      if (!self) {
        // Create-self-if-missing: the customer-sync step normally makes this row,
        // but never assume ordering. Carry the account holder's name.
        const selfId = await ctx.db.insert("athletes", {
          accountCustomerId: accountId as any,
          name: account?.name ?? "",
          firstName: account?.firstName || undefined,
          lastName: account?.lastName || undefined,
          assignedCoachIds: selfCoaches,
          isSelf: true,
          createdAt: now,
        });
        existing.push({ _id: selfId, isSelf: true } as any);
        for (const c of selfCoaches) coachNotifs.push({ coachId: c, display: selfDisplay });
      } else {
        const before = new Set<string>(self.assignedCoachIds ?? []);
        const merged = clean([...(self.assignedCoachIds ?? []), ...selfCoaches]);
        await ctx.db.patch(self._id, { assignedCoachIds: merged });
        for (const c of merged) if (!before.has(c)) coachNotifs.push({ coachId: c, display: selfDisplay });
      }
    }

    // ── child athletes ──
    let created = 0;
    for (const a of args.athletes ?? []) {
      const first = a.firstName.trim();
      const last = a.lastName.trim();
      const name = composeName(first, last);
      if (!name) continue; // skip blank rows defensively
      const coachIds = clean(a.coachIds);
      // Merge into an existing same-name athlete rather than duplicate.
      const match = existing.find(
        (e: any) => !e.isSelf && (e.name ?? "").toLowerCase().trim() === name.toLowerCase()
      );
      if (match) {
        const before = new Set<string>(match.assignedCoachIds ?? []);
        const merged = clean([...(match.assignedCoachIds ?? []), ...coachIds]);
        await ctx.db.patch(match._id, {
          assignedCoachIds: merged,
          firstName: first || undefined,
          lastName: last || undefined,
          name,
        });
        for (const c of merged) if (!before.has(c)) coachNotifs.push({ coachId: c, display: name });
      } else {
        await ctx.db.insert("athletes", {
          accountCustomerId: accountId as any,
          name,
          firstName: first || undefined,
          lastName: last || undefined,
          assignedCoachIds: coachIds,
          isSelf: false,
          createdAt: now,
        });
        created++;
        for (const c of coachIds) coachNotifs.push({ coachId: c, display: name });
      }
    }

    // §6.4 — notify each newly-linked coach; §6.2 — one digest event for the account.
    for (const n of coachNotifs) await notifyCoachRoster(ctx, n.coachId, n.display, true);
    if (coachNotifs.length > 0) await logCoachAddEvent(ctx, accountId as string);

    return { success: true, childrenCreated: created };
  },
});

export const removeAthlete = mutation({
  args: { athleteId: v.id("athletes") },
  handler: async (ctx, args) => {
    const athlete = await ctx.db.get(args.athleteId);
    if (!athlete) throw new ConvexError("Athlete not found.");
    await authorizeAccount(ctx, athlete.accountCustomerId);
    if (await hasFutureAllocations(ctx, args.athleteId as string)) {
      throw new ConvexError(
        "This athlete has upcoming coaching sessions. Ask the coach to remove them from those sessions first."
      );
    }
    await ctx.db.delete(args.athleteId);
    return { success: true };
  },
});

// ── mutation: coach-add / invite (refines allocation spec Part 4) ───────────

// A coach (or admin) adds an athlete to themselves by the parent's email.
// - Account exists: find/create the child athlete under it, assign this coach,
//   notify the parent.
// - No account: store a pending athlete-invite (extends coachInvites) and email
//   the parent; consumed on registration (see auth.ts).
export const addAthleteToCoach = mutation({
  args: {
    coachId: v.string(),
    parentEmail: v.string(),
    childName: v.string(),
  },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) throw new ConvexError("Authentication required.");
    const callerCustomer = await getCallerCustomer(ctx);
    // Only the coach themselves (by _id or email) or an admin may add.
    const isSelfCoach =
      callerCustomer &&
      callerCustomer.role === "coach" &&
      (callerCustomer._id === args.coachId ||
        callerCustomer.email === args.coachId.toLowerCase().trim());
    if (!caller.isAdmin && !isSelfCoach) {
      throw new ConvexError("Only the coach or an admin can add athletes.");
    }
    // Normalise the coach to their _id so athlete records store ids, not emails.
    let coachIdNorm = args.coachId;
    const coachByEmail = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) =>
        q.eq("email", args.coachId.toLowerCase().trim())
      )
      .first();
    if (coachByEmail && coachByEmail.role === "coach") coachIdNorm = coachByEmail._id;

    const coachName = callerCustomer?.name ?? coachByEmail?.name ?? "Your coach";
    const parentEmail = args.parentEmail.toLowerCase().trim();
    const childName = args.childName.trim();
    if (!parentEmail || !childName) {
      throw new ConvexError("Parent email and child name are required.");
    }

    const account = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", parentEmail))
      .first();

    if (account) {
      // Find an existing child athlete by name under this account.
      const existing = await ctx.db
        .query("athletes")
        .withIndex("by_account", (q: any) =>
          q.eq("accountCustomerId", account._id)
        )
        .collect();
      let athlete = existing.find(
        (a: any) => a.name.toLowerCase().trim() === childName.toLowerCase()
      );
      if (athlete) {
        const coachIds = new Set(athlete.assignedCoachIds ?? []);
        coachIds.add(coachIdNorm);
        await ctx.db.patch(athlete._id, {
          assignedCoachIds: Array.from(coachIds),
        });
      } else {
        await ctx.db.insert("athletes", {
          accountCustomerId: account._id,
          name: childName,
          assignedCoachIds: [coachIdNorm],
          isSelf: false,
          createdAt: new Date().toISOString(),
        });
      }
      // Notify the parent (best-effort).
      await ctx.scheduler.runAfter(0, internal.emails.sendAthleteAdded, {
        to: account.email,
        parentName: account.name,
        childName,
        coachName,
      });
      // §6.4 — if an ADMIN linked the athlete on the coach's behalf, tell the
      // coach (a coach adding to their own roster already knows → no self-ping).
      if (caller.isAdmin && !isSelfCoach) {
        await notifyCoachRoster(ctx, coachIdNorm, childName, true);
      }
      return { status: "added", accountExists: true };
    }

    // No account — store a pending athlete-invite, email the parent.
    const existingInvite = await ctx.db
      .query("coachInvites")
      .withIndex("by_email", (q: any) => q.eq("email", parentEmail))
      .first();
    // LOW (SEC audit 2026-06-03): future-proof the invite token with the Web
    // Crypto CSPRNG instead of a predictable hash(email+name)+timestamp.
    const tokenBytes = new Uint8Array(16);
    crypto.getRandomValues(tokenBytes);
    const token = `ath_${Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (existingInvite && !existingInvite.used && existingInvite.kind === "athlete") {
      // Refresh the existing pending athlete-invite with the latest details.
      await ctx.db.patch(existingInvite._id, {
        childName,
        coachId: coachIdNorm,
      });
    } else {
      await ctx.db.insert("coachInvites", {
        token,
        name: childName, // display name on the invite
        email: parentEmail,
        phone: "",
        createdBy: coachIdNorm,
        createdAt: new Date().toISOString(),
        used: false,
        kind: "athlete",
        childName,
        coachId: coachIdNorm,
      });
    }
    await ctx.scheduler.runAfter(0, internal.emails.sendAthleteInvite, {
      to: parentEmail,
      childName,
      coachName,
    });
    return { status: "invited", accountExists: false };
  },
});

// A coach (or admin) removes an athlete from THEIR OWN roster — pulls the
// coach's _id from the athlete's assignedCoachIds. Only affects future dropdown
// availability; past bookings/allocations are untouched (Part 4 "Removal").
export const removeAthleteFromCoach = mutation({
  args: {
    coachId: v.string(),
    athleteId: v.id("athletes"),
  },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) throw new ConvexError("Authentication required.");
    const callerCustomer = await getCallerCustomer(ctx);
    const isSelfCoach =
      callerCustomer &&
      callerCustomer.role === "coach" &&
      (callerCustomer._id === args.coachId ||
        callerCustomer.email === args.coachId.toLowerCase().trim());
    if (!caller.isAdmin && !isSelfCoach) {
      throw new ConvexError("Only the coach or an admin can remove athletes from a roster.");
    }
    const athlete = await ctx.db.get(args.athleteId);
    if (!athlete) throw new ConvexError("Athlete not found.");
    // Normalise the coach to their _id (callers may pass an email).
    let coachIdNorm = args.coachId;
    const coachByEmail = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", args.coachId.toLowerCase().trim()))
      .first();
    if (coachByEmail && coachByEmail.role === "coach") coachIdNorm = coachByEmail._id;
    const next = (athlete.assignedCoachIds ?? []).filter(
      (c: string) => c !== coachIdNorm && c !== args.coachId
    );
    await ctx.db.patch(args.athleteId, { assignedCoachIds: next });
    // §6.4 — if an ADMIN removed the athlete on the coach's behalf, tell the coach.
    if (caller.isAdmin && !isSelfCoach) {
      await notifyCoachRoster(ctx, coachIdNorm, athlete.name, false);
    }
    return { success: true };
  },
});

// ── migration (one-off, idempotent) — SPEC_PARENT_ATHLETE_MODEL "Migration" ──

// 1. Every role=customer account with no self-athlete gets one (carrying its
//    assignedCoachIds). 2. Every booking athleteSlot lacking athleteId is
//    matched name -> customer -> self-athlete. Safe to re-run.
export const migrateToAthletes = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const now = new Date().toISOString();

    // ── 1. self-athletes for customers ──
    const customers = await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", "customer"))
      .collect();
    let selfCreated = 0;
    for (const c of customers) {
      const existing = await ctx.db
        .query("athletes")
        .withIndex("by_account", (q: any) => q.eq("accountCustomerId", c._id))
        .collect();
      const hasSelf = existing.some((a: any) => a.isSelf);
      if (!hasSelf) {
        await ctx.db.insert("athletes", {
          accountCustomerId: c._id,
          name: c.name,
          assignedCoachIds: c.assignedCoachIds ?? [],
          isSelf: true,
          createdAt: now,
        });
        selfCreated++;
      }
    }

    // ── 2. backfill athleteId on booking slots ──
    // Build a name -> self-athlete lookup across ALL athletes (self rows carry
    // the account holder's name; that's what legacy slots stored).
    const allAthletes = await ctx.db.query("athletes").collect();
    const athleteByName = new Map<string, string>();
    for (const a of allAthletes) {
      if (a.isSelf) athleteByName.set(a.name.toLowerCase().trim(), a._id);
    }
    const bookings = await ctx.db.query("bookings").collect();
    let slotsLinked = 0;
    let bookingsPatched = 0;
    for (const b of bookings) {
      if (!b.athleteSlots || b.athleteSlots.length === 0) continue;
      let changed = false;
      const newSlots = b.athleteSlots.map((s: any) => {
        if (s.athleteId) return s;
        const match = athleteByName.get(s.athleteName?.toLowerCase().trim());
        if (match) {
          changed = true;
          slotsLinked++;
          return { ...s, athleteId: match };
        }
        return s;
      });
      if (changed) {
        await ctx.db.patch(b._id, { athleteSlots: newSlots });
        bookingsPatched++;
      }
    }

    return {
      customersScanned: customers.length,
      selfAthletesCreated: selfCreated,
      bookingsPatched,
      slotsLinked,
    };
  },
});

// SPEC_SIGNUP_UPDATES_2026-06 G3 migration (idempotent) — backfill
// firstName/lastName on every athlete that lacks them, via a last-space split of
// the existing `name` (same approach as the customer Name-Split migration).
// `name` itself is left untouched (it stays the authoritative display string).
// Safe to re-run: only patches athletes whose firstName AND lastName are unset.
export const migrateAthleteNames = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const athletes = await ctx.db.query("athletes").collect();
    let patched = 0;
    for (const a of athletes) {
      if (a.firstName !== undefined || a.lastName !== undefined) continue;
      const { firstName, lastName } = splitName(a.name);
      await ctx.db.patch(a._id, {
        firstName: firstName || undefined,
        lastName: lastName || undefined,
      });
      patched++;
    }
    return { athletesScanned: athletes.length, patched };
  },
});
