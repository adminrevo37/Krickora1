import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { formatDateKey } from '../lib/booking-data'

export default function ClosureManager({ selectedDate }: { selectedDate: Date }) {
  const closures = (useQuery(api.closures.listUpcoming) ?? []) as any[]
  const addClosure = useMutation(api.closures.addClosure)
  const removeClosure = useMutation(api.closures.removeClosure)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const dateKey = formatDateKey(selectedDate)
  const today = new Date(); today.setHours(0,0,0,0)
  const isPast = selectedDate < today
  const currentClosure = closures.find((c) => c.date === dateKey)
  const activeCount = useQuery(api.closures.countActiveBookingsOnDate, { date: dateKey }) ?? 0

  const handleClose = async () => {
    if (activeCount > 0) {
      const ok = confirm(
        `This date has ${activeCount} active booking${activeCount === 1 ? '' : 's'}.\n\n` +
        `Closing it will CANCEL ${activeCount === 1 ? 'it' : 'them all'}, auto-credit any paid ` +
        `customers, and email them that the facility is closed.\n\nContinue?`
      )
      if (!ok) return
    }
    setBusy(true)
    try {
      const res: any = await addClosure({ date: dateKey, reason: reason.trim() || undefined })
      setReason('')
      if (res?.cancelledCount > 0) {
        alert(
          `Closed. Cancelled ${res.cancelledCount} booking${res.cancelledCount === 1 ? '' : 's'}` +
          (res.totalCreditIssued > 0 ? ` and issued $${res.totalCreditIssued.toFixed(2)} in account credit.` : '.')
        )
      }
    } catch (e: any) {
      alert(e?.message ?? 'Failed to close date')
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (id: string, date: string) => {
    if (!confirm(`Reopen ${date}?`)) return
    try { await removeClosure({ id: id as any }) } catch (e: any) { alert(e?.message ?? 'Failed') }
  }

  const fmtDate = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    return new Date(y, m - 1, day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200">🚫 Facility Closures</h3>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">Mark full days as closed — all lanes will be unbookable</p>
        </div>
      </div>

      {/* Close selected date */}
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-lg p-3 mb-3">
        <div className="text-[11px] font-semibold text-red-700 dark:text-red-400 mb-2">
          Selected: {selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
        </div>
        {isPast ? (
          <div className="text-xs text-gray-500">Cannot close past dates.</div>
        ) : currentClosure ? (
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-red-700 dark:text-red-400">
              ✓ Closed{currentClosure.reason ? ` — ${currentClosure.reason}` : ''}
            </div>
            <button
              onClick={() => handleRemove(currentClosure._id, currentClosure.date)}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-white dark:bg-gray-800 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 font-semibold hover:bg-red-100 dark:hover:bg-red-900/40"
            >
              Reopen
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional) — e.g. Public Holiday"
              className="flex-1 px-3 py-1.5 text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg outline-none focus:ring-2 focus:ring-red-500"
            />
            <button
              onClick={handleClose}
              disabled={busy}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-50"
            >
              {busy ? 'Closing…' : '🚫 Close this day'}
            </button>
          </div>
        )}
      </div>

      {/* List upcoming */}
      <div>
        <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-400 mb-1.5">
          Upcoming closures ({closures.length})
        </div>
        {closures.length === 0 ? (
          <div className="text-xs text-gray-400 italic px-2 py-3">No upcoming closures.</div>
        ) : (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {closures.map((c) => (
              <div key={c._id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{fmtDate(c.date)}</div>
                  {c.reason && <div className="text-[10px] text-gray-500 truncate">{c.reason}</div>}
                </div>
                <button
                  onClick={() => handleRemove(c._id, c.date)}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 font-semibold hover:bg-red-200"
                >
                  Reopen
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
