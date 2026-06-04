// Allocation-coverage visuals (SPEC_COACH_PLANNER_RETIRE_AND_VIEW §6).
//  - CoverageBlockBg: absolute colour-band layer for a vertical calendar block
//    (allocated = coach colour, unallocated = amber hatch). Sits BEHIND content.
//  - AllocationTimeline: vertical, name-listing rows for My Bookings cards;
//    tap an allocated row → edit that slot, tap an amber gap → allocate it.

import { formatTime } from '../lib/booking-data'
import type { Booking } from '../lib/booking-data'
import { coverageSegments } from '../lib/coverage'
import { getContrastText, AMBER_HATCH, AMBER_TEXT, DEFAULT_COACH_COLOR } from '../lib/colour'

export interface SegmentTapTarget {
  startHour: number
  durationMinutes: number
  allocated: boolean
}

// Background colour bands for a vertically-spanning calendar block. Fills its
// (position:relative) parent; render the block's text content above with z-10.
export function CoverageBlockBg({ booking, coachColor }: { booking: Booking; coachColor?: string }) {
  const segs = coverageSegments(booking)
  const start = booking.startHour
  const total = booking.duration / 60
  const color = coachColor || DEFAULT_COACH_COLOR
  if (total <= 0) return null
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
  const segs = coverageSegments(booking)
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
