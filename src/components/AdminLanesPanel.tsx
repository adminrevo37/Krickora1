// Admin "Lanes" page — edits the DEFAULT lane layout (SPEC_RECONFIGURABLE_LANES
// §6). One card per physical lane (bm1..ru2, fixed global bay number); each holds
// an ordered segment list edited via LaneSegmentEditor. Per-date demand changes
// are done in the booking calendar's "Edit layout for this date" modal instead.
import { useEffect, useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useSettings } from '../hooks/useSettings'
import { getErrorMessage } from '../lib/errors'
import LaneSegmentEditor from './LaneSegmentEditor'
import { type LaneRow, type Segment, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } from '../lib/lanes'

export default function AdminLanesPanel() {
  const lanes = useQuery(api.lanes.listLanes, {}) as LaneRow[] | undefined
  const updateLane = useMutation(api.lanes.updateLaneDefault)
  const { settings } = useSettings()

  const openHour = settings.openingHour ?? DEFAULT_OPEN_HOUR
  const closeHour = settings.closingHour ?? DEFAULT_CLOSE_HOUR

  // Local editable copy of each lane's segments, keyed by laneId.
  const [draft, setDraft] = useState<Record<string, Segment[]>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!lanes) return
    setDraft((prev) => {
      const next = { ...prev }
      for (const l of lanes) if (!next[l.laneId]) next[l.laneId] = l.segments
      return next
    })
  }, [lanes])

  if (lanes === undefined) return <div className="text-sm text-gray-500">Loading lanes…</div>

  const ordered = [...lanes].sort((a, b) => a.order - b.order)

  const save = async (laneId: string) => {
    setError(null)
    setSaving(laneId)
    try {
      await updateLane({ laneId, segments: draft[laneId] as any })
      setSaved(laneId)
      setTimeout(() => setSaved((s) => (s === laneId ? null : s)), 2500)
    } catch (e) {
      setError(getErrorMessage(e) ?? 'Could not save lane.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-800">Default lane layout</h2>
        <p className="text-xs text-gray-500 mt-1">
          The permanent setup for each of the 5 bays. Each bay is a Bowling Machine (🏏) or a Run Up
          (🏃‍♂️); machines offer Standard and/or Truman. Use “＋ Split” to change the setup partway
          through the day. For one-off demand changes on a specific date, use “Edit layout for this
          date” in the Bookings calendar instead.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {ordered.map((lane) => (
        <div key={lane.laneId} className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800">
              Bay {lane.bayNumber}{' '}
              <span className="text-xs font-normal text-gray-400">({lane.laneId})</span>
            </h3>
            <div className="flex items-center gap-2">
              {saved === lane.laneId && <span className="text-xs text-green-600">Saved ✓</span>}
              <button
                type="button"
                onClick={() => save(lane.laneId)}
                disabled={saving === lane.laneId}
                className="text-sm px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {saving === lane.laneId ? 'Saving…' : 'Save'}
              </button>
            </div>
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
  )
}
