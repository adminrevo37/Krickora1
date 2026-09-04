/**
 * Booking settlement state — THE single answer to "has this booking's value
 * already been collected?" (money review 2026-09-05, C1 + C2).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `bookings.paymentStatus` was being asked two different questions by the same
 * expression, `paymentStatus === "paid"`:
 *
 *   (a) "Did CASH come in, so `priceInCents` holds the cash settled rather than
 *        the gross list price?"  -> that IS `paymentStatus === "paid"`, and every
 *        refund site (cancelBookingCore, deleteBooking, systemCancel,
 *        voidBookingCharge) is correct to use it. See `isCashSettled` below.
 *
 *   (b) "Has this booking been settled at all, by any means?"  -> this is NOT the
 *        same test, because the field is not written by every settlement route:
 *
 *          route                        status            paymentStatus
 *          ---------------------------- ----------------- --------------
 *          customer card checkout       pending_payment   (absent)
 *            ...once the webhook lands  confirmed         "paid"
 *          customer credit-only         confirmed         (absent)   <- settled
 *          customer $0 / 100% discount  confirmed         (absent)   <- settled
 *          in-session extend on credit  confirmed         (absent)   <- settled
 *          coach booking (statement)    confirmed         (absent)   <- settled
 *          admin comp                   confirmed         "paid"
 *          admin paid-offline           confirmed         "paid"
 *          admin payment request        pending_payment   "pending"  <- NOT settled
 *          club invoiced                confirmed         "unpaid"   <- NOT settled
 *          admin void / write-off       confirmed         "refunded" / "waived"
 *          abandoned checkout           cancelled         "failed"
 *
 * Using (a) to answer (b) produced both CRITICAL money defects in the review:
 * an UNSETTLED booking was accepted for modification and settled in full for the
 * price *difference* (C1), and a CREDIT-SETTLED booking read as "not paid" so the
 * credit covering an increase was never redeemed (C2).
 *
 * The invariant itself was already written down correctly, once, in
 * `extendBookingLive`: "paymentStatus 'unpaid' = admin offline/invoice booking
 * awaiting payment; absent paymentStatus on a confirmed booking = settled by
 * convention — credit-covered / comp / legacy rows never carry the field."
 * This module is that comment turned into the one predicate everything can call.
 *
 * Pure: no Convex imports, no ctx, no DB reads — safe to use anywhere.
 */

export type SettlementState =
  /** Nothing is owed: paid, comped, covered by account credit, $0, waived, or a coach statement booking. */
  | "settled"
  /** Awaiting an online payment that has not landed (customer checkout, admin payment request). */
  | "awaiting_checkout"
  /** Confirmed but deliberately recorded as owing money offline (club / invoice). */
  | "balance_outstanding"
  /** Cancelled — not a live booking at all. */
  | "cancelled";

/**
 * Settlement state of a booking row.
 *
 * NB `pending_edit_payment` resolves to "settled": that status only ever applies
 * to a booking that WAS settled and now has a staged change awaiting a top-up
 * (modifyBooking is its only writer, and it refuses an unsettled booking). The
 * original money is still collected; only the difference is outstanding.
 */
export function bookingSettlement(booking: any): SettlementState {
  const status = String(booking?.status ?? "");
  if (status === "cancelled") return "cancelled";
  // The booking itself has never been paid for.
  if (status === "pending_payment" || status === "pending") return "awaiting_checkout";
  const paymentStatus = booking?.paymentStatus;
  // Confirmed offline/club booking the admin has flagged as still owing.
  if (paymentStatus === "unpaid") return "balance_outstanding";
  // Defensive: a confirmed row should never carry these, but if one does it is
  // certainly not evidence of money received.
  if (paymentStatus === "pending" || paymentStatus === "failed") return "awaiting_checkout";
  return "settled";
}

/** True when nothing is outstanding on the booking, however it was settled. */
export function isBookingSettled(booking: any): boolean {
  return bookingSettlement(booking) === "settled";
}

/**
 * True when CASH was actually collected — and therefore when `priceInCents`
 * holds the cash settled rather than the gross list price (the B2 convention).
 *
 * This is deliberately NOT the same question as `isBookingSettled`: a
 * credit-settled, comped or $0 booking is settled with no cash, and its
 * `priceInCents` is still the gross. Use this one, and only this one, for
 * refund arithmetic; use `isBookingSettled` to decide whether the booking may
 * be changed or extended.
 */
export function isCashSettled(booking: any): boolean {
  return booking?.paymentStatus === "paid";
}

/**
 * Cash actually collected on a booking, in whole cents. Zero unless
 * `isCashSettled` — a credit-settled or comped booking took no cash even though
 * `priceInCents` is populated.
 */
export function cashSettledCents(booking: any): number {
  if (!isCashSettled(booking)) return 0;
  const cents = booking?.priceInCents;
  return typeof cents === "number" && cents > 0 ? Math.round(cents) : 0;
}
