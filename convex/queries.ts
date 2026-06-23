import { query, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireAdmin, getCallerContext, stripBookingPII } from "./lib/adminGuard";
import { validateDiscount } from "./lib/discounts";
import { resolveCanonicalCustomerByEmail, customerIdsForEmail } from "./lib/identity";

// Scope a list of bookings to the caller: full PII for own bookings (or admin),
// sanitised "Booked"/stripped for everyone else (SEC-1, decision #1).
function scopeBookings(
  bookings: any[],
  caller: { identity: any | null; email: string; isAdmin: boolean }
): any[] {
  if (caller.isAdmin) return bookings;
  return bookings.map((b: any) => {
    const isOwner =
      (caller.identity != null &&
        b.userId != null &&
        b.userId === caller.identity.subject) ||
      (caller.email !== "" && b.customerEmail?.toLowerCase() === caller.email);
    return isOwner ? b : stripBookingPII(b);
  });
}

// ============================================================================
// BOOKING QUERIES
// ============================================================================

// List all bookings — PII stripped server-side for non-admin callers (SEC-1 fix).
// Admins get full data. Authenticated users get full PII only for their own bookings.
// Unauthenticated users get scheduling data only (name/email/phone stripped).
export const listBookings = query({
  // E1: optional date window. The customer calendar passes a wide window so this no
  // longer scans the whole (ever-growing) bookings table; absent args = legacy full
  // scan (back-compat for any un-windowed caller).
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // LEAK-2 (audit 2026-06): this query is PUBLIC. Never let a caller force a full
    // scan of the (ever-growing) bookings table by omitting the window, nor scan
    // all-time via an absurd range. Clamp to a bounded window and ALWAYS read via the
    // by_date index. The real client window (today-400 .. today+120) fits inside.
    const awstDay = (offsetDays: number) =>
      new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
    const minFrom = awstDay(-400);
    const maxTo = awstDay(400);
    const from = args.from && args.from > minFrom ? args.from : minFrom;
    const to = args.to && args.to < maxTo ? args.to : maxTo;
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.gte("date", from).lte("date", to))
      .collect();
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      // Unauthenticated — strip ALL PII (name/email/phone + access code, athlete
      // names, home postcode/suburb, notes, discount) via the shared stripper.
      // H1: the old inline strip left access codes + child names + postcode exposed.
      return bookings.map((b: any) => stripBookingPII(b));
    }

    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    // Batch 2B: canonical resolution so a drifted row can't mis-detect an admin.
    const callerCustomer = await resolveCanonicalCustomerByEmail(ctx, callerEmail);

    if (callerCustomer?.role === "admin") {
      return bookings; // Admins see full PII for all bookings
    }

    // Authenticated non-admin: full PII for own bookings, stripped for others.
    return bookings.map((b: any) => {
      const isOwner =
        (b.userId != null && b.userId === identity.subject) ||
        b.customerEmail.toLowerCase() === callerEmail;
      return isOwner ? b : stripBookingPII(b);
    });
  },
});

// List bookings by date — PII scoped to caller (SEC-1).
export const listBookingsByDate = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
    return scopeBookings(bookings, await getCallerContext(ctx));
  },
});

// List bookings by lane and date — PII scoped to caller (SEC-1).
export const listBookingsByLaneAndDate = query({
  args: { laneId: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_laneId_date", (q: any) =>
        q.eq("laneId", args.laneId).eq("date", args.date)
      )
      .collect();
    return scopeBookings(bookings, await getCallerContext(ctx));
  },
});

// List bookings by user ID — own bookings only (or admin). Returns [] otherwise.
export const listBookingsByUserId = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    if (!caller.isAdmin && caller.identity.subject !== args.userId) {
      // A caller may only list their own bookings by userId.
      return [];
    }
    return await ctx.db
      .query("bookings")
      .withIndex("by_userId", (q: any) => q.eq("userId", args.userId))
      .collect();
  },
});

// List bookings by customer email — own bookings only (or admin). [] otherwise.
export const listBookingsByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    const normalized = args.email.toLowerCase().trim();
    if (!caller.identity) return [];
    if (!caller.isAdmin && caller.email !== normalized) return [];
    return await ctx.db
      .query("bookings")
      .withIndex("by_customerEmail", (q: any) =>
        q.eq("customerEmail", normalized)
      )
      .collect();
  },
});

// Get a single booking by ID — PII scoped to caller (SEC-1).
export const getBooking = query({
  args: { id: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.id);
    if (!booking) return null;
    const [scoped] = scopeBookings([booking], await getCallerContext(ctx));
    return scoped;
  },
});

// Public availability — slot + status only, NO PII. Safe for unauthenticated
// calendar rendering (SEC-1 build order #1).
export const listPublicAvailability = query({
  args: { date: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // LEAK-2 (audit 2026-06): public + currently unused. Never serve an
    // unauthenticated full-table scan — a single day must be requested.
    if (!args.date) return [];
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
    return bookings
      .filter((b: any) => b.status !== "cancelled")
      .map((b: any) => ({
        laneId: b.laneId,
        additionalLaneIds: b.additionalLaneIds,
        date: b.date,
        startHour: b.startHour,
        duration: b.duration,
        status: b.status,
      }));
  },
});

