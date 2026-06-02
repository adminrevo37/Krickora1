// Lane definitions
export interface LaneVariant {
  id: string
  name: string
  pricePerHour: number
  price90Min: number
  description: string
}

export interface Lane {
  id: string
  name: string
  shortName: string
  type: 'bowling-machine' | 'run-up'
  icon: string
  variants?: LaneVariant[]
}

export const LANES: Lane[] = [
  { id: 'bm1', name: 'Bowling Machine 1', shortName: 'BM 1', type: 'bowling-machine', icon: '🎯' },
  { id: 'bm2', name: 'Bowling Machine 2', shortName: 'BM 2', type: 'bowling-machine', icon: '🎯' },
  {
    id: 'bm3',
    name: 'Bowling Machine 3',
    shortName: 'BM 3',
    type: 'bowling-machine',
    icon: '🎯',
    variants: [
      { id: 'bm3-standard', name: 'Standard', pricePerHour: 40, price90Min: 55, description: 'Standard bowling machine' },
      { id: 'bm3-truman', name: 'Truman', pricePerHour: 50, price90Min: 70, description: 'Premium Truman bowling machine' },
    ],
  },
  { id: 'ru1', name: '9m Run Up 1', shortName: 'RU 1', type: 'run-up', icon: '🏏' },
  { id: 'ru2', name: '9m Run Up 2', shortName: 'RU 2', type: 'run-up', icon: '🏏' },
]

// Coach pricing (1-hour minimum; per-hour rate only)
// Rate is sourced from admin panel settings (siteSettings.coachPerHour)
import { getSettingsStore, getHoursForDate, DAY_KEYS } from './settings-store'
import { PRICE_DEFAULTS } from './priceDefaults'

export const COACH_PRICING = {
  get perHour(): number {
    try { return getSettingsStore().get().coachPerHour ?? PRICE_DEFAULTS.coachPerHour } catch { return PRICE_DEFAULTS.coachPerHour }
  },
} as const

export function getCoachPerHourRate(): number {
  return COACH_PRICING.perHour
}

export function getCoachPrice(durationMinutes: number): number {
  const hours = durationMinutes / 60
  return Math.round(hours * COACH_PRICING.perHour * 100) / 100
}

export function getCustomerPrice(lane: Lane, variantId: string | null, durationMinutes: number): number {
  const hours = durationMinutes / 60
  let perHour = 40
  try {
    const s = getSettingsStore().get()
    perHour = s.customerPricePerHour ?? PRICE_DEFAULTS.customerPerHour
    // Truman variant uses Truman hourly rate from settings
    if (lane.variants && variantId) {
      const variant = lane.variants.find(v => v.id === variantId)
      if (variant && /truman/i.test(variant.name)) {
        perHour = s.trumanPricePerHour ?? perHour
      }
    }
  } catch {}
  return Math.round(perHour * hours * 100) / 100
}

/**
 * Credit (whole cents) to preview when a customer SHORTENS/downgrades a booking.
 * MIRROR of convex/lib/pricing.ts decreaseCreditCents — keep in sync. Credits only
 * what was actually PAID (post-discount price), pro-rata to the gross value removed,
 * so the ModifyBookingModal preview matches the server charge exactly.
 */
export function decreaseCreditCents(
  paidValueCents: number,
  oldGrossCents: number,
  newGrossCents: number
): number {
  if (!(paidValueCents > 0) || oldGrossCents <= 0) return 0
  const removedCents = Math.max(0, oldGrossCents - newGrossCents)
  if (removedCents <= 0) return 0
  const fraction = Math.min(1, removedCents / oldGrossCents)
  return Math.min(paidValueCents, Math.round(paidValueCents * fraction))
}

export function getLanePrice(lane: Lane, variantId: string | null, durationMinutes: number): number {
  return getCustomerPrice(lane, variantId, durationMinutes)
}

// Opening hours
export const OPENING_HOUR = 7
export const CLOSING_HOUR = 21
export const TIMEZONE = 'Australia/Perth'

export function getAWSTNow(): Date {
  const now = new Date()
  const awstStr = now.toLocaleString('en-US', { timeZone: TIMEZONE })
  return new Date(awstStr)
}

export interface TimeSlot {
  hour: number
  label: string
}

