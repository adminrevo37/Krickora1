import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { scheduleWaitlistAdvance } from "./waitlist";

/**
 * Abandoned-checkout slot release (SPEC_PAYMENTS_AND_CREDIT #3).
 *
 * Two entry points, ONE behaviour:
 *   • releaseExpiredHolds  — cron backstop (~every few minutes). Sweeps every
 *     slotHold whose expiresAt has passed.
 *   • releaseCheckoutBooking — Stripe `checkout.session.expired` webhook. Frees
 *     a specific booking's slot immediately (faster than the backstop).
 *
 * Releasing an unpaid checkout booking does NOT touch credit — credit is only
 * deducted at confirmation, so an abandoned checkout never spent any.
 */

/** Cancel a still-unpaid pending booking and drop its hold. Idempotent. */
async function releaseAbandonedBooking(ctx: any, booking: any): Promise<boolean> {
  // Abandoned unified-modify top-up (SPEC_MODIFY_BOOKING_UPGRADE): the booking is
  // still a valid CONFIRMED booking at its original slot — only the unpaid change
  // is abandoned. Revert it, never cancel it.
  if (booking.status === "pending_edit_payment" && booking.paymentStatus !== "paid") {
    await ctx.db.patch(booking._id, {
      status: "confirmed",
      pendingEdit: undefined,
    } as any);
    const editHolds = await ctx.db
      .query("slotHolds")
      .withIndex("by_bookingId", (q: any) => q.eq("bookingId", booking._id.toString()))
      .collect();
    for (const h of editHolds) await ctx.db.delete(h._id);
    return false; // not a released (cancelled) booking
  }

  // Only release if it's still an unpaid pending booking. If it confirmed (paid)
  // in the meantime, leave it alone.
  const unpaidPending =
    booking.paymentStatus !== "paid" &&
    (booking.status === "pending_payment" || booking.status === "pending");
  if (unpaidPending) {
    await ctx.db.patch(booking._id, {
      status: "cancelled",
      paymentStatus: "failed",
      cancelledAt: new Date().toISOString(),
    });
  }
  // Always clear holds tied to this booking.
  const holds = await ctx.db
    .query("slotHolds")
    .withIndex("by_bookingId", (q: any) => q.eq("bookingId", booking._id.toString()))
    .collect();
  for (const h of holds) await ctx.db.delete(h._id);
  // SPEC_WAITLIST_OFFER_REDESIGN: a released (abandoned) booking frees its slot —
  // offer it to the next waitlisted member. A reverted pending_edit_payment keeps
  // its CONFIRMED slot, so the engine there just sees it filled and no-ops.
  await scheduleWaitlistAdvance(ctx, {
    laneId: booking.laneId,
    date: booking.date,
    startHour: booking.startHour,
    duration: booking.duration,
  });
  return unpaidPending;
}

/** Cron backstop: release every expired hold. */
export const releaseExpiredHolds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("slotHolds")
      .withIndex("by_expiresAt", (q: any) => q.lt("expiresAt", now))
      .collect();

    let releasedBookings = 0;
    for (const hold of expired) {
      if (hold.holdType === "checkout" && hold.bookingId) {
        const booking = await ctx.db.get(hold.bookingId as any);
        if (booking) {
          if (await releaseAbandonedBooking(ctx, booking)) releasedBookings++;
          continue; // releaseAbandonedBooking already deleted the hold(s)
        }
      }
      // Waitlist offer holds — the engine's self-scheduled roll-on normally
      // fires first; this backstop catches a missed one. Drop the expired hold
      // and re-run the engine so the offer rolls to the next member.
      const wasWaitlist = hold.holdType === "waitlist";
      await ctx.db.delete(hold._id);
      if (wasWaitlist) {
        await scheduleWaitlistAdvance(ctx, {
          laneId: hold.laneId,
          date: hold.date,
          startHour: hold.startHour,
          duration: hold.duration,
        });
      }
    }

    return { expiredHolds: expired.length, releasedBookings };
  },
});

/** Stripe checkout.session.expired → release this booking's slot immediately. */
export const releaseCheckoutBooking = internalMutation({
  args: { bookingId: v.string() },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId as any);
    if (!booking) return { released: false, reason: "not_found" };
    const released = await releaseAbandonedBooking(ctx, booking);
    return { released };
  },
});
