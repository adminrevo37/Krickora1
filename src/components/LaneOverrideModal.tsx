// LaneOverrideModal — admin "Edit layout for this date" (SPEC_RECONFIGURABLE_LANES
// §6, §8). Lists the 5 lanes pre-filled from the date's resolved config; admin
// edits each lane's segment list (reusing LaneSegmentEditor); a single save can
// apply through an end date (range). Reverting a lane to its default clears the
// override server-side (upsertLaneOverride). Warns if bookings already exist on
// the date — existing bookings keep their snapshot.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import { useSettings } from '../hooks/useSettings'
import { formatDateKey } from '../lib/booking-data'
import LaneSegmentEditor from './LaneSegmentEditor'
import { type LaneRow, type Segment, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } from '../lib/lanes'

interface Props {
  date: Date
  onClose: () => void
}

export default function LaneOverrideModal({ date, onClose }: Props) {
  const dateKey = formatDateKey(date)
  const { settings } = useSettings()
  const openHour = settings.openingHour ?? DEFAULT_OPEN_HOUR
  const closeHour = settings.closingHour ?? DEFAULT_CLOSE_HOUR

  const layout = useQuery(api.lanes.getLaneLayoutForDate, { date: dateKey }) as
    | Array<{ laneId: string; bayNumber: number; order: number; segments: Segment[]; isOverride: boolean; warning: string | null }>
    | undefined
  const defaults = useQuery(api.lanes.listLanes, {}) as LaneRow[] | undefined
  const upsert = useMutation(api.lanes.upsertLaneOverride)

  const laneIds = useMemo(() => (defaults ?? []).map((l) => l.laneId), [defaults])
  const bookingCount =
    (useQuery(api.lanes.countBookingsOnDate, laneIds.length ? { date: dateKey, laneIds } : 'skip') as
      | number
      | undefined) ?? 0

  const [draft, setDraft] = useState<Record<string, Segment[]>>({})
  const [endDate, setEndDate] = useState<string>(dateKey)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!layout) return
    setDraft((prev) => {
      if (Object.keys(prev).length) return prev
      const next: Record<string, Segment[]> = {}
      for (const l of layout) next[l.laneId] = l.segments
      return next
    })
  }, [layout])

  if (layout === undefined || defaults === undefined) {
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 text-sm text-gray-500">Loading layout…</div>
      </div>
    )
  }

  const ordered = [...layout].sort((a, b) => a.order - b.order)

  const save = async () => {
    setError(null)
    if (endDate < dateKey) {
      setError('End date is before the start date.')
      return
    }
    const rangeDays = Math.round((new Date(endDate).getTime() - new Date(dateKey).getTime()) / 86400000) + 1
    if (bookingCount > 0 || rangeDays > 1) {
      const msg =
        (bookingCount > 0
          ? `${bookingCount} existing booking${bookingCount === 1 ? '' : 's'} on ${dateKey} will keep the lane name they were booked with. `
          : '') +
        (rangeDays > 1 ? `This layout will apply to all ${rangeDays} days from ${dateKey} to ${endDate}. ` : '') +
        'Continue?'
      if (!confirm(msg)) return
    }
    setSaving(true)
    try {
      for (const lane of ordered) {
        await upsert({
          laneId: lane.laneId,
          startDate: dateKey,
          endDate,
          segments: (draft[lane.laneId] ?? lane.segments) as any,
        })
      }
      onClose()
    } catch (e) {
      setError(getErrorMessage(e) ?? 'Could not save the layout.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Edit lane layout for this date</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {bookingCount > 0 && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2">
              ⚠️ {bookingCount} booking{bookingCount === 1 ? '' : 's'} already exist on this date. They keep the lane
              name they were booked with; only new bookings see the change.
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>
          )}

          {ordered.map((lane) => (
            <div key={lane.laneId} className="rounded-xl border border-gray-200 dark:border-gray-700 p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                  Bay {lane.bayNumber} <span className="text-xs font-normal text-gray-400">({lane.laneId})</span>
                </h3>
                {lane.isOverride && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                    ⚙ Custom
                  </span>
                )}
              </div>
              <LaneSegmentEditor
                bayNumber={lane.bayNumber}
                segments={draft[lane.laneId] ?? lane.segments}
                onChange={(segs) => setDraft((d) => ({ ...d, [lane.laneId]: segs }))}
                openHour={openHour}
                closeHour={closeHour}
              />
            </div>
          ))}
        </div>

        <div className="p-5 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            Apply through
            <input
              type="date"
              value={endDate}
              min={dateKey}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-2 py-1 border border-gray-200 dark:border-gray-700 rounded text-sm bg-white dark:bg-gray-800"
            />
          </label>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="text-sm px-4 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save layout'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