export function generateTimeSlots(): TimeSlot[] {
  // Derive the bounds from settings (single source of truth) so custom per-day
  // hours outside 7–21 still render. Spans the widest open/close across the week.
  let open = OPENING_HOUR
  let close = CLOSING_HOUR
  try {
    const dh = getSettingsStore().get().dailyHours
    const opens = DAY_KEYS.map((d) => dh[d]).filter((h) => h && !h.closed).map((h) => h.open)
    const closes = DAY_KEYS.map((d) => dh[d]).filter((h) => h && !h.closed).map((h) => h.close)
    if (opens.length) open = Math.min(...opens)
    if (closes.length) close = Math.max(...closes)
  } catch {}
  const slots: TimeSlot[] = []
  for (let h = open; h < close; h += 0.5) {
    slots.push({ hour: h, label: formatTime(h) })
  }
  return slots
}

// Athlete slot for coach tracking
export interface AthleteSlot {
  // athleteId = source of truth (athletes table id). Optional for legacy slots
  // created before the parent/athlete model (SPEC_PARENT_ATHLETE_MODEL).
  athleteId?: string
  athleteName: string
  startHour: number
  durationMinutes: number
  accessCode?: string
  codeGeneratedAt?: string
}

// Booking type
export interface Booking {
  id: string
  laneId: string
  variantId?: string | null
  date: string
  startHour: number
  duration: number
  customerName: string
  customerEmail: string
  customerPhone?: string
  userId?: string
  status: 'confirmed' | 'pending' | 'pending_payment' | 'cancelled' | 'tentative'
  paymentStatus?: 'paid' | 'pending' | 'failed'
  priceInCents?: number
  stripeSessionId?: string
  isCoachBooking?: boolean
  coachPrice?: number
  additionalLaneIds?: string[]
  athleteSlots?: AthleteSlot[]
  creditApplied?: number
  cancelledAt?: string
  cancelledByUserId?: string
  // Coach cancellation refill tracking
  refilledMinutes?: number
  originalCoachId?: string
  // Tentative booking reference
  tentativeSourceId?: string
  tentativeForDate?: string
  // Door access code for facility entry
  accessCode?: string
  // Discount code applied to this booking
  discountCode?: string
  // Admin notes (e.g. "Winter Program", "Trial Session")
  notes?: string
  // Audit trail of admin modifications
  modificationHistory?: Array<{
    modifiedAt: string
    modifiedByUserId?: string
    modifiedByName?: string
    changes: Array<{ field: string; oldValue?: string; newValue?: string }>
  }>
}

/**
 * Round a coach booking duration UP to the nearest 30-minute increment.
 */
export function roundCoachBookingDuration(startHour: number, athleteSlots: AthleteSlot[]): number {
  if (athleteSlots.length === 0) return 0
  let latestEnd = startHour
  for (const slot of athleteSlots) {
    const slotEnd = slot.startHour + slot.durationMinutes / 60
    if (slotEnd > latestEnd) latestEnd = slotEnd
  }
  const rawDurationMinutes = (latestEnd - startHour) * 60
  const rounded = Math.ceil(rawDurationMinutes / 30) * 30
  return Math.max(60, rounded)
}

export function getMinCoachDurationFromAthletes(startHour: number, athleteSlots: AthleteSlot[]): number {
  if (athleteSlots.length === 0) return 60
  return Math.max(60, roundCoachBookingDuration(startHour, athleteSlots))
}

// Helper: does this booking occupy the given lane (primary OR additional)?
export function bookingOccupiesLane(b: Booking, laneId: string): boolean {
  if (b.laneId === laneId) return true
  if (b.additionalLaneIds && b.additionalLaneIds.includes(laneId)) return true
  return false
}

// Smart slot visibility
export function getActiveHalfHoursForLane(
  bookings: Booking[],
  laneId: string,
  dateKey: string,
): Set<number> {
  const activeHalfHours = new Set<number>()
  const dayClose = getHoursForDate(getSettingsStore().get(), dateKey).close
  const laneBookings = bookings.filter(
    b => bookingOccupiesLane(b, laneId) && b.date === dateKey && b.status !== 'cancelled'
  )
  for (const b of laneBookings) {
    const endHour = b.startHour + b.duration / 60
    if (b.startHour !== Math.floor(b.startHour)) activeHalfHours.add(b.startHour)
    if (endHour !== Math.floor(endHour) && endHour < dayClose) activeHalfHours.add(endHour)
  }
  return activeHalfHours
}

export function isSlotVisibleForLane(hour: number, activeHalfHours: Set<number>): boolean {
  if (hour === Math.floor(hour)) return true
  return activeHalfHours.has(hour)
}