// SPEC_ATHLETE_SESSION_VISIBILITY_2026-06 — the sessions the CALLER'S OWN athletes
// (self + children) are allocated to inside a COACH's booking. The booking is owned
// by the coach, so the shared grid (listBookings) and the owner-scoped useMyBookings
// both strip / never carry those athleteSlots for the allocated athlete (a parent or
// coached adult who neither booked nor owns the row). This auth-scoped query is the
// ONLY path that surfaces them in My Bookings.
//
// It deliberately bypasses stripBookingPII and returns a HAND-BUILT, privacy-safe
// projection: only the caller's own athletes' slots (never other families' children),
// the coach's display name + the door code the caller is already emailed for their own
// session, and NO coach financials / event ids / notes. Bounded by the by_date index
// (never a full scan); only runs for accounts that actually have athletes.
export const listMyAthleteSessions = query({
  // forEmail: ADMIN-ONLY override to inspect another account's athlete sessions —
  // powers admin impersonation ("view as customer") + the audit. Ignored for
  // non-admin callers (they always resolve to their own account).
  args: { forEmail: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    const targetEmail =
      args.forEmail && caller.isAdmin
        ? args.forEmail.toLowerCase().trim()
        : caller.email;
    if (!targetEmail) return [];
    // Resolve the target's CANONICAL account row (athletes are keyed by the
    // canonical customers _id; a drifted duplicate must not split the match).
    const account = await resolveCanonicalCustomerByEmail(ctx, targetEmail);
    if (!account) return [];

    // The account's athletes (self-athlete + any children). Match slots by id OR
    // by name: an allocation can store a STALE athleteId (the athlete row was later
    // replaced/re-created — observed on Alex Szigligeti, whose slot id no longer
    // matched his live athlete), but athleteName is denormalised on the slot, so a
    // name match against THIS account's own athletes recovers it. Name matching is
    // scoped to the account's own athlete names → never surfaces another family's.
    const myAthletes = await ctx.db
      .query("athletes")
      .withIndex("by_account", (q: any) => q.eq("accountCustomerId", account._id))
      .collect();
    if (myAthletes.length === 0) return [];
    const myAthleteIds = new Set<string>(myAthletes.map((a: any) => String(a._id)));
    const myAthleteNames = new Set<string>(
      myAthletes.map((a: any) => String(a.name ?? "").toLowerCase().trim()).filter(Boolean)
    );
    const slotIsMine = (s: any) =>
      (s.athleteId && myAthleteIds.has(String(s.athleteId))) ||
      (s.athleteName && myAthleteNames.has(String(s.athleteName).toLowerCase().trim()));

    // Bounded read via by_date — never a full scan. A coach's athleteSlots are
    // embedded in the COACH-owned row, so (unlike the owner's own history, which is
    // index-served by email/userId) this MUST date-scan. To avoid re-introducing the
    // broad reactive subscription COST-1 just removed (this query re-runs for every
    // athlete-account viewer on any booking write in range), the window is bounded to
    // [-120d .. +200d] AWST: covers a season of Past sessions + the longest coach
    // repeat horizon (~3 months, e.g. Paolo's block), not the full ±400d of listBookings.
    const awstDay = (offsetDays: number) =>
      new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.gte("date", awstDay(-120)).lte("date", awstDay(200)))
      .collect();

    const out: any[] = [];
    for (const b of bookings as any[]) {
      if (b.isCoachBooking !== true) continue;
      if (b.status === "cancelled") continue;
      // ONLY the target account's own athletes' slots — never return another
      // client's child's name/time/code.
      const mySlots = (b.athleteSlots ?? []).filter(slotIsMine);
      if (mySlots.length === 0) continue;
      out.push({
        _id: b._id,
        date: b.date,
        startHour: b.startHour,
        duration: b.duration,
        laneId: b.laneId,
        variantId: b.variantId ?? null,
        additionalLaneIds: b.additionalLaneIds,
        laneNameSnapshot: b.laneNameSnapshot,
        variantLabelSnapshot: b.variantLabelSnapshot,
        // Coach's display name — not private; already in the allocation email. The
        // coach's email/phone are deliberately NOT returned (customerEmail stays "").
        customerName: b.customerName,
        isCoachBooking: true,
        status: b.status,
        // The booking door code — the caller is entitled to it for their own
        // session (it's already in their allocation email).
        accessCode: b.accessCode,
        athleteSlots: mySlots.map((s: any) => ({
          athleteId: s.athleteId,
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
          accessCode: s.accessCode ?? b.accessCode,
        })),
      });
    }
    return out;
  },
});

// ============================================================================
// STRIPE PAYMENT QUERIES
// ============================================================================

// List all stripePayments — admin only (contains customer PII + payment amounts)
export const listStripePayments = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("stripePayments").collect();
  },
});

// Get a single stripePayment by ID — admin or the paying customer only.
export const getStripePayment = query({
  args: { id: v.id("stripePayments") },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return null;
    const payment = await ctx.db.get(args.id);
    if (!payment) return null;
    if (caller.isAdmin) return payment;
    if (payment.customerEmail?.toLowerCase() === caller.email) return payment;
    return null;
  },
});

