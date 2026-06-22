// SPEC_STATEMENTS_EDITING — shared coach-statement ledger builder.
//
// Both the admin CoachStatementTable and the coach's own /statements route render
// the same reconciliation (coach bookings = charges, payments + adjustment lines).
// This factors the merge/running-balance into one place so the two can't drift.
//
// A statement adjustment has a signed delta: + = a charge/amount owed on the
// statement, − = a credit/discount, 0 = a pure note. Positive deltas add to the
// running balance like a booking charge; negative deltas reduce it like a payment.

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
const bookingCost = (b: any) => (b.statementExcluded === true ? 0 : Number(b.coachPrice || 0))

// Filter a raw bookings list (from listBookingsByEmail) down to this coach's
// charged sessions. Matches the long-standing inline filter in both views.
export function filterCoachBookings(bookings: any[]): any[] {
  return (bookings ?? []).filter(
    (b: any) =>
      // Late-cancelled coach bookings are charged in full and stay on the
      // statement (SPEC_PAYMENTS_AND_CREDIT #4).
      (b.status !== 'cancelled' || b.coachLateCancelCharged === true) &&
      (b.isCoachBooking === true || (typeof b.coachPrice === 'number' && b.coachPrice > 0))
  )
}

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

  const payments = [...(input.payments ?? [])]
  const allAdjust = [...(input.adjustments ?? [])]
  // Past/today adjustments count in totals + running balance; future ones are
  // shown greyed (like future bookings) and excluded from totals.
  const pastAdjust = allAdjust.filter((a: any) => (a.date || '') <= todayStr)
  const futureAdjust = allAdjust.filter((a: any) => (a.date || '') > todayStr)

  const totalBooked = coachBookings.reduce((s, b) => s + bookingCost(b), 0)
  const totalPaid = payments.reduce((s, p) => s + (p.amount || 0), 0)
  const totalAdjust = pastAdjust.reduce((s, a) => s + (a.delta || 0), 0)
  const balance = totalBooked + totalAdjust - totalPaid

  const monthBooked = coachBookings
    .filter((b: any) => (b.date || '') >= monthStart)
    .reduce((s, b) => s + bookingCost(b), 0)
  const monthPaid = payments
    .filter((p: any) => (p.dateReceived || '') >= monthStart && (p.dateReceived || '') <= todayStr)
    .reduce((s, p) => s + (p.amount || 0), 0)

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
export function todayAndMonthStart(): { todayStr: string; monthStart: string } {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
  return { todayStr, monthStart }
}
