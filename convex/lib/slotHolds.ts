/**
 * Slot-hold helpers (SPEC_PAYMENTS_AND_CREDIT #3) — ONE unified hold mechanism,
 * shared with the future waitlist build (SPEC_WAITLIST_OFFER_REDESIGN).
 *
 * A 'checkout' hold is created alongside a pending_payment booking and is the
 * single record swept for expiry. A 'waitlist' hold is a first-refusal offer
 * (the waitlist build will write these). The conflict checker treats any
 * unexpired hold as occupying the slot, so an in-flight checkout or an active
 * waitlist offer blocks other bookers — never patch this logic per-feature.
 */

const DEFAULT_ABANDONED_MINUTES = 10;

// The Stripe Checkout session stays payable for this long (stripe.ts sets
// expires_at = now + 30 min). A checkout hold must NEVER expire before its
// session can no longer be paid, or the cron (releaseExpiredHolds) cancels the
// booking while the customer can still complete payment → they get charged for a
// booking that's been cancelled and its slot freed/re-booked (audit 2026-06-10
// money-hole #1). So the hold window is floored at this value regardless of the
// admin's abandonedCheckoutMinutes setting; the setting can only make it LONGER.
export const STRIPE_CHECKOUT_SESSION_MS = 30 * 60 * 1000;

/** Resolve the configured abandoned-checkout window in ms (never below the
 * Stripe session lifetime — see STRIPE_CHECKOUT_SESSION_MS). */
export async function abandonedCheckoutMs(ctx: any): Promise<number> {
  const settings = await ctx.db
    .query("siteSettings")
    .withIndex("by_key", (q: any) => q.eq("key", "global"))
    .first();
  const minutes = (settings as any)?.abandonedCheckoutMinutes ?? DEFAULT_ABANDONED_MINUTES;
  return Math.max(minutes * 60 * 1000, STRIPE_CHECKOUT_SESSION_MS);
}

/** Create a checkout hold for a freshly-created pending_payment booking. */
export async function createCheckoutHold(
  ctx: any,
  args: {
    bookingId: string;
    laneId: string;
    additionalLaneIds?: string[];
    date: string;
    startHour: number;
    duration: number;
    userId?: string;
    userEmail?: string;
    expiresAtMs: number;
  }
): Promise<void> {
  await ctx.db.insert("slotHolds", {
    laneId: args.laneId,
    additionalLaneIds: args.additionalLaneIds,
    date: args.date,
    startHour: args.startHour,
    duration: args.duration,
    holdType: "checkout",
    bookingId: args.bookingId,
    userId: args.userId,
    userEmail: args.userEmail,
    expiresAt: args.expiresAtMs,
    createdAt: new Date().toISOString(),
  });
}

/** Delete every hold attached to a booking (called on confirm / cancel / release). */
export async function releaseHoldForBooking(ctx: any, bookingId: string): Promise<void> {
  const holds = await ctx.db
    .query("slotHolds")
    .withIndex("by_bookingId", (q: any) => q.eq("bookingId", bookingId))
    .collect();
  for (const h of holds) {
    await ctx.db.delete(h._id);
  }
}

/**
 * True if any UNEXPIRED hold on `laneIds`/`date` overlaps [startHour, endHour).
 * Skips holds belonging to `excludeBookingId` (the booking being created/edited).
 * Expired holds are ignored (the sweep will delete them).
 *
 * Waitlist offer holds (SPEC_WAITLIST_OFFER_REDESIGN) are exclusive to one
 * member: the held user passes their OWN waitlist hold (`callerUserId`), and
 * coaches/admin bypass waitlist holds entirely (`bypassWaitlistHolds`) since the
 * first-refusal reservation only fences off other customers. Checkout holds
 * always block regardless of these flags.
 */
export async function hasActiveHoldConflict(
  ctx: any,
  args: {
    laneIds: string[];
    date: string;
    startHour: number;
    endHour: number;
    excludeBookingId?: string;
    callerUserId?: string;
    bypassWaitlistHolds?: boolean;
  }
): Promise<boolean> {
  const now = Date.now();
  for (const laneId of args.laneIds) {
    const holds = await ctx.db
      .query("slotHolds")
      .withIndex("by_laneId_date", (q: any) => q.eq("laneId", laneId).eq("date", args.date))
      .collect();
    const conflict = holds.some((h: any) => {
      if (h.expiresAt <= now) return false; // expired — not blocking
      if (args.excludeBookingId && h.bookingId === args.excludeBookingId) return false;
      if (h.holdType === "waitlist") {
        if (args.bypassWaitlistHolds) return false; // coach/admin not fenced off
        if (args.callerUserId && h.userId === args.callerUserId) return false; // the offeree
      }
      const holdLanes = [h.laneId, ...((h.additionalLaneIds as string[]) ?? [])];
      if (!holdLanes.includes(laneId)) return false;
      const hEnd = h.startHour + h.duration / 60;
      return args.startHour < hEnd && args.endHour > h.startHour;
    });
    if (conflict) return true;
  }
  return false;
}