// A customer's own Stripe payments / invoices (the checkout receipts) — self or
// admin only; [] otherwise. Powers the "Tax Invoices & Receipts" list on the
// customer Payments screen. Newest first (by record creation time).
export const listMyStripePayments = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    const normalized = args.email.toLowerCase().trim();
    if (!caller.isAdmin && caller.email !== normalized) return [];
    const rows = await ctx.db
      .query("stripePayments")
      .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", normalized))
      .collect();
    return rows
      .map((p: any) => ({
        _id: p._id,
        bookingId: p.bookingId,
        stripeSessionId: p.stripeSessionId,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        laneName: p.laneName,
        date: p.date,
        description: p.description,
        receiptUrl: p.receiptUrl ?? null,
        createdAt: p._creationTime,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

// ============================================================================
// CUSTOMER QUERIES
// ============================================================================

// List all customers — admin only (contains PII for all users)
export const listCustomers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    // Hide deactivated / merged-away accounts (SPEC_MERGE_DUPLICATE_ACCOUNTS) —
    // a soft-deleted loser row should not appear in any admin customer list.
    const rows = await ctx.db.query("customers").collect();
    return rows.filter((c: any) => !c.deactivatedAt);
  },
});

// Get customer by email — self or admin only (returns null otherwise).
export const getCustomerByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return null;
    const normalized = args.email.toLowerCase().trim();
    if (!caller.isAdmin && caller.email !== normalized) return null;
    return await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalized))
      .first();
  },
});

// List customers by role.
// Admin → full records. Authenticated non-admin → name/id/role only (no contact
// PII), so coach pickers keep working without leaking email/phone/credit.
// Unauthenticated → [].
export const listCustomersByRole = query({
  args: { role: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    const rows = await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", args.role))
      .collect();
    if (caller.isAdmin) return rows;
    return rows.map((c: any) => ({
      _id: c._id,
      name: c.name,
      role: c.role,
      color: c.color,
      coachTier: c.coachTier,
      defaultSessionDuration: c.defaultSessionDuration,
      athleteCapacity: c.athleteCapacity,
    }));
  },
});

// SPEC_SIGNUP_UPDATES_2026-06 G2/G4 — public coach list for the SIGNUP form,
// where the caller is not yet authenticated (listCustomersByRole returns [] for
// anon callers). Returns ONLY the opaque _id + display name — no email, phone,
// tier or other PII. Coaches are public-facing for a coaching business, and the
// write path that consumes these ids (athletes.setupAthletesAtSignup) is still
// auth-gated to the caller's own account, so exposing the roster is low-risk.
export const listCoachesPublic = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", "coach"))
      .collect();
    // Exclude coaches flagged hidden from the public list (e.g. the owner account).
    return rows
      .filter((c: any) => c.hideFromPublicCoachList !== true)
      .map((c: any) => ({ _id: c._id, name: c.name }));
  },
});

// Get customer by ID — self or admin only (returns null otherwise).
export const getCustomer = query({
  args: { id: v.id("customers") },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return null;
    const customer = await ctx.db.get(args.id);
    if (!customer) return null;
    if (caller.isAdmin) return customer;
    if (customer.email?.toLowerCase() === caller.email) return customer;
    return null;
  },
});

// List ATHLETES assigned to a specific coach (SPEC_PARENT_ATHLETE_MODEL).
// Reads the athletes table (not customers) so the allocation editor + planner
// show the kid's name; also returns the owning account's contact details so the
// coach can reach the parent (decision #10 — own assigned athletes ONLY, never
// other families). coachId can be the Convex _id or the coach's email.
export const listAthletesByCoach = query({
  args: { coachId: v.string() },
  handler: async (ctx, args) => {
    if (!args.coachId) return [];
    // Auth: only the coach themselves (by _id or email) or an admin may list a
    // coach's athletes. Returns [] for anyone else.
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    if (!caller.isAdmin) {
      // Batch 2B: resolve the CANONICAL coach row (prefer coach/admin), not .first().
      const callerCustomer = await resolveCanonicalCustomerByEmail(ctx, caller.email);
      const matchesCoach =
        callerCustomer &&
        callerCustomer.role === "coach" &&
        (callerCustomer._id === args.coachId ||
          callerCustomer.email === args.coachId.toLowerCase().trim());
      if (!matchesCoach) return [];
    }

    // Batch 2C: gather EVERY id form this coach has been known by — the canonical
    // customers _id PLUS any duplicate rows sharing the coach's email — so athletes
    // pointing at a historical/duplicate id still match (the broken Dean↔Bree link).
    // args.coachId may be an email or an id; resolve the email either way.
    const idForms = new Set<string>([args.coachId]);
    let coachEmail: string | null = args.coachId.includes("@")
      ? args.coachId.toLowerCase().trim()
      : null;
    if (!coachEmail) {
      let coachRow: any = null;
      try { coachRow = await ctx.db.get(args.coachId as any); } catch { coachRow = null; }
      if (coachRow?.email) coachEmail = String(coachRow.email).toLowerCase().trim();
    }
    if (coachEmail) {
      for (const id of await customerIdsForEmail(ctx, coachEmail)) idForms.add(id);
    }

    // Athletes whose assignedCoachIds include ANY of the coach's id forms.
    const allAthletes = await ctx.db.query("athletes").collect();
    const matched = allAthletes.filter(
      (a: any) =>
        a.assignedCoachIds &&
        a.assignedCoachIds.some((cid: string) => idForms.has(cid))
    );

    // Enrich with the owning account's contact details.
    const accountCache = new Map<string, any>();
    const results: any[] = [];
    for (const a of matched) {
      let account = accountCache.get(a.accountCustomerId);
      if (account === undefined) {
        account = await ctx.db.get(a.accountCustomerId);
        accountCache.set(a.accountCustomerId, account);
      }
      results.push({
        _id: a._id,
        name: a.name,
        accountCustomerId: a.accountCustomerId,
        accountEmail: account?.email ?? "",
        accountName: account?.name ?? "",
        accountPhone: account?.phone ?? "",
        isSelf: a.isSelf ?? false,
        // `email` kept for back-compat with the existing editor UI (it renders
        // a secondary line / searches on it) — surfaces the parent's email.
        email: account?.email ?? "",
      });
    }
    return results;
  },
});

