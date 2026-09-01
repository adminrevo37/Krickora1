/**
 * System-initiated booking cancellation (SPEC_ADMIN_AND_SETTINGS #1).
 *
 * Used when an admin creates a closure or lane block that overlaps active
 * bookings: those bookings are auto-cancelled, the customer is auto-credited
 * (paid customer bookings only — same rule as a normal cancellation), their
 * Google Calendar event is removed, the checkout hold is released, and a
 * closure/maintenance cancellation email is sent.
 *
 * Unlike the public cancelBooking mutation, this skips owner-auth and the
 * customer time-lock checks — the admin has already authorised the closure.
 */
import { internal } from "../_generated/api";
import { issueCredit } from "./credit";
import { releaseHoldForBooking } from "./slotHolds";
import { fmtAwstDateLabel, fmtAwstDateShort } from "./dates";
// EML-1 (audit 2026-06), applied here 2026-09-01: use the shared, snapshot-aware
// resolver instead of a local hardcoded map. The map this replaced still carried
// the pre-migration "9m Run Up 1"/"2" names (those lanes display as RU 4 / RU 5
// since the bay renumbering) and ignored laneNameSnapshot, so a closure-triggered
// cancellation named the wrong lane to the customer — worse after a reconfigurable
// -lane flip, where the booked lane may not even have been a run-up that day.
import { laneNameForBooking } from "./lanes";

export interface SystemCancelSummary {
  bookingId: string;
  customerName: string;
  customerEmail: string;
  laneId: string;
  date: string;
  startHour: number;
  duration: number;
  isCoachBooking: boolean;
  creditIssued: number;
}

/**
 * Cancel one booking due to a closure/block. Returns a summary row, or null if
 * the booking was already cancelled. Safe to call on coach bookings (no credit).
 */
