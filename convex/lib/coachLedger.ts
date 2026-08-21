// THE definition of what a coach is charged for. One copy, both sides.
// ============================================================================
// SPEC_COACH_LEDGER_UNIFICATION_2026-08 Phase 1. "What does a coach owe?" used to be
// answered by several hand-maintained copies of these rules, and they drifted:
//   2026-08-19 (MON-6)      — the statement counted future-dated payments.
//   2026-08-20 (BATCH 15.2) — the Coaches-tab badge disagreed with the statement for
//                             11 of 23 coaches, worst by $1,105 (Dean Holder showed
//                             $1,692.50 against a real $587.50).
// Each fix patched one consumer. The rules kept drifting because there was no single
// definition to drift FROM.
//
// ⭐ THE FRONTEND IMPORTS THIS FILE DIRECTLY (`src/lib/statementLedger.ts`), so the
// coach's statement and every server-side reader now run the SAME functions rather
// than mirrored copies of them. That is only possible while this module stays PURE:
//   • no `./_generated/server` import
//   • no Convex types, no `ctx`, no database access
// Add anything Convex-shaped here and `vite build` breaks. Server-side code that needs
// `ctx` belongs in the module that uses it, not here.

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

/** Every charged session in a raw bookings list, in one pass. */
export function filterCoachChargeBookings(bookings: any[]): any[] {
  return (bookings ?? []).filter(isCoachChargeBooking);
}

/**
 * Today, as the VENUE reckons it. Perth is UTC+8 with no DST, so a fixed offset is
 * exact — no timezone database, no DST edge cases.
 *
 * ⚠️ Every engine must bound on THIS, not on a local clock. Disagreement #1 was the
 * coach statement cutting its day on the VIEWER'S BROWSER date while the admin badge
 * cut on AWST: two people reading the same data across a day boundary saw different
 * balances, and neither number looked wrong. A coach on the east coast is two hours
 * ahead of the venue; anyone travelling can be a whole day out.
 */
export function awstTodayKey(now: number = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** First day of the AWST month containing `dateKey` (YYYY-MM-DD). */
export function monthStartKey(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

/**
 * Round money to cents. Applied at every boundary so the engines agree exactly rather
 * than to within float noise (disagreement #11: the weekly report and billing caps
 * rounded, the badge and statement did not).
 */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
