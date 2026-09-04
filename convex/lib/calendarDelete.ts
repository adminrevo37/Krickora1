/**
 * C3 (BACKEND review 2026-09-05) — ONE place that builds the args for
 * `internal.googleCalendar.deleteCalendarEvent`.
 *
 * The action has always declared a `bookingId` hook whose whole purpose is to make
 * a FAILED delete visible ("a live event left behind after a cancel is an access
 * risk"), and not one of its ten call sites passed it. A failed Google DELETE was
 * therefore swallowed: the event stays on the lane calendar, HA keeps loading its
 * door code, and a cancelled customer can still open an unstaffed building.
 *
 * Passing the id at ten call sites fixes it once; a helper fixes it permanently,
 * because the eleventh call site cannot forget an argument it never types. Every
 * delete call site must go through `calendarDeleteArgs()`.
 *
 * It also captures a SNAPSHOT of the session (date/time/lane/customer/door code) —
 * deliberately, because three call sites (`deleteBooking`, `cascadeDeleteCustomer`,
 * the coach auto-merge) hard-delete the booking row in the same mutation, so the
 * scheduled action can no longer read any of it. Without the snapshot the alert
 * for those cases could only say "an event failed to delete", which is not enough
 * for a human to go and remove it by hand.
 */

export interface CalendarDeleteSnapshot {
  date?: string;
  startHour?: number;
  laneName?: string;
  customerName?: string;
  accessCode?: string;
}

export interface CalendarDeleteArgs {
  googleCalendarEventId: string;
  laneCalendarEventIds?: Array<{ laneId: string; calendarId: string; eventId: string }>;
  bookingId?: string;
  snapshot?: CalendarDeleteSnapshot;
}

/** True when this booking has ANY stored calendar event (primary or per-lane).
 *  CAL-3: gating on the primary id alone leaves a partially-synced multi-lane
 *  booking's per-lane events live after a cancel. */
export function hasCalendarEvents(booking: any): boolean {
  if (!booking) return false;
  return (
    !!booking.googleCalendarEventId ||
    (Array.isArray(booking.googleCalendarEventIds) && booking.googleCalendarEventIds.length > 0)
  );
}

export function calendarDeleteArgs(booking: any): CalendarDeleteArgs {
  const entries = Array.isArray(booking?.googleCalendarEventIds)
    ? booking.googleCalendarEventIds
    : undefined;

  // `googleCalendarEventId` is a REQUIRED v.string() on the action; a per-lane-only
  // booking has no primary id, so fall back to the first entry, then to "".
  const primary: string =
    booking?.googleCalendarEventId ?? entries?.[0]?.eventId ?? "";

  const snapshot: CalendarDeleteSnapshot = {};
  // NB: only ever assign DEFINED values. Convex `v.optional()` means ABSENT — a
  // null (or an explicitly-set undefined on a nested object) is rejected and would
  // abort the whole delete, i.e. the fix would itself leave the door code live.
  if (typeof booking?.date === "string") snapshot.date = booking.date;
  if (typeof booking?.startHour === "number") snapshot.startHour = booking.startHour;
  const laneName = booking?.laneNameSnapshot ?? booking?.laneId;
  if (typeof laneName === "string") snapshot.laneName = laneName;
  if (typeof booking?.customerName === "string") snapshot.customerName = booking.customerName;
  if (typeof booking?.accessCode === "string") snapshot.accessCode = booking.accessCode;

  const args: CalendarDeleteArgs = { googleCalendarEventId: primary };
  if (entries && entries.length > 0) args.laneCalendarEventIds = entries;
  if (booking?._id != null) args.bookingId = String(booking._id);
  if (Object.keys(snapshot).length > 0) args.snapshot = snapshot;
  return args;
}