// Gap management
function getNextBookingStart(bookings: Booking[], laneId: string, dateKey: string, afterHour: number): number {
  const laneBookings = bookings.filter(b => bookingOccupiesLane(b, laneId) && b.date === dateKey && b.status !== 'cancelled')
  const dayClose = getHoursForDate(getSettingsStore().get(), dateKey).close
  let nextStart = dayClose
  for (const b of laneBookings) {
    if (b.startHour > afterHour && b.startHour < nextStart) nextStart = b.startHour
  }
  return nextStart
}

function wouldCreateDeadGap(startHour: number, durationMinutes: number, nextBookingStart: number): boolean {
  const endHour = startHour + durationMinutes / 60
  const gapMinutes = Math.round((nextBookingStart - endHour) * 60)
  return gapMinutes > 0 && gapMinutes < 60
}

/**
 * Check if a booking is "last minute" — same day and starting within 3 hours.
 * Last-minute bookings bypass dead gap prevention to maximize lane utilization.
 */
export function isLastMinuteBooking(dateKey: string, startHour: number): boolean {
  const now = getAWSTNow()
  const todayKey = formatDateKey(now)
  if (dateKey !== todayKey) return false
  const currentHour = now.getHours() + now.getMinutes() / 60
  return (startHour - currentHour) <= 3
}

/**
 * Check if there are no other viable start times on this lane for this day
 * that would avoid the dead gap. If this is the only option, allow it.
 */
function hasNoOtherViableOptions(bookings: Booking[], laneId: string, dateKey: string, startHour: number, durationMinutes: number): boolean {
  const laneBookings = bookings.filter(b => bookingOccupiesLane(b, laneId) && b.date === dateKey && b.status !== 'cancelled')
  const activeHalfHours = getActiveHalfHoursForLane(bookings, laneId, dateKey)
  const { open: dayOpen, close: dayClose } = getHoursForDate(getSettingsStore().get(), dateKey)

  // Count how many other start times could fit this duration without a dead gap
  let viableAlternatives = 0
  for (let h = dayOpen; h < dayClose; h += 0.5) {
    if (h === startHour) continue // skip the slot we're evaluating
    const isOccupied = laneBookings.some(b => {
      const bEnd = b.startHour + b.duration / 60
      return h >= b.startHour && h < bEnd
    })
    if (isOccupied) continue
    const isHalfHour = h !== Math.floor(h)
    if (isHalfHour && !activeHalfHours.has(h)) continue
    const nextStart = getNextBookingStart(bookings, laneId, dateKey, h)
    const availMins = Math.min(Math.round((nextStart - h) * 60), Math.round((dayClose - h) * 60))
    if (availMins < durationMinutes) continue
    if (!wouldCreateDeadGap(h, durationMinutes, nextStart)) {
      viableAlternatives++
    }
  }
  return viableAlternatives === 0
}

/**
 * Check if ALL lanes on this date have no viable options for the given duration.
 * Used to determine if gap prevention should be relaxed across the facility.
 */
function noViableOptionsOnAnyLane(bookings: Booking[], dateKey: string, durationMinutes: number): boolean {
  const { open: dayOpen, close: dayClose } = getHoursForDate(getSettingsStore().get(), dateKey)
  for (const lane of LANES) {
    const laneBookings = bookings.filter(b => bookingOccupiesLane(b, lane.id) && b.date === dateKey && b.status !== 'cancelled')
    const activeHalfHours = getActiveHalfHoursForLane(bookings, lane.id, dateKey)
    for (let h = dayOpen; h < dayClose; h += 0.5) {
      const isOccupied = laneBookings.some(b => {
        const bEnd = b.startHour + b.duration / 60
        return h >= b.startHour && h < bEnd
      })
      if (isOccupied) continue
      const isHalfHour = h !== Math.floor(h)
      if (isHalfHour && !activeHalfHours.has(h)) continue
      const nextStart = getNextBookingStart(bookings, lane.id, dateKey, h)
      const availMins = Math.min(Math.round((nextStart - h) * 60), Math.round((dayClose - h) * 60))
      if (availMins < durationMinutes) continue
      if (!wouldCreateDeadGap(h, durationMinutes, nextStart)) {
        return false // found at least one viable option somewhere
      }
    }
  }
  return true
}

