// SPEC_STATEMENTS_EDITING — shared coach-statement ledger builder.
//
// ⭐ SPEC_COACH_LEDGER_UNIFICATION_2026-08 Phase 1: the CHARGE RULES and the DAY
// BOUNDARY no longer live here. They come from `convex/lib/coachLedger.ts`, which the
// server-side readers import too, so the statement and the admin badge now run the
// same functions instead of mirrored copies that drifted twice. `filterCoachBookings`
// and `bookingCost` are re-exported below purely so existing call sites keep working.
//
// Both the admin CoachStatementTable and the coach's own /statements route render
// the same reconciliation (coach bookings = charges, payments + adjustment lines).
// This factors the merge/running-balance into one place so the two can't drift.
//
// A statement adjustment has a signed delta: + = a charge/amount owed on the
// statement, − = a credit/discount, 0 = a pure note. Positive deltas add to the
// running balance like a booking charge; negative deltas reduce it like a payment.

import {
  coachBookingCost,
  filterCoachChargeBookings,
  computeCoachLedger,
  awstTodayKey,
  monthStartKey,
} from '../../convex/lib/coachLedger'

export function formatHour(h: number): string {
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  const ampm = hh >= 12 ? 'PM' : 'AM'
  const display = hh % 12 === 0 ? 12 : hh % 12
  return `${display}:${String(mm).padStart(2, '0')} ${ampm}`
}

export type LedgerRow = {
  kind: 'booking' | 'payment' | 'adjustment'
  date: string
  sortKey: string
  label: string
  lane?: string
  method?: string
  charge: number // shown in the Charge column (0 = blank)
  payment: number // shown in the Payment column (0 = blank)
  isNote: boolean // a zero-delta adjustment (note only)
  balance: number
  future?: boolean
  excluded?: boolean // a booking charge the admin removed from the statement (shown $0, struck through)
  raw: any
}

export type CoachLedger = {
  totalBooked: number
  totalPaid: number
  totalAdjust: number // net of all past adjustment deltas
  balance: number
  monthBooked: number
  monthPaid: number
  pastCount: number
  futureCount: number
  displayRows: LedgerRow[]
}

// A booking the admin "removed" from the statement contributes $0 (SPEC_STATEMENTS_EDITING).
// Both of these are now the SHARED definitions, re-exported under their existing names
// so no call site had to change.
export const bookingCost = coachBookingCost

// Filter a raw bookings list (from listBookingsByEmail) down to this coach's
// charged sessions.
export const filterCoachBookings = filterCoachChargeBookings

