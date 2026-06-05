import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// SPEC_PUSH_NOTIFICATIONS_V2 §3 — the session reminder now fires ~22 min before
// the booking (was 4.5–7 h), so the cron must run frequently enough to hit that
// tight pre-start window. Every 5 min.
crons.interval(
  "booking-reminders",
  { minutes: 5 },
  internal.reminderAction.sendBookingReminders
);

// SPEC_PUSH_NOTIFICATIONS_V2 §6.2 — hourly admin digest. On the hour, push every
// admin a summary of the PREVIOUS hour's activity (new accounts / new bookings /
// customers who added a coach). Operating hours only; skips all-zero hours.
crons.hourly(
  "admin-hourly-digest",
  { minuteUTC: 0 },
  internal.digestAction.sendAdminHourlyDigest
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