// Customer durations
export function getCustomerDurations(bookings: Booking[], laneId: string, dateKey: string, startHour: number): number[] {
  const maxMins = getMaxDuration(bookings, laneId, dateKey, startHour, false)
  const nextStart = getNextBookingStart(bookings, laneId, dateKey, startHour)
  const lastMinute = isLastMinuteBooking(dateKey, startHour)
  const durations: number[] = []

  // Build candidate durations in 1-hour increments (60, 120, 180 ... up to customerMaxDurationMinutes)
  const customerMax = getSettingsStore().get().customerMaxDurationMinutes ?? 180
  const candidates: number[] = []
  for (let d = 60; d <= customerMax; d += 60) candidates.push(d)

  for (const d of candidates) {
    if (d > maxMins) continue
    const createsGap = wouldCreateDeadGap(startHour, d, nextStart)
    if (!createsGap) {
      // No gap issue — always allow
      durations.push(d)
    } else if (lastMinute) {
      // Last-minute booking — bypass gap prevention for maximum utilization
      durations.push(d)
    } else if (hasNoOtherViableOptions(bookings, laneId, dateKey, startHour, d)) {
      // This is the only viable option on this lane — allow it
      durations.push(d)
    } else if (noViableOptionsOnAnyLane(bookings, dateKey, d)) {
      // No viable gap-free options on ANY lane for this duration — allow it
      durations.push(d)
    }
  }

  // Final fallback: if nothing passed but there's physical space, allow 60 min
  if (durations.length === 0 && maxMins >= 60) durations.push(60)
  return durations
}

// Coach durations
export function getCoachDurations(bookings: Booking[], laneId: string, dateKey: string, startHour: number): number[] {
  const maxMins = getMaxDuration(bookings, laneId, dateKey, startHour, true)
  const coachMax = getSettingsStore().get().coachMaxDurationMinutes ?? 600
  const durations: number[] = []
  for (let m = 60; m <= Math.min(maxMins, coachMax); m += 30) durations.push(m)
  return durations
}

// Customer start times
export function getAvailableStartTimes(bookings: Booking[], laneId: string, dateKey: string): number[] {
  const times: number[] = []
  const laneBookings = bookings.filter(b => bookingOccupiesLane(b, laneId) && b.date === dateKey && b.status !== 'cancelled')
  const activeHalfHours = getActiveHalfHoursForLane(bookings, laneId, dateKey)
  const { open, close } = getHoursForDate(getSettingsStore().get(), dateKey)

  for (let h = open; h < close; h += 0.5) {
    const isOccupied = laneBookings.some(b => {
      const bEnd = b.startHour + b.duration / 60
      return h >= b.startHour && h < bEnd
    })
    if (isOccupied) continue
    const isHalfHour = h !== Math.floor(h)
    if (isHalfHour && !activeHalfHours.has(h)) continue
    const nextStart = getNextBookingStart(bookings, laneId, dateKey, h)
    const availableMinutes = Math.round((nextStart - h) * 60)
    const toClose = Math.round((close - h) * 60)
    const effectiveAvail = Math.min(availableMinutes, toClose)

    // Standard rule: need at least 60 min of space
    if (effectiveAvail >= 60) {
      times.push(h)
    } else if (effectiveAvail >= 30 && isLastMinuteBooking(dateKey, h)) {
      // Last-minute exception: if booking is same-day within 3 hours,
      // show slots with less than 60 min if they can still fit a valid duration.
      // The getCustomerDurations function will handle what durations are offered.
      // This prevents hiding slots that could still be used last-minute.
      // Only show if there's at least 30 min (minimum useful session)
      times.push(h)
    }
  }
  return times
}

// Coach start times — weekdays: 3:30pm only; weekends: on the hour
export function getValidCoachStartTimes(date: Date): number[] {
  if (!isWeekday(date)) {
    // Saturday & Sunday: every whole hour within per-day opening hours
    const { open, close } = getHoursForDate(getSettingsStore().get(), date)
    const times: number[] = []
    for (let h = open; h < close; h++) times.push(h)
    return times
  }
  // Monday–Friday: 3:30pm only
  return [15.5]
}

// Max duration
export function getMaxDuration(bookings: Booking[], laneId: string, dateKey: string, startHour: number, isCoach: boolean): number {
  const s = getSettingsStore().get()
  const dayClose = getHoursForDate(s, dateKey).close
  const laneBookings = bookings.filter(b => bookingOccupiesLane(b, laneId) && b.date === dateKey && b.status !== 'cancelled')
  let maxEnd = dayClose
  for (const b of laneBookings) {
    if (b.startHour > startHour && b.startHour < maxEnd) maxEnd = b.startHour
  }
  const maxMinutes = Math.round((maxEnd - startHour) * 60)
  const absoluteMax = isCoach ? (s.coachMaxDurationMinutes ?? 600) : (s.customerMaxDurationMinutes ?? 180)
  return Math.min(maxMinutes, absoluteMax)
}

