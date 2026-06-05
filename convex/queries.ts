import { query, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireAdmin, getCallerContext, stripBookingPII } from "./lib/adminGuard";
import { validateDiscount } from "./lib/discounts";

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
  args: {},
  handler: async (ctx) => {
    const bookings = await ctx.db.query("bookings").collect();
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      // Unauthenticated — strip ALL PII (name/email/phone + access code, athlete
      // names, home postcode/suburb, notes, discount) via the shared stripper.
      // H1: the old inline strip left access codes + child names + postcode exposed.
      return bookings.map((b: any) => stripBookingPII(b));
    }

    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const callerCustomer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
      .first();

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
    const bookings = args.date
      ? await ctx.db
          .query("bookings")
          .withIndex("by_date", (q: any) => q.eq("date", args.date))
          .collect()
      : await ctx.db.query("bookings").collect();
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
    return rows.map((c: any) => ({ _id: c._id, name: c.name }));
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
      const callerCustomer = caller.email
        ? await ctx.db
            .query("customers")
            .withIndex("by_email", (q: any) => q.eq("email", caller.email))
            .first()
        : null;
      const matchesCoach =
        callerCustomer &&
        callerCustomer.role === "coach" &&
        (callerCustomer._id === args.coachId ||
          callerCustomer.email === args.coachId.toLowerCase().trim());
      if (!matchesCoach) return [];
    }

    // Resolve the coach to their _id (callers may pass an email).
    let coachId = args.coachId;
    const coachByEmail = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) =>
        q.eq("email", args.coachId.toLowerCase().trim())
      )
      .first();
    if (coachByEmail && coachByEmail.role === "coach") coachId = coachByEmail._id;

    // Athletes whose assignedCoachIds include this coach (either id form).
    const allAthletes = await ctx.db.query("athletes").collect();
    const matched = allAthletes.filter(
      (a: any) =>
        a.assignedCoachIds &&
        (a.assignedCoachIds.includes(coachId) ||
          a.assignedCoachIds.includes(args.coachId))
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

// Allocation change history for a booking (SPEC_COACH_ALLOCATION_AND_PLANNER
// Part 2). Admin, the coach who owns the booking, or the booking owner only.
// Newest first.
export const getAllocationAuditLog = query({
  args: { bookingId: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    const booking: any = await ctx.db.get(args.bookingId as any).catch(() => null);
    if (!booking) return [];
    const isOwnerOrCoach =
      caller.isAdmin ||
      (booking.customerEmail?.toLowerCase() === caller.email);
    if (!isOwnerOrCoach) return [];
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

    // Customer revenue from stripePayments (status: paid/complete)
    const payments = await ctx.db.query("stripePayments").collect();
    let custToday = 0, custWeek = 0, custMonth = 0;
    for (const p of payments) {
      const status = (p.status || "").toLowerCase();
      if (status === "refunded" || status === "failed" || status === "canceled" || status === "cancelled") continue;
      const amt = p.amount || 0;
      const dt = p.date || "";
      if (dt === todayStr) custToday += amt;
      if (inRange(dt, weekStartStr)) custWeek += amt;
      if (inRange(dt, monthStartStr)) custMonth += amt;
    }

    // Coach revenue (payments made to coaches)
    const coachPayments = await ctx.db.query("payments").collect();
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

// Get the global site settings (singleton)
export const getSiteSettings = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
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

// Validate a discount code — public (returns null if invalid/expired/exhausted).
// Pass customerEmail to also enforce the per-customer use limit.
export const validateDiscountCode = query({
  args: { code: v.string(), customerEmail: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Shared server-authoritative validator — same logic createBooking enforces
    // in the money path (R1/R3), so the client preview and the server agree.
    return await validateDiscount(ctx, args.code, args.customerEmail);
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
