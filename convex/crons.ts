import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Check every 30 minutes for bookings that need a 6-hour reminder
crons.interval(
  "booking-reminders",
  { minutes: 30 },
  internal.reminderAction.sendBookingReminders
);

// Weekly booking summary — Monday 10:00 AM AWST (UTC+8) = Monday 02:00 UTC
crons.weekly(
  "weekly-booking-summary",
  { dayOfWeek: "monday", hourUTC: 2, minuteUTC: 0 },
  internal.weeklySummary.sendWeeklyBookingSummaries
);

export default crons;