// ============================================================
// ROLLING 7-DAY WINDOW FOR COACHES
// ============================================================

export function getCoachRolling7Days(windowDays: number = 8): Date[] {
  const today = getAWSTNow()
  today.setHours(0, 0, 0, 0)
  const days: Date[] = []
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() + i)
    days.push(d)
  }
  return days
}

export function isWithinCoachWindow(date: Date, windowDays: number = 8): boolean {
  const today = getAWSTNow()
  today.setHours(0, 0, 0, 0)
  const target = new Date(date)
  target.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  return diffDays >= 0 && diffDays < windowDays
}

export function getNextWeekDate(date: Date): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + 7)
  return next
}

// Day name to JS getDay() index
const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
}

/**
 * Check if a date is within the user's access window.
 * Uses admin-configurable settings for L1, L2, and customer open times.
 */
export function canAccessCalendar(
  role: 'coach' | 'customer' | 'admin',
  coachTier?: 'L1' | 'L2' | null,
  settings?: { l1CoachOpenDay?: string; l1CoachOpenHour?: number; l2CoachOpenDay?: string; l2CoachOpenHour?: number; customerOpenDay?: string; customerOpenHour?: number }
): boolean {
  if (role === 'admin') return true

  const now = getAWSTNow()
  const dayOfWeek = now.getDay() // 0=Sunday
  const hour = now.getHours()
  const minute = now.getMinutes()
  const currentTimeDecimal = hour + minute / 60

  // L1 Coaches — rolling 8-day window, always open by default
  if (role === 'coach' && coachTier !== 'L2') {
    const openDay = settings?.l1CoachOpenDay ?? 'always'
    if (openDay === 'always') return true
    const openHour = settings?.l1CoachOpenHour ?? 0
    const targetDayIdx = DAY_INDEX[openDay] ?? 0
    if (dayOfWeek === targetDayIdx) return currentTimeDecimal >= openHour
    const daysSinceOpen = (dayOfWeek - targetDayIdx + 7) % 7
    return daysSinceOpen > 0
  }

  // L2 Coaches — weekly view, opens Sunday 5pm WST for the week ahead (Mon–Sun)
  if (role === 'coach' && coachTier === 'L2') {
    const openDay = settings?.l2CoachOpenDay ?? 'sunday'
    const openHour = settings?.l2CoachOpenHour ?? 17
    const targetDayIdx = DAY_INDEX[openDay] ?? 0
    if (dayOfWeek === targetDayIdx) return currentTimeDecimal >= openHour
    const daysSinceOpen = (dayOfWeek - targetDayIdx + 7) % 7
    return daysSinceOpen > 0
  }

  // Customers
  const openDay = settings?.customerOpenDay ?? 'sunday'
  const openHour = settings?.customerOpenHour ?? 19
  const targetDayIdx = DAY_INDEX[openDay] ?? 0
  if (dayOfWeek === targetDayIdx) return currentTimeDecimal >= openHour
  const daysSinceOpen = (dayOfWeek - targetDayIdx + 7) % 7
  return daysSinceOpen > 0
}

export function getCalendarAccessMessage(
  role: 'coach' | 'customer',
  coachTier?: 'L1' | 'L2' | null,
  settings?: { l1CoachOpenDay?: string; l1CoachOpenHour?: number; l2CoachOpenDay?: string; l2CoachOpenHour?: number; customerOpenDay?: string; customerOpenHour?: number }
): string {
  const formatHour = (h: number) => {
    if (h === 0) return '12:00am'
    if (h < 12) return `${h}:00am`
    if (h === 12) return '12:00pm'
    return `${h - 12}:00pm`
  }
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

  if (role === 'coach' && coachTier === 'L2') {
    const day = settings?.l2CoachOpenDay ?? 'sunday'
    const hour = settings?.l2CoachOpenHour ?? 17
    return `L2 Coach booking opens at ${formatHour(hour)} ${capitalize(day)} WST for the week ahead (Monday–Sunday).`
  }
  if (role === 'coach') {
    const day = settings?.l1CoachOpenDay ?? 'always'
    if (day === 'always') return 'L1 Coach booking is available on a rolling 8-day window.'
    const hour = settings?.l1CoachOpenHour ?? 0
    return `L1 Coach booking opens at ${formatHour(hour)} ${capitalize(day)} WST.`
  }
  const day = settings?.customerOpenDay ?? 'sunday'
  const hour = settings?.customerOpenHour ?? 19
  return `Booking opens at ${formatHour(hour)} ${capitalize(day)} WST for the upcoming week.`
}

