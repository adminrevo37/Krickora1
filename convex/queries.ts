import { query } from "./_generated/server";
import { v } from "convex/values";

// ============================================================================
// BOOKING QUERIES
// ============================================================================

// List all bookings (active, not cancelled)
export const listBookings = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("bookings").collect();
  },
});

// List bookings by date
export const listBookingsByDate = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
  },
});

// List bookings by lane and date
export const listBookingsByLaneAndDate = query({
  args: { laneId: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bookings")
      .withIndex("by_laneId_date", (q: any) =>
        q.eq("laneId", args.laneId).eq("date", args.date)
      )
      .collect();
  },
});

// List bookings by user ID
export const listBookingsByUserId = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bookings")
      .withIndex("by_userId", (q: any) => q.eq("userId", args.userId))
      .collect();
  },
});

// List bookings by customer email
export const listBookingsByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bookings")
      .withIndex("by_customerEmail", (q: any) =>
        q.eq("customerEmail", args.email.toLowerCase().trim())
      )
      .collect();
  },
});

// Get a single booking by ID
export const getBooking = query({
  args: { id: v.id("bookings") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// ============================================================================
// STRIPE PAYMENT QUERIES
// ============================================================================

// List all stripePayments
export const listStripePayments = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("stripePayments").collect();
  },
});

// Get a single stripePayment by ID
export const getStripePayment = query({
  args: { id: v.id("stripePayments") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// ============================================================================
// CUSTOMER QUERIES
// ============================================================================

// List all customers
export const listCustomers = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("customers").collect();
  },
});

// Get customer by email
export const getCustomerByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) =>
        q.eq("email", args.email.toLowerCase().trim())
      )
      .first();
  },
});

// List customers by role
export const listCustomersByRole = query({
  args: { role: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", args.role))
      .collect();
  },
});

// Get customer by ID
export const getCustomer = query({
  args: { id: v.id("customers") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// List athletes (customers) assigned to a specific coach
// coachId can be either the Convex _id or the coach's email
export const listAthletesByCoach = query({
  args: { coachId: v.string() },
  handler: async (ctx, args) => {
    if (!args.coachId) return [];
    // Get all customers (role=customer) who have this coach in their assignedCoachIds
    const allCustomers = await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", "customer"))
      .collect();
    
    // Primary: match by Convex _id directly
    let matched = allCustomers.filter(
      (c) => c.assignedCoachIds && c.assignedCoachIds.includes(args.coachId)
    );
    if (matched.length > 0) return matched;

    // Fallback: coachId might be an email — look up the coach record by email
    // and use their Convex _id to match
    const coachByEmail = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", args.coachId.toLowerCase().trim()))
      .first();
    if (coachByEmail && coachByEmail.role === "coach") {
      matched = allCustomers.filter(
        (c) => c.assignedCoachIds && c.assignedCoachIds.includes(coachByEmail._id)
      );
      if (matched.length > 0) return matched;
    }

    return [];
  },
});

// ============================================================================
// COACH INVITE QUERIES
// ============================================================================

// List all coach invites
export const listCoachInvites = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("coachInvites").order("desc").collect();
  },
});

// Get coach invite by token
export const getCoachInviteByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("coachInvites")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first();
  },
});

// ============================================================================
// WAITLIST QUERIES
// ============================================================================

// List all waitlist entries
export const listWaitlistEntries = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("waitlist").collect();
  },
});

// List waitlist entries by user
export const listWaitlistByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("waitlist")
      .withIndex("by_userId", (q: any) => q.eq("userId", args.userId))
      .collect();
  },
});

// List waitlist entries for a specific slot
export const listWaitlistForSlot = query({
  args: { laneId: v.string(), date: v.string(), hour: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("waitlist")
      .withIndex("by_slot", (q: any) =>
        q.eq("laneId", args.laneId).eq("date", args.date).eq("hour", args.hour)
      )
      .collect();
  },
});

// List waitlist entries for a lane+date
export const listWaitlistByLaneDate = query({
  args: { laneId: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("waitlist")
      .withIndex("by_laneId_date", (q: any) =>
        q.eq("laneId", args.laneId).eq("date", args.date)
      )
      .collect();
  },
});

// List waitlist notifications for a user
export const listWaitlistNotifications = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("waitlistNotifications")
      .withIndex("by_userId", (q: any) => q.eq("userId", args.userId))
      .collect();
  },
});

// ============================================================================
// PAYMENT QUERIES
// ============================================================================

// List all payments
export const listPayments = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("payments").collect();
  },
});

// List payments by coach
export const listPaymentsByCoach = query({
  args: { coachId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("payments")
      .withIndex("by_coachId", (q: any) => q.eq("coachId", args.coachId))
      .collect();
  },
});

// ============================================================================
// REVENUE BREAKDOWN QUERIES
// ============================================================================

// Returns daily/weekly/monthly totals for customer revenue (stripePayments)
// and coach revenue (payments table). Amounts assumed to be in dollars.
export const getRevenueBreakdown = query({
  args: {},
  handler: async (ctx) => {
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
