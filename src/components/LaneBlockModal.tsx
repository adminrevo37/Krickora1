import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { LANES, formatDateKey, generateTimeSlots } from '../lib/booking-data'

interface Props {
  date: Date
  prefill: { laneId: string; startHour: number } | null
  onClose: () => void
}

export default function LaneBlockModal({ date, prefill, onClose }: Props) {
  const addBlock = useMutation(api.laneBlocks.addLaneBlock)
  const [laneIds, setLaneIds] = useState<string[]>(prefill ? [prefill.laneId] : [])
  const [startHour, setStartHour] = useState<number>(prefill?.startHour ?? 9)
  const [duration, setDuration] = useState<number>(60)
  const [reason, setReason] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const slots = generateTimeSlots()
  const dateKey = formatDateKey(date)

  const toggleLane = (id: string) => {
    setLaneIds((prev) => prev.includes(id) ? prev.filter(l => l !== id) : [...prev, id])
  }

  const selectAll = () => setLaneIds(LANES.map(l => l.id))
  const clearAll = () => setLaneIds([])

  const handleSubmit = async () => {
    setError(null)
    if (laneIds.length === 0) { setError('Select at least one lane'); return }
    const ok = confirm(
      'Blocking will CANCEL any bookings that overlap this time on the selected ' +
      'lane(s), auto-credit any paid customers, and email them it was for maintenance.\n\nContinue?'
    )
    if (!ok) return
    setSaving(true)
    try {
      let cancelledCount = 0
      let totalCredit = 0
      for (const lid of laneIds) {
        const res: any = await addBlock({ laneId: lid, date: dateKey, startHour, duration, reason: reason.trim() || undefined })
        cancelledCount += res?.cancelledCount ?? 0
        totalCredit += res?.totalCreditIssued ?? 0
      }
      if (cancelledCount > 0) {
        alert(
          `Blocked. Cancelled ${cancelledCount} booking${cancelledCount === 1 ? '' : 's'}` +
          (totalCredit > 0 ? ` and issued $${totalCredit.toFixed(2)} in account credit.` : '.')
        )
      }
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create block')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">🔧 Block Lane for Service</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          {date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
        </p>

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">Select lanes</label>
              <div className="flex gap-2 text-[10px]">
                <button onClick={selectAll} className="text-emerald-600 hover:underline font-semibold">All</button>
                <button onClick={clearAll} className="text-gray-500 hover:underline font-semibold">Clear</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {LANES.map(lane => {
                const selected = laneIds.includes(lane.id)
                return (
                  <button
                    key={lane.id}
                    onClick={() => toggleLane(lane.id)}
                    className={`text-xs px-3 py-2 rounded-lg border font-semibold transition-all ${
                      selected
                        ? 'bg-orange-500 border-orange-500 text-white'
                        : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    {lane.icon} {lane.shortName}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 block mb-1">Start time</label>
              <select
                value={startHour}
                onChange={(e) => setStartHour(Number(e.target.value))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
              >
                {slots.map(s => <option key={s.hour} value={s.hour}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 block mb-1">Duration</label>
              <select
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
              >
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={90}>1.5 hours</option>
                <option value={120}>2 hours</option>
                <option value={180}>3 hours</option>
                <option value={240}>4 hours</option>
                <option value={480}>All day (8h)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 block mb-1">Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Machine repair, cleaning..."
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
            />
          </div>

          {error && <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-lg p-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="flex-1 text-sm px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold hover:bg-gray-200 dark:hover:bg-gray-700">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={saving || laneIds.length === 0}
              className="flex-1 text-sm px-4 py-2 rounded-lg bg-orange-500 text-white font-semibold hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Blocking...' : `Block ${laneIds.length} lane${laneIds.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
