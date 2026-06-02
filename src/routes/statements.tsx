import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useAuth } from '../hooks/useAuth'
import { api } from '../../convex/_generated/api'
import { buildCoachLedger, todayAndMonthStart } from '../lib/statementLedger'

export const Route = createFileRoute('/statements')({
  component: StatementsPage,
})

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
  const adjustments = useQuery(
    (api as any).statements.listStatementAdjustments,
    coachId ? ({ subjectType: 'coach', subjectId: coachId } as any) : 'skip'
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

  const { todayStr, monthStart } = todayAndMonthStart()
  const ledger = buildCoachLedger({
    bookings: bookings ?? [],
    payments: payments ?? [],
    adjustments: adjustments ?? [],
    todayStr,
    monthStart,
  })

  const loading = bookings === undefined || payments === undefined || adjustments === undefined

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Statements</h1>
      <p className="text-gray-500 mb-6">Bookings and payments reconciliation.</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Booked (Month)</div>
          <div className="text-2xl font-bold text-gray-900">${ledger.monthBooked.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Paid (Month)</div>
          <div className="text-2xl font-bold text-gray-900">${ledger.monthPaid.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Lifetime Booked</div>
          <div className="text-2xl font-bold text-gray-900">${ledger.totalBooked.toFixed(2)}</div>
        </div>
        <div className={`border rounded-xl p-5 ${ledger.balance > 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <div className="text-xs uppercase font-semibold text-gray-600 mb-1">Outstanding Balance</div>
          <div className={`text-2xl font-bold ${ledger.balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
            ${ledger.balance.toFixed(2)}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            ${ledger.totalBooked.toFixed(2)}
            {ledger.totalAdjust !== 0 && (
              <> {ledger.totalAdjust >= 0 ? '+' : '−'} ${Math.abs(ledger.totalAdjust).toFixed(2)} adj</>
            )}
            {' '}booked − ${ledger.totalPaid.toFixed(2)} paid
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Activity Ledger</h2>
          <span className="text-xs text-gray-500">
            {ledger.pastCount} entries{ledger.futureCount > 0 ? ` + ${ledger.futureCount} upcoming` : ''}
          </span>
        </div>
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : ledger.displayRows.length === 0 ? (
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
                {ledger.displayRows.map((r, i) => {
                  const isFuture = r.future === true
                  const typeBadge =
                    r.kind === 'payment' ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">Payment</span>
                    : r.kind === 'adjustment' ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 text-xs font-medium">{r.isNote ? 'Note' : 'Adjustment'}</span>
                    : isFuture ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs font-medium">Upcoming</span>
                    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">Booking</span>
                  const desc =
                    r.kind === 'booking' ? `${r.lane} • ${r.label}`
                    : r.kind === 'payment' ? `${r.label} (${r.method})`
                    : r.raw?.note ? `${r.label} — ${r.raw.note}` : r.label
                  return (
                    <tr key={i} className={`border-t border-gray-100 ${isFuture ? 'opacity-50' : ''}`}>
                      <td className="px-5 py-3 text-gray-700 whitespace-nowrap">{r.date || '—'}</td>
                      <td className="px-5 py-3">{typeBadge}</td>
                      <td className="px-5 py-3 text-gray-700">{desc}</td>
                      <td className="px-5 py-3 text-right text-gray-900">{r.charge > 0 ? `$${r.charge.toFixed(2)}` : ''}</td>
                      <td className="px-5 py-3 text-right text-emerald-700">{r.payment > 0 ? `−$${r.payment.toFixed(2)}` : ''}</td>
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

      <p className="mt-4 text-xs text-gray-400">
        Bookings are recorded automatically based on coach session prices. Payments and adjustments are entered by admin. Contact admin for corrections.
      </p>
    </div>
  )
}
