import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
// EML-1 (audit 2026-06): use the shared, snapshot-aware lane-name resolver instead
// of a local hardcoded map (which used stale "Bowling Machine N"/"9m Run Up N"
// names and ignored laneNameSnapshot → wrong names after a reconfigurable-lane flip).
import { laneNameForBooking } from "./lib/lanes";

export function formatHourToTime(hour: number): string {
  const whole = Math.floor(hour);
  const mins = Math.round((hour - whole) * 60);
  const period = whole >= 12 ? "PM" : "AM";
  const displayHour = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
  return `${displayHour}:${mins.toString().padStart(2, "0")} ${period}`;
}

export function formatDuration(minutes: number): string {
  if (minutes === 60) return "1 hour";
  if (minutes === 90) return "1.5 hours";
  if (minutes === 30) return "30 minutes";
  const hrs = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (remainMins === 0) return `${hrs} hour${hrs !== 1 ? "s" : ""}`;
  return `${hrs}h ${remainMins}m`;
}

// Get all confirmed bookings happening within the next ~6 hours that haven't been reminded
export const getBookingsNeedingReminder = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Get current time in AWST (UTC+8)
    const now = new Date();
    const awstOffset = 8 * 60 * 60 * 1000;
    const awstNow = new Date(now.getTime() + awstOffset + now.getTimezoneOffset() * 60 * 1000);

    const todayStr = `${awstNow.getFullYear()}-${String(awstNow.getMonth() + 1).padStart(2, "0")}-${String(awstNow.getDate()).padStart(2, "0")}`;
    
    // Also check tomorrow in case it's late evening and bookings are early morning
    const tomorrow = new Date(awstNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

    const todayBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", todayStr))
      .collect();

    const tomorrowBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", tomorrowStr))
      .collect();

    const allBookings = [...todayBookings, ...tomorrowBookings];

    const currentHourAWST = awstNow.getHours() + awstNow.getMinutes() / 60;

    const needsReminder = allBookings.filter((b) => {
      // Only confirmed bookings
      if (b.status !== "confirmed") return false;
      // Skip if already reminded
      if (b.reminderSent) return false;
      // Must have a customer email
      if (!b.customerEmail) return false;
      // SPEC_CLUB_TEAM_BOOKINGS: clubs never get emails (synthetic address).
      if (b.isClubBooking) return false;

      // Calculate hours until booking
      const [bYear, bMonth, bDay] = b.date.split("-").map(Number);
      const bookingDate = new Date(bYear, bMonth - 1, bDay);
      const awstDate = new Date(awstNow.getFullYear(), awstNow.getMonth(), awstNow.getDate());
      
      // Days difference
      const daysDiff = (bookingDate.getTime() - awstDate.getTime()) / (1000 * 60 * 60 * 24);
      
      let hoursUntil: number;
      if (daysDiff === 0) {
        // Same day
        hoursUntil = b.startHour - currentHourAWST;
      } else if (daysDiff === 1) {
        // Tomorrow
        hoursUntil = (24 - currentHourAWST) + b.startHour;
      } else {
        return false; // Too far away
      }

      // SPEC_PUSH_NOTIFICATIONS_V2 §3.1 — fire ~22 min before the booking. The cron
      // runs every 5 min (§3.2): normally the first eligible tick (~20–24 min before)
      // fires it, and the reminderSent guard prevents repeats. C8: use a due-and-not-yet-
      // sent lower bound (0..0.4 h) instead of a tight 18–24 min band, so a single
      // delayed/skipped cron tick still catches the reminder rather than missing it.
      return hoursUntil >= 0 && hoursUntil <= 0.4;
    });

    return needsReminder.map((b) => ({
      id: b._id,
      customerEmail: b.customerEmail,
      customerName: b.customerName,
      laneId: b.laneId,
      laneName: laneNameForBooking(b),
      date: b.date,
      startHour: b.startHour,
      duration: b.duration,
      timeSlot: formatHourToTime(b.startHour),
      durationLabel: formatDuration(b.duration),
      accessCode: b.accessCode ?? "",
    }));
  },
});

