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

/** What a coach owes, and the three streams it is made of. */
export type CoachLedgerTotals = {
  booked: number;
  adjust: number;
  paid: number;
  /** booked + adjust − paid. */
  balance: number;
};

/**
 * THE balance arithmetic. Phase 2 of SPEC_COACH_LEDGER_UNIFICATION_2026-08: this is the
 * only place `booked + adjust − paid` is computed, so the admin badge, the coach's
 * statement and the weekly report cannot arrive at different answers from the same rows.
 *
 * Each stream bounds on its OWN date field — bookings `date`, payments `dateReceived`,
 * adjustments `date` — inclusive of `asAt` and, when given, of `from`.
 *
 * ⭐ `asAt` is a parameter rather than "today" because the two legitimate questions
 * differ only by that date: "what does this coach owe right now?" (asAt = today) and
 * "what will they owe when the week closes?" (asAt = Sunday). Phase 5 names both; they
 * are two calls to this function, which is why they cannot drift apart.
 */
export function computeCoachLedger(input: {
  bookings?: any[];
  payments?: any[];
  adjustments?: any[];
  /** Inclusive upper bound (YYYY-MM-DD). */
  asAt: string;
  /** Optional inclusive lower bound, for a windowed figure like "this week". */
  from?: string;
}): CoachLedgerTotals {
  const { asAt, from } = input;
  const inWindow = (d: string) => d <= asAt && (from === undefined || d >= from);

  let booked = 0;
  for (const b of input.bookings ?? []) {
    if (!isCoachChargeBooking(b)) continue;
    if (!inWindow(b.date ?? "")) continue;
    booked += coachBookingCost(b);
  }
  let paid = 0;
  for (const p of input.payments ?? []) {
    if (!inWindow(p.dateReceived ?? "")) continue;
    paid += Number(p.amount) || 0;
  }
  let adjust = 0;
  for (const a of input.adjustments ?? []) {
    if (!inWindow(a.date ?? "")) continue;
    adjust += Number(a.delta) || 0;
  }

  booked = round2(booked);
  paid = round2(paid);
  adjust = round2(adjust);
  return { booked, adjust, paid, balance: round2(booked + adjust - paid) };
}

// ── The week ─────────────────────────────────────────────────────────────────
// Mon–Sun, matching the weekly report and the weekly billing cap. Pure string date
// arithmetic in UTC, so it is calendar-safe and carries no timezone of its own — the
// AWST-ness lives entirely in `awstTodayKey()`, which produces the key these operate on.

/** Add (or subtract) whole days to a YYYY-MM-DD. */
export function addDaysStr(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Monday of the week containing `dateStr`. */
export function mondayOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay(); // 0=Sun..6=Sat
  return addDaysStr(dateStr, dow === 0 ? -6 : 1 - dow);
}

/** Sunday of the week containing `dateStr`. */
export function sundayOfWeek(dateStr: string): string {
  return addDaysStr(mondayOfWeek(dateStr), 6);
}

/** The two balances a coach actually needs, and the gap between them. */
export type CoachBalancePair = {
  /** Everything dated on or before today (AWST) — INCLUDING today's sessions, started or not. */
  today: number;
  /** Everything dated on or before Sunday of the current week. */
  endOfWeek: number;
  /** endOfWeek − today: the rest of this week's booked sessions (and any week-dated credit). */
  delta: number;
  todayKey: string;
  weekEndKey: string;
  /** True on Sunday, when the two figures are necessarily the same. */
  isWeekEnd: boolean;
  /**
   * What the delta is actually MADE OF — everything dated after today and on or before
   * Sunday. Without this the UI can only guess why the two balances differ, and a
   * negative delta has more than one possible cause (a weekly cap credit, a future-dated
   * payment, a manual credit). Guessing produces a confidently wrong explanation.
   */
  rest: CoachLedgerTotals;
};

/**
 * TWO NAMED BALANCES (SPEC_COACH_LEDGER_UNIFICATION_2026-08 Phase 5, Inspector 2026-08-21).
 *
 * The system was already computing both of these; it just presented them as if they
 * were the same number and let them contradict each other — the admin badge answering
 * "what is owed now", the weekly report answering "what will be owed on Sunday", with
 * nothing on screen saying so. Naming them dissolves that (disagreement #3): they are
 * two legitimate questions, not two answers to one question.
 *
 * ⚠️ `today` deliberately INCLUDES today's sessions even if they have not started yet —
 * a coach with an 8pm session tonight is charged for it from midnight this morning.
 * That is the long-standing behaviour; the UI must SAY it rather than leave a coach to
 * work it out from a number that moved for no visible reason.
 *
 * ⚠️ A capped coach can correctly show a LOWER end-of-week balance than today's: the
 * weekly cap credit is dated weekEnd because it reflects the whole week's overage, and
 * is not final until the week ends. Real and explainable, not a bug — say so in the UI.
 *
 * This is two calls to `computeCoachLedger`. That is the entire implementation, and the
 * reason Phase 5 had to wait for Phase 2: built earlier it would have been another
 * hand-rolled copy of the same arithmetic, which is the mistake this spec exists to stop.
 */
export function computeCoachBalancePair(input: {
  bookings?: any[];
  payments?: any[];
  adjustments?: any[];
  /** Defaults to today in AWST. */
  todayKey?: string;
}): CoachBalancePair {
  const todayKey = input.todayKey ?? awstTodayKey();
  const weekEndKey = sundayOfWeek(todayKey);
  const today = computeCoachLedger({ ...input, asAt: todayKey }).balance;
  const endOfWeek = computeCoachLedger({ ...input, asAt: weekEndKey }).balance;
  const rest = computeCoachLedger({
    ...input,
    from: addDaysStr(todayKey, 1),
    asAt: weekEndKey,
  });
  return {
    today,
    endOfWeek,
    delta: round2(endOfWeek - today),
    todayKey,
    weekEndKey,
    isWeekEnd: weekEndKey === todayKey,
    rest,
  };
}
