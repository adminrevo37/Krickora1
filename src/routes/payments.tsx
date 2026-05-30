import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useAuth } from '../hooks/useAuth'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/payments')({
  component: PaymentsPage,
})

const LANE_NAMES: Record<string, string> = {
  bm1: 'Bowling Machine 1',
  bm2: 'Bowling Machine 2',
  bm3: 'Bowling Machine 3',
  ru1: '9m Run Up 1',
  ru2: '9m Run Up 2',
}

function formatHour(h: number) {
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  const ampm = hh >= 12 ? 'PM' : 'AM'
  const display = hh % 12 === 0 ? 12 : hh % 12
  return `${display}:${String(mm).padStart(2, '0')} ${ampm}`
}

// Friendly labels for creditLedger.reason
const REASON_LABEL: Record<string, string> = {
  cancellation: 'Booking cancelled — credit returned',
  modify_decrease: 'Booking shortened — credit returned',
  admin_grant: 'Credit added by admin',
  admin_adjust: 'Admin adjustment',
  redeemed: 'Applied to a booking',
  account_deleted: 'Account closed',
}

function PaymentsPage() {
  const { user, isLoading } = useAuth()

  const customer = useQuery(
    api.queries.getCustomerByEmail,
    user?.email ? { email: user.email } : 'skip'
  )
  const payments = useQuery(
    api.queries.listMyPayments,
    user?.email ? { email: user.email } : 'skip'
  )
  const ledger = useQuery(
    api.queries.listCreditLedger,
    user?.email ? { email: user.email } : 'skip'
  )

  if (isLoading) {
    return <div className="max-w-5xl mx-auto px-4 py-16 text-center text-gray-500">Loading...</div>
  }

  if (!user) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Sign In Required</h2>
        <p className="text-gray-500">Sign in to view your payments and account credit.</p>
      </div>
    )
  }

  const creditBalance = customer?.creditBalance ?? 0

  // Payments newest-first
  const sortedPayments = [...(payments ?? [])].sort((a: any, b: any) =>
    (b.date || '').localeCompare(a.date || '') || (b.startHour ?? 0) - (a.startHour ?? 0)
  )
  const totalPaid = sortedPayments.reduce((s: number, p: any) => s + (p.amountPaid || 0), 0)

  // Ledger newest-first
  const sortedLedger = [...(ledger ?? [])].sort((a: any, b: any) =>
    (b.at || '').localeCompare(a.at || '')
  )

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })
    } catch {
      return iso
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Payments &amp; Credit</h1>
      <p className="text-gray-500 mb-6">Your payment history and account credit.</p>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-gradient-to-br from-blue-500 to-indigo-500 text-white rounded-xl p-5 shadow-sm">
          <div className="text-xs uppercase font-semibold opacity-80 mb-1">Account Credit</div>
          <div className="text-3xl font-bold">${creditBalance.toFixed(2)}</div>
          <div className="text-xs opacity-80 mt-1">Applied automatically at checkout</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Total Paid</div>
          <div className="text-3xl font-bold text-gray-900">${totalPaid.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Payments</div>
          <div className="text-3xl font-bold text-gray-900">{sortedPayments.length}</div>
        </div>
      </div>

      {/* Payments */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-8">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
          <h2 className="font-semibold text-gray-800">Payment History</h2>
        </div>
        {payments === undefined ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : sortedPayments.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No payments yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold">Date</th>
                  <th className="text-left px-5 py-2 font-semibold">Session</th>
                  <th className="text-right px-5 py-2 font-semibold">Paid</th>
                  <th className="text-right px-5 py-2 font-semibold">Credit Used</th>
                  <th className="text-left px-5 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedPayments.map((p: any) => (
                  <tr key={p.bookingId} className="border-t border-gray-100">
                    <td className="px-5 py-3 text-gray-700 whitespace-nowrap">{p.date}</td>
                    <td className="px-5 py-3 text-gray-700">
                      {(LANE_NAMES[p.laneId] ?? p.laneId)} • {formatHour(p.startHour)}
                      {p.discountCode ? <span className="ml-2 text-xs text-purple-600">({p.discountCode})</span> : null}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-900">${(p.amountPaid || 0).toFixed(2)}</td>
                    <td className="px-5 py-3 text-right text-blue-600">
                      {p.creditApplied > 0 ? `$${p.creditApplied.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-5 py-3">
                      {p.status === 'cancelled' ? (
                        <span className="inline-flex px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs font-medium">Cancelled</span>
                      ) : p.paymentStatus === 'paid' ? (
                        <span className="inline-flex px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">Paid</span>
                      ) : (
                        <span className="inline-flex px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-medium">Pending</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-5 py-3 border-t border-gray-100 text-xs text-gray-400">
          A Stripe receipt is emailed for each card payment. Contact us if you need a copy resent.
        </div>
      </div>

      {/* Credit history */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
          <h2 className="font-semibold text-gray-800">Credit History</h2>
        </div>
        {ledger === undefined ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : sortedLedger.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No credit activity yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold">Date</th>
                  <th className="text-left px-5 py-2 font-semibold">Description</th>
                  <th className="text-right px-5 py-2 font-semibold">Change</th>
                  <th className="text-right px-5 py-2 font-semibold">Balance</th>
                </tr>
              </thead>
              <tbody>
                {sortedLedger.map((e: any) => (
                  <tr key={e._id} className="border-t border-gray-100">
                    <td className="px-5 py-3 text-gray-700 whitespace-nowrap">{fmtDate(e.at)}</td>
                    <td className="px-5 py-3 text-gray-700">
                      {REASON_LABEL[e.reason] ?? e.reason}
                      {e.note ? <span className="text-gray-400"> — {e.note}</span> : null}
                    </td>
                    <td className={`px-5 py-3 text-right font-semibold ${e.delta >= 0 ? 'text-emerald-700' : 'text-gray-700'}`}>
                      {e.delta >= 0 ? '+' : '−'}${Math.abs(e.delta).toFixed(2)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-900">${(e.balanceAfter ?? 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-gray-400">
        <Link to="/bookings" className="text-blue-600 hover:underline">View my bookings</Link>
      </p>
    </div>
  )
}
