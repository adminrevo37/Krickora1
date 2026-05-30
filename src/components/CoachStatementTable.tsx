import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'

function formatHour(h: number) {
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  const ampm = hh >= 12 ? 'PM' : 'AM'
  const display = hh % 12 === 0 ? 12 : hh % 12
  return `${display}:${String(mm).padStart(2, '0')} ${ampm}`
}

type Props = {
  coachId: string
  coachEmail?: string
  coachName?: string
}

export default function CoachStatementTable({ coachId, coachEmail, coachName }: Props) {
  const payments = useQuery(api.queries.listPaymentsByCoach, coachId ? { coachId } : 'skip') ?? []
  const bookings = useQuery(
    api.queries.listBookingsByEmail,
    coachEmail ? { email: coachEmail } : 'skip'
  ) ?? []

  const sortedPayments = [...(payments as any[])].sort((a, b) =>
    (b.dateReceived || '').localeCompare(a.dateReceived || '')
  )
  const totalPaid = sortedPayments.reduce((s, p) => s + (p.amount || 0), 0)

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`

  const allCoachBookings = (bookings as any[]).filter(
    (b) =>
      // Late-cancelled coach bookings are charged in full and stay on the
      // statement (SPEC_PAYMENTS_AND_CREDIT #4).
      (b.status !== 'cancelled' || b.coachLateCancelCharged === true) &&
      (b.isCoachBooking === true || (typeof b.coachPrice === 'number' && b.coachPrice > 0))
  )
  // Past/today: count in totals and running balance
  const coachBookings = allCoachBookings.filter((b) => (b.date || '') <= todayStr)
  // Future: shown greyed out, excluded from all totals
  const futureBookings = allCoachBookings.filter((b) => (b.date || '') > todayStr)

  const bookingCost = (b: any) => Number(b.coachPrice || 0)
  const totalBooked = coachBookings.reduce((s: number, b: any) => s + bookingCost(b), 0)
  const balance = totalBooked - totalPaid

  const monthPaid = sortedPayments
    .filter((p) => (p.dateReceived || '') >= monthStart && (p.dateReceived || '') <= todayStr)
    .reduce((s, p) => s + (p.amount || 0), 0)
  const monthBooked = coachBookings
    .filter((b) => (b.date || '') >= monthStart)
    .reduce((s: number, b: any) => s + bookingCost(b), 0)

  type Row =
    | { kind: 'booking'; date: string; sortKey: string; label: string; lane: string; amount: number; balance: number; future?: boolean }
    | { kind: 'payment'; date: string; sortKey: string; label: string; method: string; amount: number; balance: number }

  // Build past rows with running balance
  const rows: any[] = []
  for (const b of coachBookings) {
    rows.push({
      kind: 'booking',
      date: b.date,
      sortKey: `${b.date}T${String(b.startHour ?? 0).padStart(5, '0')}`,
      label: `${formatHour(b.startHour)} • ${b.duration} min${b.coachLateCancelCharged ? ' • Late cancel' : ''}`,
      lane: b.laneId || '—',
      amount: bookingCost(b),
    })
  }
  for (const p of sortedPayments) {
    rows.push({
      kind: 'payment',
      date: p.dateReceived,
      sortKey: `${p.dateReceived}T99999`,
      label: p.description || p.note || 'Payment received',
      method: p.method || '—',
      amount: p.amount || 0,
    })
  }
  rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
  let running = 0
  const rowsWithBalance: Row[] = rows.map((r) => {
    running += r.kind === 'booking' ? r.amount : -r.amount
    return { ...r, balance: running } as Row
  })

  // Future rows: sorted ascending, no balance change, flagged future
  const futureRows: Row[] = [...futureBookings]
    .sort((a: any, b: any) => (a.date || '').localeCompare(b.date || '') || (a.startHour ?? 0) - (b.startHour ?? 0))
    .map((b: any) => ({
      kind: 'booking' as const,
      date: b.date,
      sortKey: `${b.date}T${String(b.startHour ?? 0).padStart(5, '0')}`,
      label: `${formatHour(b.startHour)} • ${b.duration} min`,
      lane: b.laneId || '—',
      amount: bookingCost(b),
      balance: 0,
      future: true,
    }))

  // Future rows at top (upcoming), then past newest-first
  const displayRows = [...futureRows, ...[...rowsWithBalance].reverse()]

  const loading = payments === undefined || bookings === undefined

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-gray-800">
          {coachName || coachEmail || 'Coach'} — Lifetime Statement
        </h3>
        <p className="text-sm text-gray-500">{coachEmail}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Booked (Month)</div>
          <div className="text-2xl font-bold text-gray-900">${monthBooked.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Paid (Month)</div>
          <div className="text-2xl font-bold text-gray-900">${monthPaid.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Lifetime Booked</div>
          <div className="text-2xl font-bold text-gray-900">${totalBooked.toFixed(2)}</div>
        </div>
        <div className={`border rounded-xl p-5 ${balance > 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <div className="text-xs uppercase font-semibold text-gray-600 mb-1">Outstanding</div>
          <div className={`text-2xl font-bold ${balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
            ${balance.toFixed(2)}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            ${totalBooked.toFixed(2)} − ${totalPaid.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <h4 className="font-semibold text-gray-800">Activity Ledger</h4>
          <span className="text-xs text-gray-500">
            {rowsWithBalance.length} entries{futureRows.length > 0 ? ` + ${futureRows.length} upcoming` : ''}
          </span>
        </div>
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : displayRows.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No activity yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold">Date</th>
                  <th className="text-left px-5 py-2 font-semibold">Type</th>
                  <th className="text-left px-5 py-2 font-semibold">Description</th>
                  <th className="text-right px-5 py-2 font-semibold">Charge</th>
                  <th className="text-right px-5 py-2 font-semibold">Payment</th>
                  <th className="text-right px-5 py-2 font-semibold">Balance</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r, i) => {
                  const isFuture = (r as any).future === true
                  return (
                    <tr key={i} className={`border-t border-gray-100 ${isFuture ? 'opacity-50' : ''}`}>
                      <td className="px-5 py-3 text-gray-700 whitespace-nowrap">{r.date || '—'}</td>
                      <td className="px-5 py-3">
                        {r.kind === 'booking' ? (
                          isFuture ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs font-medium">Upcoming</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">Booking</span>
                          )
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">Payment</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-gray-700">
                        {r.kind === 'booking'
                          ? `${(r as any).lane} • ${r.label}`
                          : `${r.label} (${(r as any).method})`}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-900">
                        {r.kind === 'booking' ? `$${r.amount.toFixed(2)}` : ''}
                      </td>
                      <td className="px-5 py-3 text-right text-emerald-700">
                        {r.kind === 'payment' ? `−$${r.amount.toFixed(2)}` : ''}
                      </td>
                      <td className={`px-5 py-3 text-right font-semibold ${isFuture ? 'text-gray-400' : r.balance > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
                        {isFuture ? '—' : `$${r.balance.toFixed(2)}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
