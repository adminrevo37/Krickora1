// Shared lane DISPLAY helpers for the 3 booking calendars (SPEC_RECONFIGURABLE_LANES
// §6, §13). Reads the lane-config store (the parent calendar subscribes via
// useLaneConfigState so these re-render with it). Renders the date-resolved
// column header (icon + name + variant chips + 🕐 "varies" + override badge) and
// the per-segment colour bands.
import {
  getDaySegments,
  getLaneRows,
  resolveSegment,
  laneHeaderName,
  laneIcon,
  variantLabel,
  variantColorKey,
  type Segment,
  VARIANT_STANDARD,
  VARIANT_TRUMAN,
  VARIANT_RUNUP,
} from '../lib/lanes'
import { formatTime } from '../lib/booking-data'

export const CHIP_CLASS: Record<'blue' | 'purple' | 'amber', string> = {
  blue: 'bg-blue-100 text-blue-700',
  purple: 'bg-purple-100 text-purple-700',
  amber: 'bg-amber-100 text-amber-700',
}

// Faint per-segment band tint for empty cells (the green hover overrides it).
export const BAND_CLASS: Record<'blue' | 'purple' | 'amber', string> = {
  blue: 'bg-blue-50/50',
  purple: 'bg-purple-50/60',
  amber: 'bg-amber-50/60',
}

export function bayNumberOf(laneId: string): number {
  return getLaneRows().find((l) => l.laneId === laneId)?.bayNumber ?? 0
}

/** Union of variants offered across the day, in canonical order. */
export function dayVariants(segments: Segment[]): string[] {
  const set = new Set<string>()
  for (const s of segments) for (const v of s.variants) set.add(v)
  return [VARIANT_STANDARD, VARIANT_TRUMAN, VARIANT_RUNUP].filter((v) => set.has(v))
}

/** The colour key that tints a segment's band / its primary variant. */
export function segmentColorKey(seg: Segment): 'blue' | 'purple' | 'amber' {
  if (seg.mode === 'RU') return 'amber'
  if (seg.variants.includes(VARIANT_TRUMAN) && !seg.variants.includes(VARIANT_STANDARD)) return 'purple'
  return 'blue'
}

export function bandClassForSlot(laneId: string, dateKey: string, hour: number): string {
  const { segments } = getDaySegments(laneId, dateKey)
  return BAND_CLASS[segmentColorKey(resolveSegment(segments, hour))]
}

/** Is this hour the start of a segment (for the band-start tag), and is the day multi-segment? */
export function bandStart(laneId: string, dateKey: string, hour: number): { isStart: boolean; multi: boolean; seg: Segment } {
  const { segments } = getDaySegments(laneId, dateKey)
  const seg = resolveSegment(segments, hour)
  return { isStart: Math.abs(seg.startHour - hour) < 0.01, multi: segments.length > 1, seg }
}

/** Small band-start tag content, e.g. "🏏 BM 3 · Truman · from 12pm". */
export function bandTagText(laneId: string, dateKey: string, seg: Segment): string {
  const bay = bayNumberOf(laneId)
  const solo = seg.variants.length === 1
  const variantText =
    seg.mode === 'RU' ? '9m Run Up' : seg.variants.map((v) => variantLabel(v, solo)).join(' / ')
  return `${laneIcon(seg.mode)} ${seg.mode} ${bay} · ${variantText} · from ${formatTime(seg.startHour)}`
}

/**
 * Date-resolved column-header inner content (icon + name + variant chips). The
 * header shows the real "BM/RU {n}" when the mode is constant all day, else the
 * generic "Lane {n} 🕐". Variant chips reflect the whole day's offered variants.
 */
export function LaneHeaderInner({ laneId, dateKey }: { laneId: string; dateKey: string }) {
  const bay = bayNumberOf(laneId)
  const { segments, isOverride } = getDaySegments(laneId, dateKey)
  const modes = new Set(segments.map((s) => s.mode))
  const multiMode = modes.size > 1
  const name = laneHeaderName(bay, segments)
  const multiSegment = segments.length > 1
  const icon = multiMode ? '🕐' : laneIcon([...modes][0])
  const variants = dayVariants(segments)
  const soloStandard = variants.length === 1 && variants[0] === VARIANT_STANDARD
  return (
    <>
      {/* 🕐 marks an intra-day change; show it once (the icon already is 🕐 when the mode flips) */}
      <div className="text-sm leading-none">{icon}{!multiMode && multiSegment ? ' 🕐' : ''}</div>
      <div className="text-[11px] font-semibold text-gray-700 mt-0.5 leading-tight flex items-center justify-center gap-1">
        {name}
        {isOverride && <span title="Custom layout for this date" className="text-amber-500">⚙</span>}
      </div>
      <div className="flex items-center justify-center gap-1 mt-0.5 flex-wrap">
        {variants.map((v) => (
          <span key={v} className={`text-[8px] px-1 py-0.5 rounded-full font-medium ${CHIP_CLASS[variantColorKey(v)]}`}>
            {variantLabel(v, soloStandard)}
          </span>
        ))}
      </div>
    </>
  )
}

/** Colour legend shown above the booking grid. */
export function LaneLegend() {
  return (
    <div className="flex items-center gap-3 text-[11px] flex-wrap">
      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-200" />Standard / Machine</span>
      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-purple-200" />Truman</span>
      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-200" />9m Run Up</span>
      <span className="text-gray-400">🕐 = changes during the day</span>
    </div>
  )
}
