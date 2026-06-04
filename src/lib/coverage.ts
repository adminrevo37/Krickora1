// Allocation-coverage helper (SPEC_COACH_PLANNER_RETIRE_AND_VIEW §6).
// From a coach booking's interval + athleteSlots, produce an ordered, gap-filled
// list of segments: allocated (coach colour) vs unallocated (amber). One pure
// function so the day calendar, admin calendar, and My Bookings all agree.

import type { Booking } from './booking-data'

export interface CoverageSegment {
  startHour: number
  endHour: number
  allocated: boolean
  athleteNames: string[]
}

const EPS = 1e-6

export function coverageSegments(booking: Booking): CoverageSegment[] {
  const start = booking.startHour
  const end = booking.startHour + booking.duration / 60
  if (!(end > start)) return []

  // Clamp each athlete slot to the booking interval (slots shouldn't overrun
  // post keep-what-fits, but clamp defensively).
  const slots = (booking.athleteSlots ?? [])
    .map(s => ({
      s: Math.max(start, s.startHour),
      e: Math.min(end, s.startHour + s.durationMinutes / 60),
      name: s.athleteName,
    }))
    .filter(iv => iv.e - iv.s > EPS)
    .sort((a, b) => a.s - b.s || a.e - b.e)

  // Merge overlapping/adjacent allocated intervals, unioning the athlete names
  // (siblings sharing a slot both show).
  const merged: { s: number; e: number; names: string[] }[] = []
  for (const iv of slots) {
    const last = merged[merged.length - 1]
    if (last && iv.s <= last.e + EPS) {
      last.e = Math.max(last.e, iv.e)
      if (!last.names.includes(iv.name)) last.names.push(iv.name)
    } else {
      merged.push({ s: iv.s, e: iv.e, names: [iv.name] })
    }
  }

  // Walk start→end emitting amber gaps + allocated segments in order.
  const out: CoverageSegment[] = []
  let cursor = start
  for (const m of merged) {
    if (m.s > cursor + EPS) {
      out.push({ startHour: cursor, endHour: m.s, allocated: false, athleteNames: [] })
    }
    out.push({ startHour: Math.max(cursor, m.s), endHour: m.e, allocated: true, athleteNames: m.names })
    cursor = m.e
  }
  if (cursor < end - EPS) {
    out.push({ startHour: cursor, endHour: end, allocated: false, athleteNames: [] })
  }
  if (out.length === 0) out.push({ startHour: start, endHour: end, allocated: false, athleteNames: [] })
  return out
}

export type CoverageState = 'full' | 'partial' | 'empty'

// Three-state summary for the My Bookings badge.
export function coverageSummary(booking: Booking): { state: CoverageState; unallocatedHours: number } {
  const segs = coverageSegments(booking)
  const total = booking.duration / 60
  const allocated = segs.filter(s => s.allocated).reduce((a, s) => a + (s.endHour - s.startHour), 0)
  const unalloc = Math.max(0, total - allocated)
  if (allocated <= EPS) return { state: 'empty', unallocatedHours: unalloc }
  if (unalloc <= EPS) return { state: 'full', unallocatedHours: 0 }
  return { state: 'partial', unallocatedHours: unalloc }
}

// SPEC_SCHEDULE_DAY_VIEW §3: the single status dot under a date in the week strip.
//  - Customers (non-coach): green if the day has any booking (own OR shared), else null.
//  - Coaches (worst state over that day's OWN coach bookings):
//      red   — coach booking(s) exist but NONE has any allocation at all.
//      amber — some allocation exists AND at least one booking has a contiguous
//              unallocated gap > 15 min (≥30 min at 15-min granularity).
//      green — booked and adequately allocated (only ≤15-min gaps).
// A day with only non-coach bookings (rare for a coach) shows green.
// Threshold: a single 15-min gap never warns; coverageSegments already keeps
// allocation-separated 15-min gaps distinct (only a merged ≥30 stretch warns).
const GAP_WARN_HOURS = 0.25 // > 15 min warns

export function dayDotState(
  dayBookings: Booking[],
  isCoach: boolean,
): 'green' | 'amber' | 'red' | null {
  if (dayBookings.length === 0) return null
  if (!isCoach) return 'green'
  const coachBookings = dayBookings.filter(b => b.isCoachBooking)
  if (coachBookings.length === 0) return 'green'
  const anyAllocated = coachBookings.some(b => coverageSummary(b).state !== 'empty')
  if (!anyAllocated) return 'red'
  const hasBigGap = coachBookings.some(b =>
    coverageSegments(b).some(s => !s.allocated && s.endHour - s.startHour > GAP_WARN_HOURS + EPS),
  )
  return hasBigGap ? 'amber' : 'green'
}