// ============================================================
// FORMATTING & UTILITIES
// ============================================================

export function formatTime(h: number): string {
  const whole = Math.floor(h)
  const mins = Math.round((h - whole) * 60)
  const period = whole >= 12 ? 'pm' : 'am'
  const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole
  return mins > 0 ? `${display}:${mins.toString().padStart(2, '0')}${period}` : `${display}${period}`
}

export function getCurrentWeekDays(): Date[] {
  const today = getAWSTNow()
  const dayOfWeek = today.getDay()
  // On Sunday, show today (Sunday) + the next 6 days so users can book the week ahead
  // (calendar access opens Sunday 5pm AWST for the upcoming week).
  let start: Date
  if (dayOfWeek === 0) {
    start = new Date(today)
  } else {
    // Mon-Sat: show current week starting Monday
    start = new Date(today)
    start.setDate(today.getDate() - (dayOfWeek - 1))
  }
  start.setHours(0, 0, 0, 0)
  const days: Date[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    days.push(d)
  }
  return days
}

/**
 * Returns the Mon–Sun week that L2 coaches should see.
 * On Sunday (when access opens at 5pm WST): returns NEXT Mon–Sun.
 * Mon–Sat: returns the current Mon–Sun (the week that opened last Sunday).
 */
export function getL2WeekDays(): Date[] {
  const today = getAWSTNow()
  const dayOfWeek = today.getDay() // 0=Sunday
  let start: Date
  if (dayOfWeek === 0) {
    // Sunday — show next week (tomorrow = Monday through the following Sunday)
    start = new Date(today)
    start.setDate(today.getDate() + 1)
  } else {
    // Mon–Sat — show this week's Monday
    start = new Date(today)
    start.setDate(today.getDate() - (dayOfWeek - 1))
  }
  start.setHours(0, 0, 0, 0)
  const days: Date[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    days.push(d)
  }
  return days
}

// ============================================================
// WEEKLY-RELEASE MODEL (SPEC_BOOKING_WINDOW_AND_RELEASE)
// ============================================================
// The current week (Mon–Sun, 7 columns) is always bookable for customers + L2
// coaches. Next week opens on the configured release day, at/after the release
// hour, through 23:59:59 of that day — the view then expands to today + the next
// full week (8 columns). At midnight it reverts to the new current week. L1
// coaches use the rolling window (getCoachRolling7Days) and are unaffected.
// The server enforces the same horizon in createBooking (convex/lib/bookingWindow.ts).

type ReleaseRole = 'coach' | 'customer'
type ReleaseTier = 'L1' | 'L2' | null | undefined
type ReleaseSettings = {
  customerOpenDay?: string; customerOpenHour?: number
  l2CoachOpenDay?: string; l2CoachOpenHour?: number
}

function releaseFor(role: ReleaseRole, tier: ReleaseTier, s?: ReleaseSettings) {
  if (role === 'coach' && tier === 'L2') {
    return { day: s?.l2CoachOpenDay ?? 'sunday', hour: s?.l2CoachOpenHour ?? 17 }
  }
  return { day: s?.customerOpenDay ?? 'sunday', hour: s?.customerOpenHour ?? 19 }
}

/** Is next week currently open for this caller? L1 coaches use the rolling window, never this. */
export function isNextWeekOpen(role: ReleaseRole, tier: ReleaseTier, s?: ReleaseSettings, now: Date = getAWSTNow()): boolean {
  if (role === 'coach' && tier !== 'L2') return false
  const { day, hour } = releaseFor(role, tier, s)
  const releaseDow = DAY_INDEX[day] ?? 0
  if (now.getDay() !== releaseDow) return false
  return now.getHours() + now.getMinutes() / 60 >= hour
}

