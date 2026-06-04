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

const LANE_NAMES: Record<string, string> = {
  bm1: "Bowling Machine 1",
  bm2: "Bowling Machine 2",
  bm3: "Bowling Machine 3",
  ru1: "9m Run Up 1",
  ru2: "9m Run Up 2",
};

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
    booking.status === "confirmed" &&
    booking.customerEmail
  ) {
    const cashPaid = booking.priceInCents != null ? booking.priceInCents / 100 : 0;
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
  if (booking.googleCalendarEventId) {
    await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
      googleCalendarEventId: booking.googleCalendarEventId,
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
      laneName: LANE_NAMES[booking.laneId] ?? booking.laneId,
      date: booking.date,
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
        body: `${LANE_NAMES[booking.laneId] ?? booking.laneId} · ${booking.date}, ${timeSlot}${opts.reason ? ` — ${opts.reason}` : ""}. Credit issued.`,
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
