import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Check every 30 minutes for bookings that need a 6-hour reminder
crons.interval(
  "booking-reminders",
  { minutes: 30 },
  internal.reminderAction.sendBookingReminders
);

// Release abandoned-checkout slot holds (SPEC_PAYMENTS_AND_CREDIT #3). The
// Stripe checkout.session.expired webhook is the fast path; this is the backstop
// so a slot never stays stuck if the webhook is missed.
crons.interval(
  "release-expired-holds",
  { minutes: 5 },
  internal.slotHolds.releaseExpiredHolds
);

// Weekly booking summary — Monday 10:00 AM AWST (UTC+8) = Monday 02:00 UTC
crons.weekly(
  "weekly-booking-summary",
  { dayOfWeek: "monday", hourUTC: 2, minuteUTC: 0 },
  internal.weeklySummary.sendWeeklyBookingSummaries
);

export default crons;