// Mark a booking as reminder sent
export const markReminderSent = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.bookingId, { reminderSent: true });
  },
});

// FACILITY_ACCESS_PUSH — confirmed CUSTOMER bookings starting in ~1 hour that are
// the customer's FIRST-EVER session and haven't had the one-time "how to find us"
// push yet. Excludes coach sessions and coach/admin accounts. Window is wide on the
// near side (fires on the first 5-min tick under ~63 min out) and the per-customer
// `facilityAccessPushSent` flag stops repeats — same robust pattern as the reminder.
export const getFirstVisitBookingsForFacilityPush = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = new Date();
    const awstOffset = 8 * 60 * 60 * 1000;
    const awstNow = new Date(now.getTime() + awstOffset + now.getTimezoneOffset() * 60 * 1000);

    const todayStr = `${awstNow.getFullYear()}-${String(awstNow.getMonth() + 1).padStart(2, "0")}-${String(awstNow.getDate()).padStart(2, "0")}`;
    const tomorrow = new Date(awstNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

    const todayBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", todayStr))
      .collect();
    const tomorrowBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", tomorrowStr))
      .collect();
    const allBookings = [...todayBookings, ...tomorrowBookings];

    const currentHourAWST = awstNow.getHours() + awstNow.getMinutes() / 60;

    const candidates = allBookings.filter((b: any) => {
      if (b.status !== "confirmed") return false;
      if (!b.customerEmail) return false;
      if (b.isCoachBooking) return false; // customer first-visits only
      if (b.isClubBooking) return false; // SPEC_CLUB_TEAM_BOOKINGS: clubs get no push/email

      const [bYear, bMonth, bDay] = b.date.split("-").map(Number);
      const bookingDate = new Date(bYear, bMonth - 1, bDay);
      const awstDate = new Date(awstNow.getFullYear(), awstNow.getMonth(), awstNow.getDate());
      const daysDiff = (bookingDate.getTime() - awstDate.getTime()) / (1000 * 60 * 60 * 24);

      let hoursUntil: number;
      if (daysDiff === 0) hoursUntil = b.startHour - currentHourAWST;
      else if (daysDiff === 1) hoursUntil = 24 - currentHourAWST + b.startHour;
      else return false;

      // Fire ~1 hour before — first tick under ~63 min; the per-customer flag dedups.
      return hoursUntil > 0 && hoursUntil <= 1.05;
    });

    const result: Array<{
      bookingId: any;
      customerId: any;
      customerEmail: string;
      customerName: string;
      laneName: string;
      timeSlot: string;
      date: string;
    }> = [];

    for (const b of candidates) {
      const cust = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", b.customerEmail))
        .first();
      if (!cust) continue;
      if (cust.role === "coach" || cust.role === "admin") continue; // customers only
      if (cust.facilityAccessPushSent === true) continue; // one-time per account

      // FIRST-EVER session: no other non-cancelled booking by this email starts before it.
      const priors = await ctx.db
        .query("bookings")
        .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", b.customerEmail))
        .collect();
      const startsBefore = priors.some((p: any) => {
        if (p._id === b._id) return false;
        if (p.status === "cancelled") return false;
        if (p.date < b.date) return true;
        if (p.date === b.date && p.startHour < b.startHour) return true;
        return false;
      });
      if (startsBefore) continue;

      result.push({
        bookingId: b._id,
        customerId: cust._id,
        customerEmail: b.customerEmail,
        customerName: b.customerName,
        laneName: laneNameForBooking(b),
        timeSlot: formatHourToTime(b.startHour),
        date: b.date,
      });
    }

    return result;
  },
});

// Mark a customer's one-time facility-access push as sent (never reset).
export const markFacilityAccessPushSent = internalMutation({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.customerId, { facilityAccessPushSent: true });
  },
});
