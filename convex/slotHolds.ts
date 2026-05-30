import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

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
  // TODO (SPEC_WAITLIST_OFFER_REDESIGN): trigger the sequential waitlist offer
  // for this freed slot here once the waitlist build lands.
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
      // Waitlist offer holds (and orphaned checkout holds) — just drop them.
      // The waitlist build will add re-offer logic before deleting its own.
      await ctx.db.delete(hold._id);
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
