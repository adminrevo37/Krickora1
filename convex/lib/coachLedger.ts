// ONE server-side definition of what a coach is charged for.
//
// BATCH 15.2 (2026-08-20): `listCoachBalances` (the admin Coaches-tab badge) and
// `getWeeklyReport` each carried their own copy of these rules, and the badge's copy
// had drifted on FOUR axes — it counted `statementExcluded` bookings, dropped
// late-cancel-charged ones, ignored statementAdjustments entirely, and summed ALL
// payments including future-dated ones. 11 of 23 coaches on prod showed a badge that
// disagreed with their own statement (worst: $1,692.50 vs $587.50). Same class as the
// four disagreeing lane-name maps collapsed by EML-1 in the 2026-06 audit: the fix is
// one definition, not four correct-looking copies.
//
// These MIRROR `filterCoachBookings` + `bookingCost` in `src/lib/statementLedger.ts`,
// which is what the coach statement itself renders from and is the authority on the
// rules. Convex cannot import from `src/`, so this is a deliberate second copy —
// keep the two in step, and prefer changing the statement first.

/** Does this booking put a charge on a coach's statement at all? */
export function isCoachChargeBooking(b: any): boolean {
  const isCoachCharge =
    b.isCoachBooking === true || (typeof b.coachPrice === "number" && b.coachPrice > 0);
  if (!isCoachCharge) return false;
  // Late-cancelled coach bookings are charged in full and STAY on the statement
  // (SPEC_PAYMENTS_AND_CREDIT #4); every other cancelled booking drops out.
  if (b.status === "cancelled" && b.coachLateCancelCharged !== true) return false;
  return true;
}

/** What it charges. `adminSetBookingStatementExcluded` zeroes the line without deleting the booking. */
export function coachBookingCost(b: any): number {
  return b.statementExcluded === true ? 0 : Number(b.coachPrice) || 0;
}
