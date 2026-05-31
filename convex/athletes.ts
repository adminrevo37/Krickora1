// Child-athlete entities — SPEC_PARENT_ATHLETE_MODEL.
// Separates the ACCOUNT holder (customers) from the ATHLETE (trainee a coach
// sees). One account -> many athletes; per-athlete coach assignment lives here.
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { requireAdmin, getCallerContext } from "./lib/adminGuard";
import { getAWSTNow } from "./lib/bookingWindow";

// ── helpers ─────────────────────────────────────────────────────────────────

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
  if (!caller.identity) throw new Error("Authentication required.");
  const callerCustomer = await getCallerCustomer(ctx);
  // Default target = the caller's own account.
  const targetId = (accountCustomerId as string) || callerCustomer?._id;
  if (!targetId) throw new Error("No account found for the current user.");
  if (caller.isAdmin) return { accountId: targetId, isAdmin: true };
  if (!callerCustomer || callerCustomer._id !== targetId) {
    throw new Error("You can only manage your own athletes.");
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
    name: v.string(),
    accountCustomerId: v.optional(v.id("customers")),
    dob: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId } = await authorizeAccount(ctx, args.accountCustomerId);
    const name = args.name.trim();
    if (!name) throw new Error("Athlete name is required.");
    return await ctx.db.insert("athletes", {
      accountCustomerId: accountId as any,
      name,
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
    name: v.optional(v.string()),
    dob: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const athlete = await ctx.db.get(args.athleteId);
    if (!athlete) throw new Error("Athlete not found.");
    await authorizeAccount(ctx, athlete.accountCustomerId);
    const updates: Record<string, any> = {};
    if (args.name !== undefined) {
      const n = args.name.trim();
      if (!n) throw new Error("Athlete name cannot be empty.");
      updates.name = n;
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
    if (!athlete) throw new Error("Athlete not found.");
    await authorizeAccount(ctx, athlete.accountCustomerId);
    // De-dupe + drop empties.
    const coachIds = Array.from(
      new Set(args.coachIds.map((c) => c.trim()).filter(Boolean))
    );
    await ctx.db.patch(args.athleteId, { assignedCoachIds: coachIds });
    return args.athleteId;
  },
});

export const removeAthlete = mutation({
  args: { athleteId: v.id("athletes") },
  handler: async (ctx, args) => {
    const athlete = await ctx.db.get(args.athleteId);
    if (!athlete) throw new Error("Athlete not found.");
    await authorizeAccount(ctx, athlete.accountCustomerId);
    if (await hasFutureAllocations(ctx, args.athleteId as string)) {
      throw new Error(
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
    if (!caller.identity) throw new Error("Authentication required.");
    const callerCustomer = await getCallerCustomer(ctx);
    // Only the coach themselves (by _id or email) or an admin may add.
    const isSelfCoach =
      callerCustomer &&
      callerCustomer.role === "coach" &&
      (callerCustomer._id === args.coachId ||
        callerCustomer.email === args.coachId.toLowerCase().trim());
    if (!caller.isAdmin && !isSelfCoach) {
      throw new Error("Only the coach or an admin can add athletes.");
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
      throw new Error("Parent email and child name are required.");
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
      return { status: "added", accountExists: true };
    }

    // No account — store a pending athlete-invite, email the parent.
    const existingInvite = await ctx.db
      .query("coachInvites")
      .withIndex("by_email", (q: any) => q.eq("email", parentEmail))
      .first();
    const token = `ath_${Math.abs(hashString(parentEmail + childName + coachIdNorm)).toString(36)}_${Date.now().toString(36)}`;
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
    if (!caller.identity) throw new Error("Authentication required.");
    const callerCustomer = await getCallerCustomer(ctx);
    const isSelfCoach =
      callerCustomer &&
      callerCustomer.role === "coach" &&
      (callerCustomer._id === args.coachId ||
        callerCustomer.email === args.coachId.toLowerCase().trim());
    if (!caller.isAdmin && !isSelfCoach) {
      throw new Error("Only the coach or an admin can remove athletes from a roster.");
    }
    const athlete = await ctx.db.get(args.athleteId);
    if (!athlete) throw new Error("Athlete not found.");
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
    return { success: true };
  },
});

// Small deterministic string hash (no Math.random in Convex determinism rules).
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

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
