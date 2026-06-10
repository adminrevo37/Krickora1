// Allocation-coverage visuals (SPEC_COACH_PLANNER_RETIRE_AND_VIEW §6).
//  - CoverageBlockBg: absolute colour-band layer for a vertical calendar block
//    (allocated = coach colour, unallocated = amber hatch). Sits BEHIND content.
//  - AllocationTimeline: vertical, name-listing rows for My Bookings cards;
//    tap an allocated row → edit that slot, tap an amber gap → allocate it.

import { formatTime } from '../lib/booking-data'
import type { Booking } from '../lib/booking-data'
import { coverageSegments, allocationRows } from '../lib/coverage'
import { getContrastText, AMBER_HATCH, AMBER_TEXT, DEFAULT_COACH_COLOR, OWN_BLUE } from '../lib/colour'

// SPEC_COACH_CALENDAR §1B — condense an athlete's full name to "First L." for the
// tight in-cell calendar summary. Merged sibling segments collapse to "First L. +N".
function shortAthleteName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0]}.`
}
function segmentLabel(names: string[]): string {
  if (names.length === 0) return ''
  const first = shortAthleteName(names[0])
  return names.length > 1 ? `${first} +${names.length - 1}` : first
}

export interface SegmentTapTarget {
  startHour: number
  durationMinutes: number
  allocated: boolean
}

// Background colour bands for a vertically-spanning calendar block. Fills its
// (position:relative) parent; render the block's text content above with z-10.
export function CoverageBlockBg({ booking, coachColor, solid }: { booking: Booking; coachColor?: string; solid?: boolean }) {
  const start = booking.startHour
  const total = booking.duration / 60
  const color = coachColor || DEFAULT_COACH_COLOR
  if (total <= 0) return null
  // Admin calendar (solid): the whole block is the coach's colour — allocation
  // gaps are NOT surfaced as amber (admins only need to identify the coach; the
  // athlete names are still listed in the block body).
  if (solid) {
    return <div className="absolute inset-0 rounded-md" style={{ backgroundColor: color }} aria-hidden />
  }
  const segs = coverageSegments(booking)
  return (
    <div className="absolute inset-0 rounded-md overflow-hidden pointer-events-none">
      {segs.map((s, i) => {
        const top = ((s.startHour - start) / total) * 100
        const height = ((s.endHour - s.startHour) / total) * 100
        return (
          <div
            key={i}
            className="absolute inset-x-0"
            style={
              s.allocated
                ? { top: `${top}%`, height: `${height}%`, backgroundColor: color }
                : { top: `${top}%`, height: `${height}%`, background: AMBER_HATCH }
            }
          />
        )
      })}
    </div>
  )
}

// Vertical allocation timeline for a My Bookings coach card. Lists athlete names
// per allocated segment (coach colour) and "＋ Add athlete" amber rows for gaps.
export function AllocationTimeline({
  booking,
  coachColor,
  onSegment,
}: {
  booking: Booking
  coachColor?: string
  onSegment?: (target: SegmentTapTarget) => void
}) {
  // One row per athlete slot (family siblings split into separate rows) + gaps.
  const segs = allocationRows(booking)
  const total = booking.duration / 60
  const color = coachColor || DEFAULT_COACH_COLOR
  const textColor = getContrastText(color)
  if (total <= 0) return null
  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 divide-y divide-white/30">
      {segs.map((s, i) => {
        const durH = s.endHour - s.startHour
        // Row height ∝ duration, with a tappable minimum.
        const height = Math.max(26, Math.round((durH / total) * 96))
        const range = `${formatTime(s.startHour)} – ${formatTime(s.endHour)}`
        const durMin = Math.round(durH * 60)
        const tap: SegmentTapTarget = { startHour: s.startHour, durationMinutes: durMin, allocated: s.allocated }
        if (s.allocated) {
          return (
            <button
              key={i}
              type="button"
              onClick={onSegment ? (e) => { e.stopPropagation(); onSegment(tap) } : undefined}
              style={{ backgroundColor: color, color: textColor, minHeight: height }}
              className="w-full flex items-center justify-between px-2.5 py-1 text-left"
            >
              <span className="text-xs font-semibold truncate">{s.athleteNames.join(' & ')}</span>
              <span className="text-[10px] opacity-80 ml-2 shrink-0">{range}</span>
            </button>
          )
        }
        // SPEC_COACH_SESSION_LENGTH §2.4: a gap shorter than the 30-min floor can't
        // hold a session — render it non-tappable ("N min free"), not "＋ Add athlete".
        if (durMin < 30) {
          return (
            <div
              key={i}
              style={{ background: AMBER_HATCH, color: AMBER_TEXT, minHeight: height }}
              className="w-full flex items-center justify-between px-2.5 py-1 text-left"
            >
              <span className="text-xs font-semibold">{durMin} min</span>
              <span className="text-[10px] opacity-90 ml-2 shrink-0">{range}</span>
            </div>
          )
        }
        return (
          <button
            key={i}
            type="button"
            onClick={onSegment ? (e) => { e.stopPropagation(); onSegment(tap) } : undefined}
            style={{ background: AMBER_HATCH, color: AMBER_TEXT, minHeight: height }}
            className="w-full flex items-center justify-between px-2.5 py-1 text-left"
          >
            <span className="text-xs font-semibold">＋ Add athlete</span>
            <span className="text-[10px] opacity-90 ml-2 shrink-0">{range}</span>
          </button>
        )
      })}
    </div>
  )
}

// SPEC_COACH_CALENDAR §1B — the coach's OWN booking block on THEIR calendar: blue
// allocated bands + amber-hatch gaps, each labelled with a time-proportional
// "First L. · bracket" summary, plus the 🏅 marker. Blocks stay sized by duration
// (the grid's Y axis IS time — no vertical auto-expand); a segment too short to fit
// a name collapses to "+1" (tap-through to My Bookings for full detail). heightPx is
// the block's rendered pixel height so we can decide what text fits each segment.
export function CoachCalendarBlock({ booking, heightPx }: { booking: Booking; heightPx: number }) {
  const segs = coverageSegments(booking)
  const start = booking.startHour
  const total = booking.duration / 60
  if (total <= 0) return null
  return (
    <div className="absolute inset-0 rounded-md overflow-hidden">
      {segs.map((s, i) => {
        const topPct = ((s.startHour - start) / total) * 100
        const heightPct = ((s.endHour - s.startHour) / total) * 100
        const segPx = (heightPct / 100) * heightPx
        const bracket = `${formatTime(s.startHour)}–${formatTime(s.endHour)}`
        const label = s.allocated ? segmentLabel(s.athleteNames) : '＋ add athlete'
        const tiny = segPx < 17 // no room for any text → marker only
        const noBracket = segPx < 30 // room for a name but not the time bracket
        return (
          <div
            key={i}
            className="absolute inset-x-0 flex flex-col justify-center px-1.5 leading-none overflow-hidden"
            style={
              s.allocated
                ? { top: `${topPct}%`, height: `${heightPct}%`, backgroundColor: OWN_BLUE, color: '#fff' }
                : { top: `${topPct}%`, height: `${heightPct}%`, background: AMBER_HATCH, color: AMBER_TEXT }
            }
          >
            {tiny ? (
              s.allocated ? <span className="text-[8px] font-bold">+1</span> : null
            ) : (
              <>
                <span className="text-[9px] font-bold truncate">{label}</span>
                {!noBracket && <span className="text-[7px] opacity-85 mt-0.5">{bracket}</span>}
              </>
            )}
          </div>
        )
      })}
      <span className="absolute top-0.5 right-1 text-[9px] z-10 pointer-events-none">🏅</span>
    </div>
  )
}
