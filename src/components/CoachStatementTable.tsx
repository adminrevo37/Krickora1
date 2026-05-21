import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { formatTime } from '../lib/booking-data'

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

  const coachBookings = (bookings as any[]).filter(
    (b) =>
      b.status !== 'cancelled' &&
      (b.isCoachBooking === true || (typeof b.coachPrice === 'number' && b.coachPrice > 0))
  )
  const bookingCost = (b: any) => Number(b.coachPrice || 0)
  const totalBooked = coachBookings.reduce((s, b) => s + bookingCost(b), 0)
  const balance = totalBooked - totalPaid

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const monthPaid = sortedPayments
    .filter((p) => (p.dateReceived || '') >= monthStart && (p.dateReceived || '') <= todayStr)
    .reduce((s, p) => s + (p.amount || 0), 0)
  const monthBooked = coachBookings
    .filter((b) => (b.date || '') >= monthStart && (b.date || '') <= todayStr)
    .reduce((s, b) => s + bookingCost(b), 0)

  type Row =
    | { kind: 'booking'; date: string; sortKey: string; label: string; lane: string; amount: number; balance: number }
    | { kind: 'payment'; date: string; sortKey: string; label: string; method: string; amount: number; balance: number }

  const rows: any[] = []
  for (const b of coachBookings) {
    rows.push({
      kind: 'booking',
      date: b.date,
      sortKey: `${b.date}T${String(b.startHour ?? 0).padStart(5, '0')}`,
      label: `${formatTime(b.startHour)} • ${b.duration} min`,
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
  const displayRows = [...rowsWithBalance].reverse()

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
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 dark:text-gray-400 mb-1">Booked (Month)</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">${monthBooked.toFixed(2)}</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 dark:text-gray-400 mb-1">Paid (Month)</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">${monthPaid.toFixed(2)}</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 dark:text-gray-400 mb-1">Lifetime Booked</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">${totalBooked.toFixed(2)}</div>
        </div>
        <div className={`border rounded-xl p-5 ${balance > 0 ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50' : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/50'}`}>
          <div className="text-xs uppercase font-semibold text-gray-600 dark:text-gray-400 mb-1">
            {balance <= 0 ? 'Paid in full ✓' : 'Outstanding'}
          </div>
          <div className={`text-2xl font-bold ${balance > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
            ${balance.toFixed(2)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            ${totalBooked.toFixed(2)} − ${totalPaid.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between">
          <h4 className="font-semibold text-gray-800 dark:text-gray-200">Activity Ledger</h4>
          <span className="text-xs text-gray-500 dark:text-gray-400">{displayRows.length} entries</span>
        </div>
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading…</div>
        ) : displayRows.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">No activity yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-600 dark:text-gray-400">
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
                {displayRows.map((r, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-5 py-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">{r.date || '—'}</td>
                    <td className="px-5 py-3">
                      {r.kind === 'booking' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-xs font-medium">Booking</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 text-xs font-medium">Payment</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-700 dark:text-gray-300">
                      {r.kind === 'booking'
                        ? `${(r as any).lane} • ${r.label}`
                        : `${r.label} (${(r as any).method})`}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-900 dark:text-gray-100">
                      {r.kind === 'booking' ? `$${r.amount.toFixed(2)}` : ''}
                    </td>
                    <td className="px-5 py-3 text-right text-emerald-700 dark:text-emerald-400">
                      {r.kind === 'payment' ? `−$${r.amount.toFixed(2)}` : ''}
                    </td>
                    <td className={`px-5 py-3 text-right font-semibold ${r.balance > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100'}`}>
                      ${r.balance.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