// Smart athlete ordering for SEQUENTIAL allocation (2026-06). Scores a coach's
// athletes by their session history over the last 5 weeks relative to a target
// start time: sessions at the EXACT start time weigh most, then sessions CLOSE to
// it (proximity-weighted). Athletes with no history get no score → the client
// orders them alphabetically last. Returns { athleteId: score }. Coach-scoped
// (own coach bookings only), mirroring listAthletesByCoach's auth guard.
export const rankAthletesForAllocation = query({
  args: { coachId: v.string(), startHour: v.number() },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    if (!args.coachId) return {};
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return {};
    const callerCustomer = await resolveCanonicalCustomerByEmail(ctx, caller.email);
    if (!caller.isAdmin) {
      const matchesCoach =
        callerCustomer &&
        callerCustomer.role === "coach" &&
        (callerCustomer._id === args.coachId ||
          callerCustomer.email === args.coachId.toLowerCase().trim());
      if (!matchesCoach) return {};
    }
    // Resolve the coach's email (coachId may be an _id or an email).
    let coachEmail: string | null = args.coachId.includes("@")
      ? args.coachId.toLowerCase().trim()
      : null;
    if (!coachEmail) {
      let row: any = null;
      try { row = await ctx.db.get(args.coachId as any); } catch { row = null; }
      coachEmail = row?.email
        ? String(row.email).toLowerCase().trim()
        : callerCustomer?.email ?? null;
    }
    if (!coachEmail) return {};

    // Last 5 weeks (35 days), AWST date key.
    const cutoff = new Date(Date.now() + 8 * 3600000 - 35 * 86400000);
    const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}-${String(cutoff.getUTCDate()).padStart(2, "0")}`;

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", coachEmail))
      .collect();

    const score: Record<string, number> = {};
    for (const b of bookings as any[]) {
      if (!b.isCoachBooking || b.status === "cancelled") continue;
      if ((b.date ?? "") < cutoffKey) continue;
      for (const s of b.athleteSlots ?? []) {
        const aid = s.athleteId;
        if (!aid) continue;
        const diff = Math.abs((s.startHour ?? 0) - args.startHour);
        const w = diff < 0.01 ? 10 : diff <= 0.25 ? 6 : diff <= 0.5 ? 4 : diff <= 1 ? 2 : 1;
        score[aid] = (score[aid] ?? 0) + w;
      }
    }
    return score;
  },
});

// Allocation change history for a booking (SPEC_COACH_ALLOCATION_AND_PLANNER
// Part 2). Admin or the booking owner only (S2: the code grants no coach branch —
// comment corrected to match). Newest first.
export const getAllocationAuditLog = query({
  args: { bookingId: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    const booking: any = await ctx.db.get(args.bookingId as any).catch(() => null);
    if (!booking) return [];
    const isOwnerOrAdmin =
      caller.isAdmin ||
      (booking.customerEmail?.toLowerCase() === caller.email);
    if (!isOwnerOrAdmin) return [];
    const rows = await ctx.db
      .query("allocationAuditLog")
      .withIndex("by_booking", (q: any) => q.eq("bookingId", args.bookingId))
      .collect();
    return rows.sort((a: any, b: any) => (a.at < b.at ? 1 : -1));
  },
});

// ============================================================================
// COACH INVITE QUERIES
// ============================================================================

// List all coach invites — admin only
export const listCoachInvites = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("coachInvites").order("desc").collect();
  },
});

// Get coach invite by token
export const getCoachInviteByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    // S-3: anyone holding (or guessing) a token could read the FULL invite doc —
    // including createdBy (the admin's identity), the invitee's phone, and the
    // raw token. Return only the non-sensitive fields a /join-equivalent UI needs.
    const invite = await ctx.db
      .query("coachInvites")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first();
    if (!invite || invite.used) return { valid: false as const };
    return {
      valid: true as const,
      kind: invite.kind ?? "coach",
      name: invite.name,
      childName: invite.childName,
    };
  },
});

// ============================================================================
// WAITLIST QUERIES
// ============================================================================

// List all waitlist entries — admin only (contains user PII)
export const listWaitlistEntries = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("waitlist").collect();
  },
});

// Admin waitlist + offer dashboard (SPEC_WAITLIST_OFFER_REDESIGN). Returns every
// non-terminal waitlist entry (waiting/offered) with PII + the active first-
// refusal holds, so the admin UI can show queues, the current offeree, and a
// live countdown. Entries come back oldest-first (queue order).
export const listWaitlistAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const all = await ctx.db.query("waitlist").collect();
    const entries = all
      .filter((e: any) => {
        const st = e.status ?? "waiting";
        return st === "waiting" || st === "offered";
      })
      .sort((a: any, b: any) => a._creationTime - b._creationTime)
      .map((e: any) => ({
        _id: e._id,
        userId: e.userId,
        userName: e.userName,
        userEmail: e.userEmail,
        laneId: e.laneId,
        date: e.date,
        hour: e.hour,
        status: e.status ?? "waiting",
        offerExpiresAt: e.offerExpiresAt ?? null,
        createdAt: e._creationTime,
      }));
    const now = Date.now();
    const holds = (await ctx.db.query("slotHolds").collect())
      .filter((h: any) => h.holdType === "waitlist" && h.expiresAt > now)
      .map((h: any) => ({
        laneId: h.laneId,
        date: h.date,
        startHour: h.startHour,
        userId: h.userId,
        userEmail: h.userEmail,
        expiresAt: h.expiresAt,
      }));
    return { entries, holds };
  },
});

// List waitlist entries by user — self or admin only.
export const listWaitlistByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    if (!caller.isAdmin && caller.identity.subject !== args.userId) return [];
    return await ctx.db
      .query("waitlist")
      .withIndex("by_userId", (q: any) => q.eq("userId", args.userId))
      .collect();
  },
});

// Strip identifying fields from a waitlist row for non-admin callers, keeping
// only what's needed to compute position/membership.
function scopeWaitlist(rows: any[], caller: { isAdmin: boolean; identity: any | null }) {
  if (caller.isAdmin) return rows;
  return rows.map((w: any) => ({
    _id: w._id,
    laneId: w.laneId,
    date: w.date,
    hour: w.hour,
    notified: w.notified,
    // status is not identifying — needed to count only ACTIVE waiters publicly
    // (SPEC_MOBILE_BOOKING_UPDATES §4.5). Absent legacy rows read as 'waiting'.
    status: w.status ?? "waiting",
    isMine: caller.identity != null && w.userId === caller.identity.subject,
  }));
}

// List waitlist entries for a specific slot — PII scoped (position/count only).
export const listWaitlistForSlot = query({
  args: { laneId: v.string(), date: v.string(), hour: v.number() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    const rows = await ctx.db
      .query("waitlist")
      .withIndex("by_slot", (q: any) =>
        q.eq("laneId", args.laneId).eq("date", args.date).eq("hour", args.hour)
      )
      .collect();
    return scopeWaitlist(rows, caller);
  },
});

// List waitlist entries for a lane+date — PII scoped (position/count only).
export const listWaitlistByLaneDate = query({
  args: { laneId: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    const rows = await ctx.db
      .query("waitlist")
      .withIndex("by_laneId_date", (q: any) =>
        q.eq("laneId", args.laneId).eq("date", args.date)
      )
      .collect();
    return scopeWaitlist(rows, caller);
  },
});

// List waitlist notifications for a user — self or admin only.
export const listWaitlistNotifications = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    if (!caller.isAdmin && caller.identity.subject !== args.userId) return [];
    return await ctx.db
      .query("waitlistNotifications")
      .withIndex("by_userId", (q: any) => q.eq("userId", args.userId))
      .collect();
  },
});

// ============================================================================
// PAYMENT QUERIES
// ============================================================================

// List all payments — admin only (financial data)
export const listPayments = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("payments").collect();
  },
});

// List payments by coach — the coach themselves (by _id or email) or admin.
export const listPaymentsByCoach = query({
  args: { coachId: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    if (!caller.isAdmin) {
      const callerCustomer = caller.email
        ? await ctx.db
            .query("customers")
            .withIndex("by_email", (q: any) => q.eq("email", caller.email))
            .first()
        : null;
      const isThisCoach =
        callerCustomer &&
        callerCustomer.role === "coach" &&
        (callerCustomer._id === args.coachId ||
          callerCustomer.email === args.coachId.toLowerCase().trim());
      if (!isThisCoach) return [];
    }
    return await ctx.db
      .query("payments")
      .withIndex("by_coachId", (q: any) => q.eq("coachId", args.coachId))
      .collect();
  },
});

// FEA-8 (audit 2026-06): all coach balances in ONE admin query, replacing the two
// reactive queries fired PER coach row (24+ live subscriptions that shipped each
// coach's full booking + payment history just to total a balance badge). Replicates
// the exact client filter that CoachBalanceCells used:
//   CHARGES  = Σ coachPrice over a coach's non-cancelled coach bookings dated today
//              or earlier (bookings link to a coach by customerEmail);
//   PAYMENTS = Σ payments.amount by coachId; last-paid = newest dateReceived.
export const listCoachBalances = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const todayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

    // Coach charges grouped by the coach's lowercased email. Read only bookings dated
    // up to today via the by_date index (future bookings aren't billed yet), matching
    // the old client filter ((b.date || '') > todayStr → excluded).
    const chargedByEmail = new Map<string, number>();
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.lte("date", todayKey))
      .collect();
    for (const b of bookings) {
      if (b.status === "cancelled") continue;
      const isCoachCharge =
        b.isCoachBooking === true ||
        (typeof b.coachPrice === "number" && b.coachPrice > 0);
      if (!isCoachCharge) continue;
      const email = (b.customerEmail ?? "").toLowerCase().trim();
      if (!email) continue;
      chargedByEmail.set(email, (chargedByEmail.get(email) ?? 0) + (Number(b.coachPrice) || 0));
    }

    // Payments + last-paid grouped by coachId.
    const payments = await ctx.db.query("payments").collect();
    const paidByCoach = new Map<string, number>();
    const lastPaidByCoach = new Map<string, string>();
    for (const p of payments as any[]) {
      const cid = String(p.coachId ?? "");
      if (!cid) continue;
      paidByCoach.set(cid, (paidByCoach.get(cid) ?? 0) + (Number(p.amount) || 0));
      const dr = p.dateReceived ?? "";
      if (dr > (lastPaidByCoach.get(cid) ?? "")) lastPaidByCoach.set(cid, dr);
    }

    const coaches = await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", "coach"))
      .collect();
    return coaches.map((c: any) => {
      const cid = String(c._id);
      const totalCharged = chargedByEmail.get((c.email ?? "").toLowerCase().trim()) ?? 0;
      const totalPaid = paidByCoach.get(cid) ?? 0;
      return {
        coachId: cid,
        totalCharged,
        totalPaid,
        balance: totalCharged - totalPaid,
        lastPaidDate: lastPaidByCoach.get(cid) ?? null,
      };
    });
  },
});


// ============================================================================
// CUSTOMER PAYMENTS + CREDIT HISTORY (SPEC_PAYMENTS_AND_CREDIT #5)
// ============================================================================

// A customer's own payment history, derived from their bookings. Self or admin
// only; [] otherwise. Coach bookings (weekly-billed, not prepaid) are excluded.
export const listMyPayments = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    const normalized = args.email.toLowerCase().trim();
    if (!caller.identity) return [];
    if (!caller.isAdmin && caller.email !== normalized) return [];
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", normalized))
      .collect();
    return bookings
      .filter(
        (b: any) =>
          !b.isCoachBooking &&
          ((b.priceInCents ?? 0) > 0 || (b.creditApplied ?? 0) > 0)
      )
      .map((b: any) => ({
        bookingId: b._id.toString(),
        date: b.date,
        laneId: b.laneId,
        startHour: b.startHour,
        duration: b.duration,
        amountPaid: (b.priceInCents ?? 0) / 100,
        creditApplied: b.creditApplied ?? 0,
        status: b.status,
        paymentStatus: b.paymentStatus,
        stripeSessionId: b.stripeSessionId,
        discountCode: b.discountCode,
      }));
  },
});

// A customer's credit-movement history (creditLedger). Self or admin only.
export const listCreditLedger = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    const normalized = args.email.toLowerCase().trim();
    if (!caller.identity) return [];
    if (!caller.isAdmin && caller.email !== normalized) return [];
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalized))
      .first();
    if (!customer) return [];
    return await ctx.db
      .query("creditLedger")
      .withIndex("by_customerId", (q: any) => q.eq("customerId", customer._id))
      .collect();
  },
});

// ============================================================================
// REVENUE BREAKDOWN QUERIES
// ============================================================================

// Returns daily/weekly/monthly totals for customer revenue (stripePayments)
// and coach revenue (payments table). Admin only — contains financial data.
export const getRevenueBreakdown = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayStr = `${y}-${pad(m + 1)}-${pad(d)}`;

    // Week start = Monday
    const day = now.getDay(); // 0=Sun
    const diffToMon = day === 0 ? -6 : 1 - day;
    const weekStart = new Date(y, m, d + diffToMon);
    const weekStartStr = `${weekStart.getFullYear()}-${pad(weekStart.getMonth() + 1)}-${pad(weekStart.getDate())}`;
    const monthStartStr = `${y}-${pad(m + 1)}-01`;

    const inRange = (dateStr: string, start: string) =>
      dateStr >= start && dateStr <= todayStr;
    // E4a: weekStart can precede monthStart at a month boundary, so the index lower
    // bound is the earlier of the two.
    const rangeStart = weekStartStr < monthStartStr ? weekStartStr : monthStartStr;

    // Customer revenue from stripePayments (status: paid/complete)
    // E4a: read only [rangeStart..today] via by_date instead of scanning all payments.
    const payments = await ctx.db
      .query("stripePayments")
      .withIndex("by_date", (q: any) => q.gte("date", rangeStart).lte("date", todayStr))
      .collect();
    let custToday = 0, custWeek = 0, custMonth = 0;
    for (const p of payments) {
      const status = (p.status || "").toLowerCase();
      // MON-5 (audit 2026-06): count ONLY genuinely-paid rows. Allowlist (not a
      // denylist) so non-revenue statuses — e.g. "refund_due" (paid-after-cancel
      // orphan) and any future status — can never inflate revenue.
      if (status !== "paid" && status !== "complete") continue;
      const amt = p.amount || 0;
      const dt = p.date || "";
      if (dt === todayStr) custToday += amt;
      if (inRange(dt, weekStartStr)) custWeek += amt;
      if (inRange(dt, monthStartStr)) custMonth += amt;
    }

    // Coach revenue (payments made to coaches)
    // E4a: bound by the by_dateReceived index over the same window.
    const coachPayments = await ctx.db
      .query("payments")
      .withIndex("by_dateReceived", (q: any) =>
        q.gte("dateReceived", rangeStart).lte("dateReceived", todayStr)
      )
      .collect();
    let coachToday = 0, coachWeek = 0, coachMonth = 0;
    const coachBreakdown: Record<string, { today: number; week: number; month: number }> = {};
    for (const p of coachPayments) {
      const amt = p.amount || 0;
      const dt = p.dateReceived || "";
      if (!coachBreakdown[p.coachId]) coachBreakdown[p.coachId] = { today: 0, week: 0, month: 0 };
      if (dt === todayStr) { coachToday += amt; coachBreakdown[p.coachId].today += amt; }
      if (inRange(dt, weekStartStr)) { coachWeek += amt; coachBreakdown[p.coachId].week += amt; }
      if (inRange(dt, monthStartStr)) { coachMonth += amt; coachBreakdown[p.coachId].month += amt; }
    }

    return {
      todayStr,
      weekStartStr,
      monthStartStr,
      customer: { today: custToday, week: custWeek, month: custMonth },
      coach: { today: coachToday, week: coachWeek, month: coachMonth },
      coachBreakdown,
    };
  },
});

// ============================================================================
// EMAIL TEMPLATE QUERIES (user-facing notification preferences)
// ============================================================================

// Returns the list of email templates a user can opt in/out of.
// Mandatory transactional templates (password-reset, email-verification) are excluded.
export const listEmailTemplates = query({
  args: {},
  handler: async (_ctx) => {
    return [
      { slug: "booking-confirmation", label: "Booking Confirmation", description: "Sent when you successfully book a lane." },
      { slug: "booking-cancellation", label: "Booking Cancellation", description: "Sent when a booking is cancelled." },
      { slug: "booking-rescheduled", label: "Booking Rescheduled", description: "Sent when a booking is moved to a new time." },
      { slug: "booking-reminder", label: "Booking Reminder", description: "Reminder a few hours before your session." },
      { slug: "athlete-allocation", label: "Coach Session Allocation", description: "Sent when your coach allocates you a training session." },
      { slug: "waitlist-confirmation", label: "Waitlist Confirmation", description: "Sent when you join a waitlist." },
      { slug: "waitlist-vacancy", label: "Waitlist Vacancy Alerts", description: "Sent when a waitlisted slot opens up." },
      { slug: "welcome", label: "Welcome Email", description: "Sent when you create your account." },
    ];
  },
});

// ============================================================================
// SITE SETTINGS QUERIES
// ============================================================================

// Get the global site settings (singleton).
// PUBLIC + unauthenticated (read on every page load for booking prices/hours), so
// it must NOT leak ops-only fields. `reservedAccessCodes` holds the permanent
// staff front-door PINs (C3 door-code work) — stripped here so an anonymous
// visitor of an unstaffed facility can't read live entry codes from the network
// tab (audit 2026-06-10 security #4). Server code that needs the reserved set
// reads the siteSettings row directly, not through this query.
export const getSiteSettings = query({
  args: {},
  handler: async (ctx) => {
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    if (!settings) return null;
    const { reservedAccessCodes, ...publicSettings } = settings as any;
    return publicSettings;
  },
});

// R1 — authoritative amount Stripe should charge for a booking, in cents.
// createCheckoutSession (a node action that can't touch the DB) calls this so the
// charge is derived ENTIRELY from server state: the booking's server-computed
// priceInCents minus the customer's credit, with credit clamped to their actual
// balance (a client can't inflate creditApplied to underpay). Returns null if the
// booking is missing. Internal — only the checkout action calls it.
export const getCheckoutAmountCents = internalQuery({
  args: { bookingId: v.string() },
  handler: async (ctx, args): Promise<number | null> => {
    const booking = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (!booking) return null;
    const b = booking as any;
    // Modify/extend top-up (audit 2026-06-10 money-hole #2): a booking awaiting a
    // top-up payment must be charged ONLY the price difference, not its full
    // original price. modifyBooking leaves priceInCents at the original value and
    // stashes the (already credit-adjusted) amount due in pendingEdit.priceDifference;
    // the credit it accounts for is redeemed separately on confirm (pe.creditApplied),
    // so do NOT subtract credit again here.
    if (b.status === "pending_edit_payment" && b.pendingEdit) {
      return Math.max(0, Math.round(b.pendingEdit.priceDifference ?? 0));
    }
    const priceCents = Math.max(0, Math.round(b.priceInCents ?? 0));
    // Clamp the credit to the customer's real balance at charge time.
    const email = (b.customerEmail ?? "").toLowerCase().trim();
    let creditAvailCents = 0;
    if (email) {
      const customer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", email))
        .first();
      creditAvailCents = Math.round(((customer?.creditBalance ?? 0) as number) * 100);
    }
    const requestedCreditCents = Math.round(((b.creditApplied ?? 0) as number) * 100);
    const creditCents = Math.max(0, Math.min(requestedCreditCents, creditAvailCents, priceCents));
    return Math.max(0, priceCents - creditCents);
  },
});

// LOW (SEC audit 2026-06-03): owner identifiers for a booking, used by the
// checkout action to assert the caller owns the booking they're paying for.
export const getBookingOwner = internalQuery({
  args: { bookingId: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<{ userId: string | null; customerEmail: string | null } | null> => {
    const booking = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (!booking) return null;
    const b = booking as any;
    return {
      userId: b.userId ?? null,
      customerEmail: b.customerEmail ? String(b.customerEmail).toLowerCase().trim() : null,
    };
  },
});

// SPEC_CHECKOUT_ABANDONMENT — payment/lifecycle state for an unpaid checkout
// booking, read by the Stripe node action that expires + releases it. Returning
// the stored sessionId lets the expiry action skip a booking whose session was
// superseded by a "Pay now" resume (a newer session id).
export const getBookingPaymentState = internalQuery({
  args: { bookingId: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<{ status: string; paymentStatus: string | null; stripeSessionId: string | null } | null> => {
    const booking = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (!booking) return null;
    const b = booking as any;
    return {
      status: String(b.status ?? ""),
      paymentStatus: b.paymentStatus ?? null,
      stripeSessionId: b.stripeSessionId ?? null,
    };
  },
});

// SPEC_CHECKOUT_ABANDONMENT — how long after a checkout session is created the
// unpaid booking is auto-cancelled (admin-tunable; default 10 min). The session
// is actively expired at this point so the customer can't pay a freed slot.
export const getQuickCheckoutMs = internalQuery({
  args: {},
  handler: async (ctx): Promise<number> => {
    const s = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const minutes = (s as any)?.abandonedCheckoutQuickMinutes ?? 10;
    return Math.max(2, minutes) * 60 * 1000;
  },
});

// Is the given email an admin (by the customers table)? Internal — used by node
// actions (createPaymentLink) that can't run requireAdmin's DB fallback directly.
// Matches getCallerContext's admin resolution, avoiding the user.role-only drift.
export const isAdminEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const email = args.email.toLowerCase().trim();
    if (!email) return false;
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    return customer?.role === "admin";
  },
});

// ============================================================================
// DISCOUNT CODE QUERIES
// ============================================================================

// List all discount codes — admin only
export const listDiscountCodes = query({
  args: {},
  handler: async (ctx) => {
    // Check admin via customers table (same pattern as requireAdmin)
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const caller = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
      .first();
    if (caller?.role !== "admin") return [];
    return await ctx.db.query("discountCodes").collect();
  },
});

// Validate a discount code (returns null if invalid/expired/exhausted).
// LEAK-5 (audit 2026-06): was unauthenticated + trusted a client-supplied
// customerEmail → promo-code enumeration + a per-customer-cap oracle. Now requires
// auth (the only caller is the logged-in booking modal) and derives the email from
// the verified identity. The legacy `customerEmail` arg is kept (optional) but
// IGNORED so a stale cached client doesn't get an arg-validation rejection.
export const validateDiscountCode = query({
  args: { code: v.string(), customerEmail: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null; // booking requires sign-in; no public preview/oracle
    const email = identity.email?.toLowerCase?.().trim?.() || undefined;
    // Shared server-authoritative validator — same logic createBooking enforces
    // in the money path (R1/R3), so the client preview and the server agree.
    return await validateDiscount(ctx, args.code, email);
  },
});

// ============================================================================
// DRY-RUN PREVIEW: which coach bookings would be merged
// Returns chains of consecutive same-lane same-day blocks without modifying data
// ============================================================================
export const previewMergeConsecutiveCoachBookings = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx); // admin-only merge preview (exposes coach schedule)
    // Fetch all non-cancelled coach bookings
    const allBookings = await ctx.db
      .query("bookings")
      .filter((q: any) => q.eq(q.field("isCoachBooking"), true))
      .collect();

    const active = allBookings.filter((b: any) => b.status !== "cancelled");

    const LANE_NAMES: Record<string, string> = {
      bm1: "Bowling Machine 1",
      bm2: "Bowling Machine 2",
      bm3: "Bowling Machine 3",
      ru1: "9m Run Up 1",
      ru2: "9m Run Up 2",
    };

    const fmtH = (h: number) => {
      const w = Math.floor(h);
      const m = Math.round((h - w) * 60);
      const period = w >= 12 ? "pm" : "am";
      const dh = w > 12 ? w - 12 : w === 0 ? 12 : w;
      return `${dh}:${m.toString().padStart(2, "0")}${period}`;
    };

    // Group by coach email + laneId + date
    const groups = new Map<string, typeof active>();
    for (const b of active) {
      const key = `${(b.customerEmail as string).toLowerCase()}|${b.laneId}|${b.date}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b);
    }

    const chains: Array<{
      coachName: string;
      date: string;
      laneName: string;
      mergedStartLabel: string;
      mergedEndLabel: string;
      mergedDuration: number;
      accessCode: string | undefined;
      blocks: Array<{
        id: string;
        startLabel: string;
        endLabel: string;
        duration: number;
        accessCode: string | undefined;
      }>;
    }> = [];

    for (const bookings of groups.values()) {
      if (bookings.length < 2) continue;
      bookings.sort((a: any, b: any) => a.startHour - b.startHour);

      let i = 0;
      while (i < bookings.length) {
        const chain: typeof bookings = [bookings[i]];
        let j = i + 1;
        while (j < bookings.length) {
          const prev = chain[chain.length - 1] as any;
          const curr = bookings[j] as any;
          const prevEnd = prev.startHour + prev.duration / 60;
          if (Math.abs(prevEnd - curr.startHour) < 0.017) {
            chain.push(curr);
            j++;
          } else {
            break;
          }
        }

        if (chain.length >= 2) {
          const first = chain[0] as any;
          const totalDuration = chain.reduce((s: number, b: any) => s + b.duration, 0);
          const mergedEnd = first.startHour + totalDuration / 60;

          chains.push({
            coachName: first.customerName as string,
            date: first.date as string,
            laneName: LANE_NAMES[first.laneId as string] ?? (first.laneId as string),
            mergedStartLabel: fmtH(first.startHour),
            mergedEndLabel: fmtH(mergedEnd),
            mergedDuration: totalDuration,
            accessCode: first.accessCode as string | undefined,
            blocks: chain.map((b: any) => ({
              id: b._id as string,
              startLabel: fmtH(b.startHour),
              endLabel: fmtH(b.startHour + b.duration / 60),
              duration: b.duration as number,
              accessCode: b.accessCode as string | undefined,
            })),
          });
        }

        i = j;
      }
    }

    // Sort results by date then coachName for a predictable display order
    chains.sort((a, b) => a.date.localeCompare(b.date) || a.coachName.localeCompare(b.coachName));

    return chains;
  },
});
