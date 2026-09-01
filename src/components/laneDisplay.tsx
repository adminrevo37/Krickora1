// Shared lane DISPLAY helpers for the 3 booking calendars (SPEC_RECONFIGURABLE_LANES
// §6, §13). Reads the lane-config store (the parent calendar subscribes via
// useLaneConfigState so these re-render with it). Renders the date-resolved
// column header (icon + name + variant chips + 🕐 "varies" + override badge) and
// the per-segment colour bands.
import {
  getDaySegments,
  getLaneRows,
  resolveSegment,
  segmentIsClosed,
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

export const CHIP_CLASS: Record<'blue' | 'purple' | 'amber' | 'gray', string> = {
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200',
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-500/25 dark:text-purple-200',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/25 dark:text-amber-200',
  gray: 'bg-gray-200 text-gray-600 dark:bg-gray-600/40 dark:text-gray-300',
}

// Faint per-segment band tint for empty cells (the green hover overrides it).
//
// ⚠️ 2026-09-01: these had NO dark: variants, which made the whole
// segment-colour mechanism useless in dark mode — the one signal that tells a
// customer "this part of the day is a bowling machine". Measured on prod: the
// page background is oklch(0.2046) while `bg-blue-50/50` composited to
// oklab(0.97 …) at 50% alpha and `bg-amber-50/60` to oklab(0.987 …) at 60% —
// near-white washes whose chroma (~0.01-0.02) is far too low to read as a hue
// over dark. BM and RU came out the SAME mid-grey. The dark variants below use
// a saturated hue at low alpha instead, which tints rather than washes.
export const BAND_CLASS: Record<'blue' | 'purple' | 'amber', string> = {
  blue: 'bg-blue-50/50 dark:bg-blue-500/20',
  purple: 'bg-purple-50/60 dark:bg-purple-500/20',
  amber: 'bg-amber-50/60 dark:bg-amber-500/20',
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

/**
 * Is this hour the start of a segment (for the band tag), and is the day
 * multi-segment?
 *
 * 2026-09-01: also returns `showTag`, which REPEATS the tag every 2h inside a
 * segment. It used to render only on the segment's very first row, so on a
 * converted lane the single "this is a bowling machine now" cue scrolled out of
 * view and every remaining cell was an unlabelled band.
 */
export function bandStart(
  laneId: string,
  dateKey: string,
  hour: number
): { isStart: boolean; isRepeat: boolean; showTag: boolean; multi: boolean; seg: Segment } {
  const { segments } = getDaySegments(laneId, dateKey)
  const seg = resolveSegment(segments, hour)
  const isStart = Math.abs(seg.startHour - hour) < 0.01
  const multi = segments.length > 1
  const offset = hour - seg.startHour
  const isRepeat = !isStart && offset > 0 && Math.abs(offset % 2) < 0.01
  return { isStart, isRepeat, showTag: multi && (isStart || isRepeat), multi, seg }
}

/**
 * Small band tag, e.g. "🏏 BM 3 · Truman · from 12pm". `short` drops the "from"
 * clause for the mid-segment repeats (the start time is already stated above).
 */
export function bandTagText(laneId: string, dateKey: string, seg: Segment, short = false): string {
  const bay = bayNumberOf(laneId)
  const solo = seg.variants.length === 1
  const variantText =
    seg.mode === 'RU' ? '9m Run Up' : seg.variants.map((v) => variantLabel(v, solo)).join(' / ')
  const base = `${laneIcon(seg.mode)} ${seg.mode} ${bay} · ${variantText}`
  return short ? base : `${base} · from ${formatTime(seg.startHour)}`
}

/**
 * One chip per SEGMENT for the column header — label + the hours it applies to.
 * Replaces the old whole-day variant union, which was at its most useless on
 * exactly the day it mattered: a lane running RU in the morning and BM from
 * 11:30am rendered as "Lane 4 · Std · 9m Run Up" with no times, so the standout
 * word on a lane that is a bowling machine for most of the day was "Run Up".
 */
export function segmentChips(
  segments: Segment[]
): Array<{ key: string; label: string; time: string; color: 'blue' | 'purple' | 'amber' | 'gray' }> {
  return segments.map((seg, i) => {
    const closed = segmentIsClosed(seg)
    const solo = seg.variants.length === 1
    const label = closed
      ? '🔒 Closed'
      : seg.mode === 'RU'
        ? `${laneIcon('RU')} 9m Run Up`
        : `${laneIcon('BM')} ${seg.variants.map((v) => variantLabel(v, solo)).join(' / ')}`
    return {
      key: `${i}-${seg.startHour}`,
      label,
      time: `${formatTime(seg.startHour)}–${formatTime(seg.endHour)}`,
      color: closed ? 'gray' : segmentColorKey(seg),
    }
  })
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
      <div className="text-[11px] font-semibold text-gray-700 dark:text-gray-200 mt-0.5 leading-tight flex items-center justify-center gap-1">
        {name}
        {isOverride && <span title="Custom layout for this date" className="text-amber-500">⚙</span>}
      </div>
      {multiSegment ? (
        // Segmented day: one chip PER SEGMENT with the hours it covers, so the
        // header says what the lane is AND when — instead of a variant union
        // that reads as a run-up lane on a day it's mostly a machine.
        <div className="flex flex-col items-stretch gap-0.5 mt-0.5">
          {segmentChips(segments).map((c) => (
            <span
              key={c.key}
              className={`text-[8px] px-1 py-0.5 rounded font-medium leading-tight ${CHIP_CLASS[c.color]}`}
            >
              <span className="block truncate">{c.label}</span>
              <span className="block opacity-80 tabular-nums">{c.time}</span>
            </span>
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-center gap-1 mt-0.5 flex-wrap">
          {variants.map((v) => (
            <span key={v} className={`text-[8px] px-1 py-0.5 rounded-full font-medium ${CHIP_CLASS[variantColorKey(v)]}`}>
              {variantLabel(v, soloStandard)}
            </span>
          ))}
        </div>
      )}
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
      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gray-200 border border-gray-400" />🔒 Closed</span>
      <span className="text-gray-400 dark:text-gray-500">🕐 = changes during the day</span>
    </div>
  )
}