/** 7-column current week, expanding to 8 (today + next week) once next week opens. */
export function getVisibleWeekDays(role: ReleaseRole, tier: ReleaseTier, s?: ReleaseSettings, now: Date = getAWSTNow()): Date[] {
  if (isNextWeekOpen(role, tier, s, now)) {
    const today = new Date(now); today.setHours(0, 0, 0, 0)
    const days: Date[] = []
    for (let i = 0; i < 8; i++) { const d = new Date(today); d.setDate(today.getDate() + i); days.push(d) }
    return days
  }
  const { day } = releaseFor(role, tier, s)
  const releaseDow = DAY_INDEX[day] ?? 0
  const weekStartDow = (releaseDow + 1) % 7 // day after release = week start (Mon for Sun release)
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const offset = (start.getDay() - weekStartDow + 7) % 7
  start.setDate(start.getDate() - offset)
  const days: Date[] = []
  for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d) }
  return days
}

/** Next release moment for this caller, as an AWST-frame Date — drives the countdown banner. */
export function getNextReleaseDate(role: ReleaseRole, tier: ReleaseTier, s?: ReleaseSettings, now: Date = getAWSTNow()): Date {
  const { day, hour } = releaseFor(role, tier, s)
  const releaseDow = DAY_INDEX[day] ?? 0
  const target = new Date(now)
  target.setHours(Math.floor(hour), Math.round((hour - Math.floor(hour)) * 60), 0, 0)
  let dayDiff = (releaseDow - now.getDay() + 7) % 7
  if (dayDiff === 0 && now.getTime() >= target.getTime()) dayDiff = 7 // release hour passed today → next week
  target.setDate(target.getDate() + dayDiff)
  return target
}

export function formatDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatDayLabel(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return days[date.getDay()]
}

export function isToday(date: Date): boolean {
  const today = getAWSTNow()
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
}

export function isPast(date: Date, hour: number): boolean {
  const now = getAWSTNow()
  const slotTime = new Date(date)
  const whole = Math.floor(hour)
  const mins = Math.round((hour - whole) * 60)
  slotTime.setHours(whole, mins, 0, 0)
  return slotTime <= now
}

export function isWeekday(date: Date): boolean {
  const day = date.getDay()
  return day >= 1 && day <= 5
}

export function getMockBookings(): Booking[] {
  const week = getCurrentWeekDays()
  const todayKey = formatDateKey(getAWSTNow())
  const dayIdx = getAWSTNow().getDay()
  const tomorrowIdx = dayIdx === 0 ? 1 : Math.min(dayIdx, 6)
  const tomorrowKey = week.length > tomorrowIdx ? formatDateKey(week[tomorrowIdx]) : todayKey

  return [
    { id: '1', laneId: 'bm1', date: todayKey, startHour: 9, duration: 60, customerName: 'Alex Smith', customerEmail: 'alex@test.com', status: 'confirmed' },
    { id: '2', laneId: 'bm1', date: todayKey, startHour: 14, duration: 90, customerName: 'Jordan Lee', customerEmail: 'jordan@test.com', status: 'confirmed' },
    { id: '3', laneId: 'bm2', date: todayKey, startHour: 10, duration: 60, customerName: 'Sam Wilson', customerEmail: 'sam@test.com', status: 'confirmed' },
    { id: '4', laneId: 'ru1', date: todayKey, startHour: 7, duration: 90, customerName: 'Chris Taylor', customerEmail: 'chris@test.com', status: 'confirmed' },
    { id: '5', laneId: 'ru2', date: tomorrowKey, startHour: 11, duration: 60, customerName: 'Pat Brown', customerEmail: 'pat@test.com', status: 'confirmed' },
    { id: '6', laneId: 'bm3', variantId: 'bm3-truman', date: todayKey, startHour: 16, duration: 60, customerName: 'Riley Chen', customerEmail: 'riley@test.com', status: 'confirmed' },
    { id: '7', laneId: 'bm1', date: todayKey, startHour: 17, duration: 90, customerName: 'Coach Demo', customerEmail: 'coach@test.com', status: 'confirmed', isCoachBooking: true, coachPrice: 40 },
  ]
}

export function isSlotBooked(bookings: Booking[], laneId: string, dateKey: string, hour: number): Booking | null {
  return bookings.find(b => {
    if (!bookingOccupiesLane(b, laneId) || b.date !== dateKey || b.status === 'cancelled') return false
    const endHour = b.startHour + b.duration / 60
    return hour >= b.startHour && hour < endHour
  }) || null
}

export function canBookSlot(bookings: Booking[], laneId: string, dateKey: string, startHour: number, durationMinutes: number): boolean {
  const endHour = startHour + durationMinutes / 60
  const dayClose = getHoursForDate(getSettingsStore().get(), dateKey).close
  if (endHour > dayClose) return false
  return !bookings.some(b => {
    if (!bookingOccupiesLane(b, laneId) || b.date !== dateKey || b.status === 'cancelled') return false
    const bEnd = b.startHour + b.duration / 60
    return startHour < bEnd && endHour > b.startHour
  })
}

