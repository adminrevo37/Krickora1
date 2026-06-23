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

// SPEC_ANALYTICS_BUILD_2026-06 C2.2 — persist the previous AWST day's
// revenue/bookings/occupancy snapshot. Runs at 00:20 AWST = 16:20 UTC, after the
// day has fully ended so the figures are final.
crons.daily(
  "daily-revenue-snapshot",
  { hourUTC: 16, minuteUTC: 20 },
  internal.analyticsSnapshot.runDailyRevenueSnapshot
);

// Audit 2026-06 (COST-4 / LEAK-3 / LEAK-6) — daily retention sweep of unbounded
// append-only tables (analytics >90d, event/log tables >180d, past laneOverrides).
// Batched indexed deletes that reschedule until drained. 01:00 AWST = 17:00 UTC,
// after the snapshot above. revenueSnapshots + audit logs are kept forever.
crons.daily(
  "retention-daily",
  { hourUTC: 17, minuteUTC: 0 },
  internal.retention.runDailyRetention
);

// Audit 2026-06 (SEC-3) — hourly prune of stale rate-limit buckets (bounds the
// table under rotating-key / XFF-spoof abuse).
crons.hourly(
  "retention-ratelimits",
  { minuteUTC: 30 },
  internal.retention.runHourlyRetention
);

export default crons;