export async function systemCancelBooking(
  ctx: any,
  booking: any,
  opts: { reason: string; cancelledByEmail?: string }
): Promise<SystemCancelSummary | null> {
  if (!booking || booking.status === "cancelled") return null;

  // B-4: a closure/block must not disturb a session that has already ended —
  // leave past bookings entirely untouched (no cancel, no credit, no email).
  // It already happened; cancelling + crediting it would mint value and corrupt
  // history. AWST is UTC+8 with no DST, so an explicit offset is exact.
  const sessionEndMs =
    Date.parse(`${booking.date}T00:00:00+08:00`) +
    (booking.startHour * 60 + (booking.duration ?? 0)) * 60000;
  if (sessionEndMs <= Date.now()) return null;

  await ctx.db.patch(booking._id, {
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
    cancelledByUserId: opts.cancelledByEmail,
  });

  // Auto-credit paid customer bookings (cash charged + any credit applied).
  // Coach bookings aren't prepaid online; pending_payment bookings have nothing
  // to return. Mirrors cancelBooking (SPEC_PAYMENTS_AND_CREDIT #2).
  let creditIssued = 0;
  if (
    !booking.isCoachBooking &&
    // MON-5 (SECURITY/MONEY review 2026-08-19): include a booking that is mid-modify.
    // modifyBooking parks a fully-PAID booking in `pending_edit_payment` for up to
    // 30 min while the top-up is paid, leaving priceInCents / creditApplied at their
    // original settled values. A closure or lane block landing inside that window
    // cancelled a paid session and refunded NOTHING. This path needs no user error at
    // all to hit — the admin closes the facility, the sweep does the rest.
    (booking.status === "confirmed" || booking.status === "pending_edit_payment") &&
    booking.customerEmail &&
    // MON-2 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13): a booking whose charge was
    // already voided/refunded by voidBookingCharge has had its value returned —
    // re-issuing creditApplied here would hand it back a second time.
    (booking as any).refunded !== true
  ) {
    // MON-1 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13): only return CASH as credit
    // when the booking was ACTUALLY paid. This gate exists in cancelBooking,
    // deleteBooking and voidBookingCharge but was missing here, so the closure /
    // lane-block auto-cancel sweep credited gross price + credit for a booking
    // that never took cash. Worst case: a credit-only booking (credit covers the
    // whole price, so createBooking leaves it `confirmed` with NO paymentStatus
    // while priceInCents still holds the GROSS) refunded double — $35 paid in
    // credit came back as $70.
    const wasPaid = (booking as any).paymentStatus === "paid";
    const cashPaid = wasPaid && booking.priceInCents != null ? booking.priceInCents / 100 : 0;
    const creditToIssue = cashPaid + (booking.creditApplied ?? 0);
    if (creditToIssue > 0) {
      creditIssued = await issueCredit(ctx, {
        email: booking.customerEmail,
        amount: creditToIssue,
        reason: "cancellation",
        bookingId: booking._id.toString(),
        note: opts.reason,
      });
    }
  }

  // Release any checkout hold tied to this booking.
  await releaseHoldForBooking(ctx, booking._id.toString());

  // Remove the Google Calendar event(s).
  // CAL-3 (SECURITY review 2026-08-19): gate on PRIMARY *or* per-lane ids. This fix
  // was applied to cancelBookingCore on 2026-06-23 but never mirrored here, so a
  // closure/lane-block cancelling a partially-synced multi-lane booking (per-lane
  // events, no primary id) left those lane events LIVE on the calendar — HA keeps
  // loading the door code and powering the machine for a session that is cancelled.
  // That is building access after cancellation, the same class as the A1 HIGH.
  if (booking.googleCalendarEventId || (booking.googleCalendarEventIds?.length ?? 0) > 0) {
    await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
      // `googleCalendarEventId` is a REQUIRED v.string() on the action — the widened
      // condition above now admits the per-lane-only case, so it must be coerced (a
      // raw undefined would fail the validator and abort the whole teardown).
      googleCalendarEventId: booking.googleCalendarEventId ?? "",
      laneCalendarEventIds: booking.googleCalendarEventIds,
    });
  }

  // Notify the customer (parents/athletes/mates notifications hook in once those
  // specs are built — see SPEC_PARENT_ATHLETE_MODEL / SPEC_ADD_A_MATE).
  if (booking.customerEmail) {
    const whole = Math.floor(booking.startHour);
    const mins = Math.round((booking.startHour - whole) * 60);
    const period = whole >= 12 ? "PM" : "AM";
    const displayHour = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
    const timeSlot = `${displayHour}:${mins.toString().padStart(2, "0")} ${period}`;
    const durationLabel =
      booking.duration === 60
        ? "1 hour"
        : booking.duration === 90
        ? "1.5 hours"
        : booking.duration === 30
        ? "30 minutes"
        : `${booking.duration} min`;

    await ctx.scheduler.runAfter(0, internal.emails.sendBookingCancellation, {
      to: booking.customerEmail,
      customerName: booking.customerName || "Valued Customer",
      laneName: laneNameForBooking(booking),
      date: fmtAwstDateLabel(booking.date),
      dateShort: fmtAwstDateShort(booking.date),
      timeSlot,
      duration: durationLabel,
      reason: opts.reason,
    });
    // SPEC_PWA_PUSH §5.1 — system/admin cancellation (closure → credit), customer.
    if (!booking.isCoachBooking) {
      await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
        email: booking.customerEmail,
        category: "booking-changes",
        title: "Booking cancelled",
        body: `${laneNameForBooking(booking)} · ${fmtAwstDateLabel(booking.date)}, ${timeSlot}${opts.reason ? ` — ${opts.reason}` : ""}. Credit issued.`,
        url: "/bookings",
        tag: `booking-${booking._id.toString()}`,
      });
    }
  }

  return {
    bookingId: booking._id.toString(),
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    laneId: booking.laneId,
    date: booking.date,
    startHour: booking.startHour,
    duration: booking.duration,
    isCoachBooking: !!booking.isCoachBooking,
    creditIssued,
  };
}

/**
 * Does a booking occupy the given lane (primary OR additional)? laneId === 'all'
 * matches every booking.
 */
export function bookingOccupiesLane(booking: any, laneId: string): boolean {
  if (laneId === "all") return true;
  if (booking.laneId === laneId) return true;
  if (Array.isArray(booking.additionalLaneIds) && booking.additionalLaneIds.includes(laneId)) {
    return true;
  }
  return false;
}