export function generateGoogleCalendarUrl(booking: {
  laneName: string
  variantName?: string
  date: string
  startHour: number
  duration: number
  customerName: string
  additionalLanes?: string[]
  accessCode?: string
}): string {
  const [year, month, day] = booking.date.split('-').map(Number)
  const whole = Math.floor(booking.startHour)
  const mins = Math.round((booking.startHour - whole) * 60)
  const startDate = new Date(year, month - 1, day, whole, mins, 0)
  const endDate = new Date(startDate.getTime() + booking.duration * 60 * 1000)
  const formatGCalDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const laneStr = booking.additionalLanes && booking.additionalLanes.length > 0
    ? `${booking.laneName} + ${booking.additionalLanes.join(', ')}`
    : booking.laneName
  const title = encodeURIComponent(`Cricket Net Session - ${laneStr}${booking.variantName ? ` (${booking.variantName})` : ''}`)
  const durationLabel = booking.duration >= 60
    ? `${Math.floor(booking.duration / 60)}hr${booking.duration % 60 > 0 ? ` ${booking.duration % 60}min` : ''}`
    : `${booking.duration}min`
  const accessCodeLine = booking.accessCode ? `\n\n🔑 Door Access Code: ${booking.accessCode.length === 6 ? booking.accessCode.slice(0, 3) + '-' + booking.accessCode.slice(3) : booking.accessCode.length === 4 ? booking.accessCode.slice(0, 2) + '-' + booking.accessCode.slice(2) : booking.accessCode}\nEnter this code at the facility door keypad.` : ''
  const details = encodeURIComponent(`Booking for ${booking.customerName}\n${laneStr}${booking.variantName ? ` - ${booking.variantName}` : ''}\nDuration: ${durationLabel}${accessCodeLine}\n\nBooked via Krickora`)
  const location = encodeURIComponent('Krickora')
  const dates = `${formatGCalDate(startDate)}/${formatGCalDate(endDate)}`
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dates}&details=${details}&location=${location}&sf=true&output=xml`
}

export function generateOutlookCalendarUrl(booking: {
  laneName: string
  variantName?: string
  date: string
  startHour: number
  duration: number
  customerName: string
  additionalLanes?: string[]
  accessCode?: string
}): string {
  const [year, month, day] = booking.date.split('-').map(Number)
  const whole = Math.floor(booking.startHour)
  const mins = Math.round((booking.startHour - whole) * 60)
  const startDate = new Date(Date.UTC(year, month - 1, day, whole - 8, mins, 0))
  const endDate = new Date(startDate.getTime() + booking.duration * 60 * 1000)
  const formatOutlookDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00')
  const laneStr = booking.additionalLanes && booking.additionalLanes.length > 0
    ? `${booking.laneName} + ${booking.additionalLanes.join(', ')}`
    : booking.laneName
  const subject = encodeURIComponent(`Cricket Net Session - ${laneStr}${booking.variantName ? ` (${booking.variantName})` : ''}`)
  const durationLabel = booking.duration >= 60
    ? `${Math.floor(booking.duration / 60)}hr${booking.duration % 60 > 0 ? ` ${booking.duration % 60}min` : ''}`
    : `${booking.duration}min`
  const accessCodeLine = booking.accessCode ? `\n\n🔑 Door Access Code: ${booking.accessCode.length === 6 ? booking.accessCode.slice(0, 3) + '-' + booking.accessCode.slice(3) : booking.accessCode.length === 4 ? booking.accessCode.slice(0, 2) + '-' + booking.accessCode.slice(2) : booking.accessCode}\nEnter this code at the facility door keypad.` : ''
  const body = encodeURIComponent(`Booking for ${booking.customerName}\n${laneStr}${booking.variantName ? ` - ${booking.variantName}` : ''}\nDuration: ${durationLabel}${accessCodeLine}\n\nBooked via Krickora`)
  const location = encodeURIComponent('Krickora')
  const startISO = encodeURIComponent(formatOutlookDate(startDate))
  const endISO = encodeURIComponent(formatOutlookDate(endDate))
  return `https://outlook.live.com/calendar/0/action/compose?subject=${subject}&startdt=${startISO}&enddt=${endISO}&body=${body}&location=${location}`
}
