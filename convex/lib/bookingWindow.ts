// Weekly-release booking window + lead-time enforcement.
// SPEC_BOOKING_WINDOW_AND_RELEASE — server-side source of truth, all AWST.
//
// Mirrors the client-side logic in src/lib/booking-data.ts (isNextWeekOpen /
// getVisibleWeekDays). The client gates the UI; THIS enforces it on the mutation,
// so a crafted request can't book outside the caller's open horizon.
//
// Model:
//  - Customers + L2 coaches always have the CURRENT week (Mon–Sun) bookable.
//  - NEXT week opens only on the configured release day, at/after the release
//    hour, through 23:59:59 of that day; at midnight it becomes the current week.
//  - L2 coaches get a priority release time (default Sun 17:00); public is later
//    (default Sun 19:00). L1 coaches use a rolling N-day window instead.
//  - Admin is exempt from every horizon/lead check.

export type WindowRole = "admin" | "coach" | "customer";
export type WindowTier = "L1" | "L2" | null | undefined;

export interface WindowSettings {
  customerOpenDay?: string | null;
  customerOpenHour?: number | null;
  l2CoachOpenDay?: string | null;
  l2CoachOpenHour?: number | null;
  coachBookingWindowDays?: number | null;
  minBookingNoticeMinutes?: number | null;
}

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Current wall-clock time in Perth (AWST). */
export function getAWSTNow(): Date {
  const now = new Date();
  const awstStr = now.toLocaleString("en-US", { timeZone: "Australia/Perth" });
  return new Date(awstStr);
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Parse a "YYYY-MM-DD" key into a local-midnight Date (no UTC drift).
function dateKeyToLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round(
    (startOfDay(b).getTime() - startOfDay(a).getTime()) / 86400000
  );
}

// The release day/hour that applies to this caller.
function releaseFor(role: WindowRole, tier: WindowTier, s: WindowSettings) {
  if (role === "coach" && tier === "L2") {
    return {
      day: s.l2CoachOpenDay ?? "sunday",
      hour: s.l2CoachOpenHour ?? 17,
    };
  }
  return {
    day: s.customerOpenDay ?? "sunday",
    hour: s.customerOpenHour ?? 19,
  };
}

/** Is next week currently open for this caller (weekly-release model)? */
export function isNextWeekOpen(
  role: WindowRole,
  tier: WindowTier,
  s: WindowSettings,
  now: Date
): boolean {
  if (role === "admin") return true;
  // L1 coaches use the rolling window, not the weekly release.
  if (role === "coach" && tier !== "L2") return false;
  const { day, hour } = releaseFor(role, tier, s);
  const releaseDow = DAY_INDEX[day] ?? 0;
  if (now.getDay() !== releaseDow) return false;
  return now.getHours() + now.getMinutes() / 60 >= hour;
}

/**
 * Returns an error message if `dateStr` is outside the caller's bookable
 * horizon, or null if the date is allowed. Past dates are rejected here too.
 */
export function checkBookingHorizon(
  role: WindowRole,
  tier: WindowTier,
  s: WindowSettings,
  dateStr: string,
  now: Date
): string | null {
  if (role === "admin") return null;

  const target = startOfDay(dateKeyToLocal(dateStr));
  const today = startOfDay(now);
  if (target < today) return "That date is in the past.";

  // L1 coaches — rolling window.
  if (role === "coach" && tier !== "L2") {
    const windowDays = s.coachBookingWindowDays ?? 8;
    const diff = daysBetween(today, target);
    if (diff < 0 || diff >= windowDays) {
      return `Coaches can book up to ${windowDays} days ahead.`;
    }
    return null;
  }

  // Customers + L2 coaches — weekly-release model.
  const { day } = releaseFor(role, tier, s);
  const releaseDow = DAY_INDEX[day] ?? 0;
  const weekStartDow = (releaseDow + 1) % 7; // day after release = week start

  const weekStart = startOfDay(now);
  const offset = (weekStart.getDay() - weekStartDow + 7) % 7;
  weekStart.setDate(weekStart.getDate() - offset); // start of current week

  const currentWeekEnd = new Date(weekStart);
  currentWeekEnd.setDate(weekStart.getDate() + 6); // inclusive last day

  if (target >= weekStart && target <= currentWeekEnd) return null; // current week

  if (isNextWeekOpen(role, tier, s, now)) {
    const nextWeekStart = new Date(weekStart);
    nextWeekStart.setDate(weekStart.getDate() + 7);
    const nextWeekEnd = new Date(weekStart);
    nextWeekEnd.setDate(weekStart.getDate() + 13);
    if (target >= nextWeekStart && target <= nextWeekEnd) return null;
  }

  return "That date isn't open for booking yet — next week's slots are released closer to the time.";
}

/**
 * Returns an error message if the slot starts within the minimum lead time,
 * or null if it's far enough ahead.
 */
export function checkLeadTime(
  dateStr: string,
  startHour: number,
  leadMinutes: number,
  now: Date
): string | null {
  const [y, m, d] = dateStr.split("-").map(Number);
  const whole = Math.floor(startHour);
  const mins = Math.round((startHour - whole) * 60);
  const slotStart = new Date(y, m - 1, d, whole, mins, 0, 0);
  const minutesUntil = (slotStart.getTime() - now.getTime()) / 60000;
  if (minutesUntil < leadMinutes) {
    return `Bookings must be made at least ${leadMinutes} minute${
      leadMinutes !== 1 ? "s" : ""
    } before the session starts.`;
  }
  return null;
}
