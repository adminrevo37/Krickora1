import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useAuth } from '../hooks/useAuth'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/statements')({
  component: StatementsPage,
})

function formatHour(h: number) {
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  const ampm = hh >= 12 ? 'PM' : 'AM'
  const display = hh % 12 === 0 ? 12 : hh % 12
  return `${display}:${String(mm).padStart(2, '0')} ${ampm}`
}

function StatementsPage() {
  const { user, isCoach, isAdmin, isLoading } = useAuth()

  const customer = useQuery(
    api.queries.getCustomerByEmail,
    user?.email ? { email: user.email } : 'skip'
  )

  const coachId = customer?._id ?? ''
  const payments = useQuery(
    api.queries.listPaymentsByCoach,
    coachId ? { coachId } : 'skip'
  )

  const bookings = useQuery(
    api.queries.listBookingsByEmail,
    user?.email ? { email: user.email } : 'skip'
  )

  if (isLoading) {
    return <div className="max-w-7xl mx-auto px-4 py-16 text-center text-gray-500">Loading...</div>
  }

  if (!isCoach && !isAdmin) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Coach Access Required</h2>
        <p className="text-gray-500">Only coaches can view statements.</p>
      </div>
    )
  }

  const paymentsList = payments ?? []
  const sortedPayments = [...paymentsList].sort((a: any, b: any) =>
    (b.dateReceived || '').localeCompare(a.dateReceived || '')
  )
  const totalPaid = sortedPayments.reduce((s: number, p: any) => s + (p.amount || 0), 0)

  // Include ALL non-cancelled bookings for this coach email.
  // Catches both explicit coach bookings AND legacy bookings that may not
  // have the isCoachBooking flag set but still belong to this coach.
  const coachBookings = (bookings ?? []).filter(
    (b: any) =>
      b.status !== 'cancelled' &&
      (b.isCoachBooking === true || (typeof b.coachPrice === 'number' && b.coachPrice > 0))
  )
  const sortedBookings = [...coachBookings].sort((a: any, b: any) => {
    const cmp = (b.date || '').localeCompare(a.date || '')
    if (cmp !== 0) return cmp
    return (b.startHour || 0) - (a.startHour || 0)
  })

  // Compute cost per booking. Prefer stored coachPrice; fall back to 0.
  const bookingCost = (b: any) => Number(b.coachPrice || 0)
  const totalBooked = sortedBookings.reduce((s: number, b: any) => s + bookingCost(b), 0)
  const balance = totalBooked - totalPaid

  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const pad = (n: number) => String(n).padStart(2, '0')
  const monthStart = `${y}-${pad(m + 1)}-01`
  const todayStr = `${y}-${pad(m + 1)}-${pad(now.getDate())}`
  const monthPaid = sortedPayments
    .filter((p: any) => (p.dateReceived || '') >= monthStart && (p.dateReceived || '') <= todayStr)
    .reduce((s: number, p: any) => s + (p.amount || 0), 0)
  const monthBooked = sortedBookings
    .filter((b: any) => (b.date || '') >= monthStart && (b.date || '') <= todayStr)
    .reduce((s: number, b: any) => s + bookingCost(b), 0)

  // Merge into a unified activity ledger sorted by date desc with running balance (asc internal)
  type Row =
    | { kind: 'booking'; date: string; sortKey: string; label: string; lane: string; amount: number; raw: any }
    | { kind: 'payment'; date: string; sortKey: string; label: string; method: string; amount: number; raw: any }

  const rows: Row[] = []
  for (const b of sortedBookings) {
    rows.push({
      kind: 'booking',
      date: b.date,
      sortKey: `${b.date}T${String(b.startHour ?? 0).padStart(5, '0')}`,
      label: `${formatHour(b.startHour)} • ${b.duration} min`,
      lane: b.laneId || '—',
      amount: bookingCost(b),
      raw: b,
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
      raw: p,
    })
  }
  // Sort ascending for running balance, then reverse for display
  rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
  let running = 0
  const rowsWithBalance = rows.map((r) => {
    running += r.kind === 'booking' ? r.amount : -r.amount
    return { ...r, balance: running }
  })
  const displayRows = [...rowsWithBalance].reverse()

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Statements</h1>
      <p className="text-gray-500 mb-6">Bookings and payments reconciliation.</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
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
          <div className="text-xs uppercase font-semibold text-gray-600 mb-1">Outstanding Balance</div>
          <div className={`text-2xl font-bold ${balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
            ${balance.toFixed(2)}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            ${totalBooked.toFixed(2)} booked − ${totalPaid.toFixed(2)} paid
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Activity Ledger</h2>
          <span className="text-xs text-gray-500">{displayRows.length} entries</span>
        </div>
        {bookings === undefined || payments === undefined ? (
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
                {displayRows.map((r, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-5 py-3 text-gray-700 whitespace-nowrap">{r.date || '—'}</td>
                    <td className="px-5 py-3">
                      {r.kind === 'booking' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                          Booking
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">
                          Payment
                        </span>
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
                    <td className={`px-5 py-3 text-right font-semibold ${r.balance > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
                      ${r.balance.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-gray-400">
        Bookings are recorded automatically based on coach session prices. Payments are entered by admin. Contact admin for corrections.
      </p>
    </div>
  )
}