export function buildCoachLedger(input: {
  bookings: any[]
  payments: any[]
  adjustments: any[]
  todayStr: string
  monthStart: string
}): CoachLedger {
  const { todayStr, monthStart } = input

  const allCoachBookings = filterCoachBookings(input.bookings)
  const coachBookings = allCoachBookings.filter((b: any) => (b.date || '') <= todayStr)
  const futureBookings = allCoachBookings.filter((b: any) => (b.date || '') > todayStr)

  // AUDIT_COACH_BALANCES §5/§7 (built 2026-08-19): payments were the ONLY stream not
  // split past/future — bookings and adjustments both are. A payment dated ahead of
  // today therefore reduced the balance immediately while the sessions it pays for did
  // not yet add to it, so a coach who pre-pays reads as being in credit. It also
  // disagreed internally: `monthPaid` below already filtered `<= todayStr`, so the
  // month figure and the balance were computed on different rules.
  // Split rather than simply dropping future payments (the audit's one-liner), so a
  // pre-payment still SHOWS on the statement as a greyed future row instead of
  // silently vanishing from the coach's history.
  const allPayments = [...(input.payments ?? [])]
  const payments = allPayments.filter((p: any) => (p.dateReceived || '') <= todayStr)
  const futurePayments = allPayments.filter((p: any) => (p.dateReceived || '') > todayStr)
  const allAdjust = [...(input.adjustments ?? [])]
  // Past/today adjustments count in totals + running balance; future ones are
  // shown greyed (like future bookings) and excluded from totals.
  const pastAdjust = allAdjust.filter((a: any) => (a.date || '') <= todayStr)
  const futureAdjust = allAdjust.filter((a: any) => (a.date || '') > todayStr)

  // Phase 2 (SPEC_COACH_LEDGER_UNIFICATION_2026-08): the statement no longer does its own
  // balance arithmetic. `computeCoachLedger` is the single implementation of
  // booked + adjust − paid, shared with the admin badge and the weekly report, so the
  // three cannot arrive at different answers from the same rows. It is handed the RAW
  // lists and does its own date bounding — everything below is presentation.
  const totals = computeCoachLedger({
    bookings: input.bookings,
    payments: input.payments,
    adjustments: input.adjustments,
    asAt: todayStr,
  })
  const { booked: totalBooked, paid: totalPaid, adjust: totalAdjust, balance } = totals

  const month = computeCoachLedger({
    bookings: input.bookings,
    payments: input.payments,
    adjustments: input.adjustments,
    from: monthStart,
    asAt: todayStr,
  })
  const monthBooked = month.booked
  const monthPaid = month.paid

  // Build past rows, sort ascending for running balance.
  const rows: Omit<LedgerRow, 'balance'>[] = []
  for (const b of coachBookings) {
    rows.push({
      kind: 'booking',
      date: b.date,
      sortKey: `${b.date}T${String(b.startHour ?? 0).padStart(5, '0')}`,
      label: `${formatHour(b.startHour)} • ${b.duration} min${b.coachLateCancelCharged ? ' • Late cancel' : ''}`,
      lane: b.laneId || '—',
      charge: bookingCost(b),
      payment: 0,
      isNote: false,
      excluded: b.statementExcluded === true,
      raw: b,
    })
  }
  for (const p of payments) {
    rows.push({
      kind: 'payment',
      date: p.dateReceived,
      sortKey: `${p.dateReceived}T99990`,
      label: p.description || p.note || 'Payment received',
      method: p.method || '—',
      charge: 0,
      payment: p.amount || 0,
      isNote: false,
      raw: p,
    })
  }
  for (const a of pastAdjust) {
    const delta = a.delta || 0
    rows.push({
      kind: 'adjustment',
      date: a.date,
      sortKey: `${a.date}T99995`,
      label: a.label || 'Adjustment',
      charge: delta > 0 ? delta : 0,
      payment: delta < 0 ? -delta : 0,
      isNote: delta === 0,
      raw: a,
    })
  }
  rows.sort((x, y) => x.sortKey.localeCompare(y.sortKey))
  let running = 0
  const rowsWithBalance: LedgerRow[] = rows.map((r) => {
    running += r.charge - r.payment
    return { ...r, balance: running }
  })

  // Future rows (bookings + adjustments): ascending, no balance change.
  const futureRowList: LedgerRow[] = [
    ...futureBookings.map((b: any) => ({
      kind: 'booking' as const,
      date: b.date,
      sortKey: `${b.date}T${String(b.startHour ?? 0).padStart(5, '0')}`,
      label: `${formatHour(b.startHour)} • ${b.duration} min`,
      lane: b.laneId || '—',
      charge: bookingCost(b),
      payment: 0,
      isNote: false,
      balance: 0,
      future: true,
      excluded: b.statementExcluded === true,
      raw: b,
    })),
    ...futurePayments.map((p: any) => ({
      kind: 'payment' as const,
      date: p.dateReceived,
      sortKey: `${p.dateReceived}T99990`,
      label: p.description || p.note || 'Payment received',
      method: p.method || '—',
      charge: 0,
      payment: p.amount || 0,
      isNote: false,
      balance: 0,
      future: true,
      raw: p,
    })),
    ...futureAdjust.map((a: any) => {
      const delta = a.delta || 0
      return {
        kind: 'adjustment' as const,
        date: a.date,
        sortKey: `${a.date}T99995`,
        label: a.label || 'Adjustment',
        charge: delta > 0 ? delta : 0,
        payment: delta < 0 ? -delta : 0,
        isNote: delta === 0,
        balance: 0,
        future: true,
        raw: a,
      }
    }),
  ].sort((x, y) => x.sortKey.localeCompare(y.sortKey))

  // Future at top, then past newest-first.
  const displayRows = [...futureRowList, ...[...rowsWithBalance].reverse()]

  return {
    totalBooked,
    totalPaid,
    totalAdjust,
    balance,
    monthBooked,
    monthPaid,
    pastCount: rowsWithBalance.length,
    futureCount: futureRowList.length,
    displayRows,
  }
}

// Helpers for the current-day / month-start strings the views need.
//
// ⚠️ BEHAVIOUR CHANGE (Phase 1, disagreement #1): this used to read the VIEWER'S
// BROWSER date. It now reads AWST — the venue's day — so the statement cuts its
// past/future split on the same boundary as the admin badge, the weekly report and
// the billing caps. A coach viewing from a non-AWST timezone will see the split move
// by up to a day around midnight; that is the fix, not a side effect. Two people
// looking at identical data previously saw different balances, and neither number
// looked wrong, which is exactly why it went unnoticed.
export function todayAndMonthStart(): { todayStr: string; monthStart: string } {
  const todayStr = awstTodayKey()
  return { todayStr, monthStart: monthStartKey(todayStr) }
}
