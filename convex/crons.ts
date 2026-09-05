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

// 2026-08-18 — nightly usage roll-up. Aggregates YESTERDAY (AWST) into one
// `usageDaily` row so getUsageAnalytics reads <=90 rows instead of up to
// ~140,000 raw analytics rows (which made the Usage tab Server Error at every
// range). 16:40 UTC = 00:40 AWST, i.e. after the day has closed and staggered
// clear of the revenue snapshot above.
crons.daily(
  "daily-usage-rollup",
  { hourUTC: 16, minuteUTC: 40 },
  internal.usageRollup.runDailyUsageRollup
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

// SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part C2 — daily "still waiting?" check-in
// to everyone holding a waitlist place older than the threshold (default 2 days;
// measured: 75% of joins are <24h out, so weekly/7-day would never fire). 10:15 AWST =
// 02:15 UTC, clear of the Monday weekly summary at 02:00.
crons.daily(
  "waitlist-still-waiting",
  { hourUTC: 2, minuteUTC: 15 },
  internal.waitlistReminders.sendStillWaitingReminders
);

// SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part A1 — hourly reaper for waitlist
// entries whose session has ENDED (there was no time-based expiry at all, so
// entries lived forever). Runs a few minutes past the hour so an entry for the
// hour just ended is caught on the first pass.
crons.hourly(
  "waitlist-reap-passed",
  { minuteUTC: 5 },
  internal.waitlist.expirePassedWaitlistEntries
);

// PUSH_BACKEND_SPEC §6 — Expo push receipts. Web Push self-cleans on a 404/410,
// but Expo accepts a message for a dead token (`ok`) and only reports
// DeviceNotRegistered in a receipt available ~15 min later. This is the ONLY
// prune path for native devices; without it pushSubscriptions grows forever.
// Silent when there are no due tickets.
crons.hourly(
  "push-receipts",
  { minuteUTC: 45 },
  internal.push.checkPushReceipts
);

// Audit 2026-06 (SEC-3) — hourly prune of stale rate-limit buckets (bounds the
// table under rotating-key / XFF-spoof abuse).
crons.hourly(
  "retention-ratelimits",
  { minuteUTC: 30 },
  internal.retention.runHourlyRetention
);

// SPEC_CALENDAR_SYNC_RELIABILITY_2026-06 (fix #2) — daily reconcile of upcoming
// confirmed bookings against Google Calendar: re-create any MISSING event (the
// 2026-06-23 silent-failure lockout class) and re-push any STALE door code so HA
// always loads the booking's authoritative stored code. Forward ~14-day window,
// by_date-bounded. 02:00 AWST = 18:00 UTC (after retention; quiet hours).
// Weekly coach billing caps (2026-07) — nightly backstop that re-caps this + last
// week for every capped coach, so the "Weekly billing cap" credit line stays in
// sync with any charge change not individually triggered (modify / price edit /
// statement-exclude). 02:30 AWST = 18:30 UTC. Booking create/cancel also reconcile
// immediately (convex/billingCaps.ts).
crons.daily(
  "weekly-billing-caps",
  { hourUTC: 18, minuteUTC: 30 },
  internal.billingCaps.reconcileAllWeeklyCapsInternal
);

crons.daily(
  "calendar-reconcile",
  { hourUTC: 18, minuteUTC: 0 },
  internal.googleCalendar.reconcileCalendarInternal
);

// C3 (BACKEND review 2026-09-05) — retry every calendar event we FAILED to delete
// (cancelled / deleted / lane-moved booking) and push the admins about anything
// still standing. A surviving event means HA keeps loading its door code, so a
// cancelled customer can still open an unstaffed building: once a day is far too
// slow for that, hence 15 min. Normally a single indexed read that finds nothing.
// A failed delete also schedules this action directly 60s later; this is the
// backstop for the case where that scheduled run itself never happens.
crons.interval(
  "calendar-orphan-sweep",
  { minutes: 15 },
  internal.googleCalendar.sweepCalendarOrphans
);

// SPEC_COACH_LEDGER_UNIFICATION_2026-08 Phase 3 — daily coach-ledger reconciliation.
// Recomputes every coach's balance through each engine (Coaches-tab badge, coach
// statement, weekly report) and pushes the admins if any two disagree by more than a
// cent, or if coach charges exist against no coach account. SILENT when all agree.
// Both prior ledger incidents were found by accident; this is what finds the next one.
// 03:00 AWST = 19:00 UTC — after the weekly billing caps reconcile at 18:30 UTC, so a
// cap credit written overnight can never be read mid-write and reported as a mismatch.
crons.daily(
  "coach-ledger-check",
  { hourUTC: 19, minuteUTC: 0 },
  internal.coachLedgerCheck.runDailyLedgerCheck
);

export default crons;
