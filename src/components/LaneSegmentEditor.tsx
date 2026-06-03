// LaneSegmentEditor — edits ONE lane's day config as an ordered list of time
// SEGMENTS (SPEC_RECONFIGURABLE_LANES). Internally the day is modelled as
// boundaries [open, ...splitPoints, close] so segments always tile the day with
// no gaps/overlaps; the parent receives a clean Segment[]. Used by the admin
// Lanes page (default layout) and the per-date override modal.
import {
  type Segment,
  type LaneMode,
  laneIcon,
  laneName,
  variantLabel,
  variantColorKey,
  VARIANT_STANDARD,
  VARIANT_TRUMAN,
  VARIANT_RUNUP,
} from '../lib/lanes'
import { formatTime } from '../lib/booking-data'

const CHIP_CLASS: Record<'blue' | 'purple' | 'amber', string> = {
  blue: 'bg-blue-100 text-blue-700 border-blue-200',
  purple: 'bg-purple-100 text-purple-700 border-purple-200',
  amber: 'bg-amber-100 text-amber-700 border-amber-200',
}

function VariantChips({ mode, variants }: { mode: LaneMode; variants: string[] }) {
  const solo = variants.length === 1
  const list = mode === 'RU' ? [VARIANT_RUNUP] : variants
  return (
    <span className="inline-flex flex-wrap gap-1">
      {list.map((v) => (
        <span
          key={v}
          className={`px-1.5 py-0.5 text-[11px] rounded border ${CHIP_CLASS[variantColorKey(v)]}`}
        >
          {variantLabel(v, solo && mode === 'BM')}
        </span>
      ))}
    </span>
  )
}

export default function LaneSegmentEditor({
  bayNumber,
  segments,
  onChange,
  openHour,
  closeHour,
}: {
  bayNumber: number
  segments: Segment[]
  onChange: (segments: Segment[]) => void
  openHour: number
  closeHour: number
}) {
  const segs = segments.length
    ? segments
    : [{ startHour: openHour, endHour: closeHour, mode: 'BM' as LaneMode, variants: [VARIANT_STANDARD] }]

  const setSegs = (next: Segment[]) => onChange(next)

  const updateSeg = (i: number, patch: Partial<Segment>) => {
    const next = segs.map((s, idx) => (idx === i ? { ...s, ...patch } : s))
    setSegs(next)
  }

  const setMode = (i: number, mode: LaneMode) => {
    // Flipping mode resets variants to the new mode's default.
    updateSeg(i, { mode, variants: mode === 'RU' ? [VARIANT_RUNUP] : [VARIANT_STANDARD] })
  }

  const toggleVariant = (i: number, variant: string) => {
    const s = segs[i]
    if (s.mode !== 'BM') return
    const has = s.variants.includes(variant)
    let variants = has ? s.variants.filter((v) => v !== variant) : [...s.variants, variant]
    if (variants.length === 0) variants = [variant] // keep ≥1
    // canonical order: standard, truman
    variants = [VARIANT_STANDARD, VARIANT_TRUMAN].filter((v) => variants.includes(v))
    updateSeg(i, { variants })
  }

  const splitAt = (i: number) => {
    // Split segment i at its midpoint (whole hour).
    const s = segs[i]
    const mid = Math.floor((s.startHour + s.endHour) / 2)
    if (mid <= s.startHour || mid >= s.endHour) return
    const next = [
      ...segs.slice(0, i),
      { ...s, endHour: mid },
      { ...s, startHour: mid },
      ...segs.slice(i + 1),
    ]
    setSegs(next)
  }

  const removeSeg = (i: number) => {
    if (segs.length <= 1) return
    // Merge segment i into its neighbour: extend the previous (or next) to fill the gap.
    const next = segs.filter((_, idx) => idx !== i)
    if (i > 0) next[i - 1] = { ...next[i - 1], endHour: segs[i].endHour }
    else next[0] = { ...next[0], startHour: segs[i].startHour }
    setSegs(next)
  }

  // Editable boundary between seg i and seg i+1 (must stay strictly between neighbours).
  const setBoundary = (i: number, hour: number) => {
    const lo = segs[i].startHour + 1
    const hi = segs[i + 1].endHour - 1
    const h = Math.max(lo, Math.min(hi, hour))
    const next = segs.map((s, idx) => {
      if (idx === i) return { ...s, endHour: h }
      if (idx === i + 1) return { ...s, startHour: h }
      return s
    })
    setSegs(next)
  }

  const hourOptions: number[] = []
  for (let h = openHour; h <= closeHour; h++) hourOptions.push(h)

  return (
    <div className="space-y-2">
      {segs.map((s, i) => (
        <div key={i} className="rounded-lg border border-gray-200 p-3 bg-gray-50/50">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-800">
              <span className="text-lg">{laneIcon(s.mode)}</span>
              <span>{laneName(s.mode, bayNumber)}</span>
              <VariantChips mode={s.mode} variants={s.variants} />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => splitAt(i)}
                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                disabled={s.endHour - s.startHour < 2}
                title="Split this time range in two"
              >
                ＋ Split
              </button>
              {segs.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeSeg(i)}
                  className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="text-gray-600">
              {formatTime(s.startHour)} – {formatTime(s.endHour)}
            </span>
            <label className="flex items-center gap-1">
              <span className="text-xs text-gray-500">Mode</span>
              <select
                value={s.mode}
                onChange={(e) => setMode(i, e.target.value as LaneMode)}
                className="px-2 py-1 border border-gray-200 rounded text-sm"
              >
                <option value="BM">Bowling Machine</option>
                <option value="RU">Run Up</option>
              </select>
            </label>
            {s.mode === 'BM' ? (
              <span className="flex items-center gap-3">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={s.variants.includes(VARIANT_STANDARD)}
                    onChange={() => toggleVariant(i, VARIANT_STANDARD)}
                  />
                  <span className="text-xs text-gray-700">Standard</span>
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={s.variants.includes(VARIANT_TRUMAN)}
                    onChange={() => toggleVariant(i, VARIANT_TRUMAN)}
                  />
                  <span className="text-xs text-gray-700">Truman</span>
                </label>
              </span>
            ) : (
              <span className="text-xs text-gray-500">9m Run Up</span>
            )}
          </div>

          {/* Boundary control between this segment and the next */}
          {i < segs.length - 1 && (
            <div className="mt-2 pt-2 border-t border-dashed border-gray-200 flex items-center gap-2 text-xs text-gray-500">
              <span>Switch at</span>
              <select
                value={s.endHour}
                onChange={(e) => setBoundary(i, Number(e.target.value))}
                className="px-2 py-0.5 border border-gray-200 rounded"
              >
                {hourOptions
                  .filter((h) => h > s.startHour && h < segs[i + 1].endHour)
                  .map((h) => (
                    <option key={h} value={h}>
                      {formatTime(h)}
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
