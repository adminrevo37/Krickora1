import { useState, useMemo, useEffect } from 'react'
import {
  LANES,
  getCoachRolling7Days,
  getVisibleWeekDays,
  isNextWeekOpen,
  getNextReleaseDate,
  getAWSTNow,
  formatDateKey,
  formatDayLabel,
  formatTime,
  isToday,
  isPast,
  isSlotBooked,
  canBookSlot,
  getActiveHalfHoursForLane,
  getAvailableStartTimes,
  getCustomerDurations,
  getValidCoachStartTimes,
  isWeekday,
  type Booking,
  type Lane,
  type TimeSlot,
} from '../lib/booking-data'
import { getHoursForDate } from '../lib/settings-store'
import { useLaneConfigState } from '../hooks/useLaneConfig'
import { LaneHeaderInner, LaneLegend, bandClassForSlot, bandStart, bandTagText } from './laneDisplay'
import { CoverageBlockBg } from './CoverageTimeline'
import { getContrastText } from '../lib/colour'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useBookings } from '../hooks/useBookingStore'
import { useLaneBlocks } from '../hooks/useLaneBlocks'
import { useAuth } from '../hooks/useAuth'
import FaultReportModal from './FaultReportModal'
import { useWaitlist } from '../hooks/useWaitlist'
import { useSettings } from '../hooks/useSettings'
import BookingModal from './BookingModal'
import AuthModal from './AuthModal'
import WaitlistModal from './WaitlistModal'

export default function BookingCalendar({ impersonatedEmail, initialDate }: { impersonatedEmail?: string; initialDate?: string } = {}) {
  const { user, isAdmin: realIsAdmin, isCoach: realIsCoach, customerRecord } = useAuth()
  const [showFaultModal, setShowFaultModal] = useState(false)
  // When impersonating, behave as a regular customer (not admin/coach)
  const isAdmin = impersonatedEmail ? false : realIsAdmin
  const userIsCoach = impersonatedEmail ? false : realIsCoach
  const { settings } = useSettings()
  // SPEC_RECONFIGURABLE_LANES: re-render when the lane layout changes (live).
  const laneConfig = useLaneConfigState()

  // Wait for customerRecord to load before deciding tier — otherwise L2 coaches
  // see a brief L1 flash while Convex resolves the record. Tiers are L1/L2 only.
  const coachTierLoaded = customerRecord !== undefined && customerRecord !== null
  const coachTierNorm: 'L1' | 'L2' = ((customerRecord as any)?.coachTier === 'L2' || (customerRecord as any)?.coachTier === 'BowlingL2') ? 'L2' : 'L1'
  // Only L1 coaches get the rolling window. L2 coaches see the weekly view like customers.
  // If the record hasn't loaded yet, default to NON-L1 (weekly view) to avoid an L1 flash for L2 coaches.
  const isL1Coach = userIsCoach && coachTierLoaded && coachTierNorm !== 'L2'
  const releaseRole: 'coach' | 'customer' = userIsCoach ? 'coach' : 'customer'
  const coachWindowDays = settings.coachBookingWindowDays ?? 8
  const weekDays = useMemo(() => {
    if (isL1Coach) return getCoachRolling7Days(coachWindowDays)
    return getVisibleWeekDays(releaseRole, coachTierNorm, settings)
  }, [isL1Coach, coachWindowDays, releaseRole, coachTierNorm, settings])

  const [selectedDay, setSelectedDay] = useState<Date>(() => {
    // SPEC_SCHEDULE_DAY_VIEW §4: a "Book Now → that day" deep-link (?date=) selects
    // that day if it's within the currently visible window.
    if (initialDate) {
      const match = weekDays.find(d => formatDateKey(d) === initialDate)
      if (match) return match
    }
    if (isL1Coach) return weekDays[0] // Today for L1 coaches (rolling window)
    // Always default to today if it exists in the weekDays array
    const todayMatch = weekDays.find(d => isToday(d))
    if (todayMatch) return todayMatch
    // Fallback: first non-past day, or first day
    const awstNow = getAWSTNow()
    awstNow.setHours(0, 0, 0, 0)
    const firstFuture = weekDays.find(d => d >= awstNow)
    return firstFuture ?? weekDays[0]
  })

  const allTimeSlots = useMemo(() => {
    const { open, close } = getHoursForDate(settings, selectedDay)
    const slots: TimeSlot[] = []
    for (let h = open; h < close; h += 0.5) slots.push({ hour: h, label: formatTime(h) })
    return slots
  }, [selectedDay, settings])
  const { bookings, canBookTime } = useBookings()
  const { isLaneBlocked } = useLaneBlocks()
  const { isOnWaitlist, getWaitlistCount } = useWaitlist(user?.id)

  const [modalOpen, setModalOpen] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<{ lane: Lane; date: Date; startHour: number } | null>(null)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<{ type: 'book'; lane: Lane; slot: TimeSlot } | { type: 'waitlist' } | null>(null)
  const [waitlistMode, setWaitlistMode] = useState(false)
  const [waitlistSelections, setWaitlistSelections] = useState<{ laneId: string; date: string; hour: number }[]>([])
  // Time-slot based: only date+hour matters (any lane opening triggers notification)
  const [waitlistModalOpen, setWaitlistModalOpen] = useState(false)

  const dateKey = formatDateKey(selectedDay)
  // N-11: surface admin facility closures in the customer calendar (server also
  // rejects in createBooking, but the calendar should grey closed dates, not only
  // fail at confirm).
  const closures = (useQuery(api.closures.listUpcoming) ?? []) as Array<{ date: string; reason?: string }>
  const closedDates = useMemo(() => {
    const m = new Map<string, string | undefined>()
    for (const c of closures) m.set(c.date, c.reason)
    return m
  }, [closures])
  const isSelectedDayClosed = closedDates.has(dateKey)
  const selectedClosureReason = closedDates.get(dateKey)

  const laneActiveHalfHours = useMemo(() => {
    const map = new Map<string, Set<number>>()
    for (const lane of LANES) map.set(lane.id, getActiveHalfHoursForLane(bookings, lane.id, dateKey))
    return map
  }, [bookings, dateKey])

  const visibleTimeSlots = useMemo(() => {
    const base = allTimeSlots.filter(slot => {
      if (slot.hour === Math.floor(slot.hour)) return true
      // SPEC_MOBILE_BOOKING_UPDATES §7.1 — 3:30pm row is COACHES-ONLY (all tiers),
      // weekdays. Never leak it to customers, even if a coach booking spans it →
      // do NOT fall through to the active-lane rule below for 15.5.
      if (slot.hour === 15.5) return userIsCoach && isWeekday(selectedDay)
      // Other half-hours: show if any lane is active there (e.g. a 30-min coach slot).
      for (const activeSet of laneActiveHalfHours.values()) {
        if (activeSet.has(slot.hour)) return true
      }
      return false
    })
    // §7.2 — inject a 6:30am row for L1 coaches ONLY (it's below opening, so it's
    // not in allTimeSlots). Hidden for customers and L2 coaches.
    if (isL1Coach && !base.some(s => s.hour === 6.5)) {
      base.push({ hour: 6.5, label: formatTime(6.5) })
    }
    base.sort((a, b) => a.hour - b.hour)
    // §7.3 — on TODAY, hide rows whose hour has already completed (end ≤ now AWST),
    // so the next bookable slot sits at the top. Applies to customers + coaches.
    if (isToday(selectedDay)) {
      const now = getAWSTNow()
      const nowHour = now.getHours() + now.getMinutes() / 60
      return base.filter(s => (s.hour + 1) > nowHour)
    }
    return base
  }, [allTimeSlots, laneActiveHalfHours, userIsCoach, isL1Coach, selectedDay])

  const laneStartTimes = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const lane of LANES) map.set(lane.id, getAvailableStartTimes(bookings, lane.id, dateKey))
    return map
  }, [bookings, dateKey])

  // Valid start times for coaches on the selected day (every open hour + 3:30pm on weekdays)
  const validCoachStartsForDay = useMemo(
    () => (userIsCoach ? getValidCoachStartTimes(selectedDay, coachTierNorm) : []),
    [userIsCoach, selectedDay, coachTierNorm]
  )

  const handleSlotClick = (lane: Lane, slot: TimeSlot) => {
    if (isPast(selectedDay, slot.hour)) return
    if (isSelectedDayClosed && !waitlistMode) return // facility closed — booking blocked (server also rejects)
    const booked = isSlotBooked(bookings, lane.id, dateKey, slot.hour)
    if (waitlistMode) { toggleWaitlistSelection(lane.id, dateKey, slot.hour); return }
    if (booked) return
    const timeCheck = canBookTime(dateKey, slot.hour)
    if (!timeCheck.allowed) return
    if (!isAdmin) {
      if (userIsCoach) {
        if (!validCoachStartsForDay.includes(slot.hour)) return
      } else {
        const validStarts = laneStartTimes.get(lane.id) ?? []
        if (!validStarts.includes(slot.hour)) return
      }
    }
    if (!user) { setPendingAction({ type: 'book', lane, slot }); setAuthModalOpen(true); return }
    setSelectedSlot({ lane, date: selectedDay, startHour: slot.hour })
    setModalOpen(true)
  }

  // Time-slot based: toggle by date+hour only (laneId stored as '*' for any-lane)
  const toggleWaitlistSelection = (_laneId: string, date: string, hour: number) => {
    setWaitlistSelections(prev => {
      const exists = prev.some(s => s.date === date && s.hour === hour)
      if (exists) return prev.filter(s => !(s.date === date && s.hour === hour))
      return [...prev, { laneId: '*', date, hour }]
    })
  }

  const isWaitlistSelected = (_laneId: string, date: string, hour: number) => {
    return waitlistSelections.some(s => s.date === date && s.hour === hour)
  }

  // Check if ALL lanes are booked/unavailable at this hour (so we can offer waitlist)
  const isTimeSlotFullyBooked = (date: string, hour: number) => {
    return LANES.every(lane => {
      const laneActiveSet = laneActiveHalfHours.get(lane.id) ?? new Set()
      const isHalf = hour !== Math.floor(hour)
      const booked = isSlotBooked(bookings, lane.id, date, hour)
      if (booked) return true
      if (isHalf && !laneActiveSet.has(hour)) return true // lane inactive at this half-hour
      return false
    })
  }

  const handleAuthSuccess = () => {
    setAuthModalOpen(false)
    if (pendingAction?.type === 'book') {
      setSelectedSlot({ lane: pendingAction.lane, date: selectedDay, startHour: pendingAction.slot.hour })
      setModalOpen(true)
    }
    setPendingAction(null)
  }

  const handleBookingConfirm = async (_booking: Booking) => {
    // Bug N-8: BookingModal now persists the booking itself (awaited, with errors
    // surfaced) before showing its success screen — so this no longer writes.
    // It just closes the modal; the reactive listBookings query refreshes the
    // calendar and My Bookings. Previously this swallowed write errors (`catch {}`),
    // masking failed bookings as confirmed.
    setModalOpen(false)
    setSelectedSlot(null)
  }

  const startWaitlistMode = () => {
    if (!user) { setPendingAction({ type: 'waitlist' }); setAuthModalOpen(true); return }
    setWaitlistMode(true); setWaitlistSelections([])
  }

  const confirmWaitlist = () => { if (waitlistSelections.length === 0) return; setWaitlistModalOpen(true) }
  const cancelWaitlistMode = () => { setWaitlistMode(false); setWaitlistSelections([]) }

  // Determine header label
  const nextWeekOpen = !isL1Coach && isNextWeekOpen(releaseRole, coachTierNorm, settings)
  const headerLabel = isL1Coach
    ? `📅 Next ${coachWindowDays} Days (Rolling)`
    : nextWeekOpen ? '📅 This Week + Next Week' : '📅 This Week'

  return (
    <div className="space-y-6">
      {showFaultModal && <FaultReportModal onClose={() => setShowFaultModal(false)} />}
      {/* Weekly-release banner (customers + L2 coaches only) */}
      {!isL1Coach && (
        <ReleaseBanner role={releaseRole} tier={coachTierNorm} settings={settings} nextWeekOpen={nextWeekOpen} lastDay={weekDays[weekDays.length - 1]} />
      )}
      {/* Week Day Selector */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-800">{headerLabel}</h2>
          <div className="flex items-center gap-2">
            {user && (
              <button
                onClick={() => setShowFaultModal(true)}
                className="text-[11px] px-2.5 py-1 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-600 font-semibold transition-colors"
                title="Report broken equipment or a facility issue"
              >
                🛠️ Report an issue
              </button>
            )}
            {userIsCoach && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${coachTierNorm === 'L2' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>🏅 {coachTierNorm === 'L2' ? 'L2 Coach' : 'L1 Coach'}</span>
            )}
            <span className="text-sm text-gray-500">{weekDays[0].toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} &middot; AWST</span>
          </div>
        </div>
        <div className={`grid ${weekDays.length === 8 ? 'grid-cols-8' : 'grid-cols-7'} gap-2`}>
          {weekDays.map((day) => {
            const active = formatDateKey(day) === formatDateKey(selectedDay)
            const today = isToday(day)
            const awstNow = getAWSTNow()
            awstNow.setHours(0, 0, 0, 0)
            const pastDay = day < awstNow && !today
            const dk = formatDateKey(day)
            const hasOverride = laneConfig.overrides.some((o) => dk >= o.startDate && dk <= o.endDate)
            return (
              <button key={formatDateKey(day)} onClick={() => setSelectedDay(day)} disabled={pastDay}
                className={`relative flex flex-col items-center py-2.5 px-1 rounded-xl transition-all duration-200 text-center ${active ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 scale-105' : pastDay ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-gray-50 text-gray-700 hover:bg-emerald-50 cursor-pointer'}`}>
                {hasOverride && <span title="Custom lane layout" className="absolute top-1 right-1 text-[9px] leading-none text-amber-500">⚙</span>}
                <span className={`text-xs font-medium ${active ? 'text-emerald-100' : 'text-gray-500'}`}>{formatDayLabel(day)}</span>
                <span className={`text-lg font-bold mt-0.5 ${active ? 'text-white' : ''}`}>{day.getDate()}</span>
                {today && <div className={`w-1.5 h-1.5 rounded-full mt-1 ${active ? 'bg-white' : 'bg-emerald-500'}`} />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Date Header + Waitlist */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800">{selectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
          <p className="text-sm text-gray-500 mt-0.5">{isToday(selectedDay) ? '🟢 Today' : formatDayLabel(selectedDay)} &middot; {formatTime(getHoursForDate(settings, selectedDay).open)} - {formatTime(getHoursForDate(settings, selectedDay).close)} AWST &middot; 5 Lanes</p>
        </div>
        <div className="flex items-center gap-3">
          {waitlistMode ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-600 font-medium animate-pulse">🔔 Tap any time slot to get notified when a lane opens</span>
              <button onClick={confirmWaitlist} disabled={waitlistSelections.length === 0}
                className="text-xs px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed">Confirm ({waitlistSelections.length})</button>
              <button onClick={cancelWaitlistMode} className="text-xs px-3 py-1.5 bg-gray-200 text-gray-700 font-medium rounded-lg hover:bg-gray-300 transition-all">Cancel</button>
            </div>
          ) : (
            <button onClick={startWaitlistMode} className="text-xs px-3 py-2.5 bg-amber-100 text-amber-700 font-semibold rounded-lg hover:bg-amber-200 transition-all flex items-center gap-1.5">🔔 Join Waitlist</button>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs flex-wrap">
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300" /><span className="text-gray-600">Available</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-red-100 border border-red-300" /><span className="text-gray-600">Booked</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-blue-100 border border-blue-300" /><span className="text-gray-600">Tentative</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-amber-100 border border-amber-300" /><span className="text-gray-600">Waitlisted</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-gray-200 border border-gray-300" /><span className="text-gray-600">Past</span></div>
      </div>

      {/* Lane variant colour legend (SPEC_RECONFIGURABLE_LANES) */}
      <LaneLegend />

      {/* Calendar Grid */}
      {/* Frozen lane-header row (top) + frozen Time column (left) so they stay
          visible while scrolling the grid on mobile. The grid scrolls inside this
          bounded box (both axes) rather than the whole page. */}
      <div className="bg-white rounded-2xl border-2 border-black shadow-sm overflow-auto max-h-[72vh]">
        <div className="min-w-[560px]">
        <div className="grid grid-cols-[70px_repeat(5,1fr)] border-b-2 border-black bg-white sticky top-0 z-30">
          <div className="p-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center justify-center sticky left-0 z-40 bg-white">Time</div>
          {LANES.map((lane) => (
            <div key={lane.id} className="p-2 text-center border-l-2 border-black bg-white">
              <LaneHeaderInner laneId={lane.id} dateKey={dateKey} />
            </div>
          ))}
        </div>

        {isSelectedDayClosed && (
          <div className="m-3 rounded-xl border border-red-200 dark:border-red-800/40 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-center">
            <div className="text-sm font-semibold text-red-700 dark:text-red-400">🚫 Facility closed on this day</div>
            {selectedClosureReason && <div className="text-xs text-red-600 dark:text-red-400 mt-0.5">{selectedClosureReason}</div>}
            <div className="text-[11px] text-red-500/80 mt-1">Bookings are unavailable — please choose another day.</div>
          </div>
        )}
        <div className={isSelectedDayClosed ? 'opacity-40 pointer-events-none' : ''}>
          {visibleTimeSlots.map((slot, slotIdx) => {
            const isHalfHour = slot.hour !== Math.floor(slot.hour)
            return (
              <div key={slot.hour} className={`grid grid-cols-[70px_repeat(5,1fr)] ${slotIdx < visibleTimeSlots.length - 1 ? `border-b ${isHalfHour ? 'border-gray-300' : 'border-black'}` : ''}`}>
                <div className="p-1.5 flex items-center justify-center sticky left-0 z-20 bg-white">
                  <span className={`text-[11px] font-medium text-gray-500 ${isHalfHour ? 'opacity-60' : ''}`}>{slot.label}</span>
                </div>
                {LANES.map((lane) => {
                  const laneActiveSet = laneActiveHalfHours.get(lane.id) ?? new Set()
                  const booked = isSlotBooked(bookings, lane.id, dateKey, slot.hour)
                  const blocked = !booked ? isLaneBlocked(lane.id, dateKey, slot.hour) : null
                  const past = isPast(selectedDay, slot.hour)
                  const isLaneInactiveAtHalfHour = isHalfHour && !laneActiveSet.has(slot.hour) && !booked && !blocked
                  const isTentative = booked?.status === 'tentative'
                  // SPEC_RECONFIGURABLE_LANES: per-segment colour band + band-start tag
                  const band = bandClassForSlot(lane.id, dateKey, slot.hour)
                  const bs = bandStart(lane.id, dateKey, slot.hour)

                  const isStartOfBooking = booked && Math.abs(booked.startHour - slot.hour) < 0.01
                  const isMiddleOfBooking = booked && !isStartOfBooking
                  const validStarts = laneStartTimes.get(lane.id) ?? []
                  const isValidStart = validStarts.includes(slot.hour) || (userIsCoach && validCoachStartsForDay.includes(slot.hour)) || isAdmin
                  const canBook = !isSelectedDayClosed && !past && !booked && !blocked && isValidStart && canBookSlot(bookings, lane.id, dateKey, slot.hour, 60)
                  const hasDurations = !isSelectedDayClosed && !past && !booked && isValidStart ? getCustomerDurations(bookings, lane.id, dateKey, slot.hour).length > 0 || (userIsCoach && validCoachStartsForDay.includes(slot.hour)) || isAdmin : false
                  const waitlistCount = getWaitlistCount(lane.id, dateKey, slot.hour)
                  const userOnWaitlist = user ? isOnWaitlist(user.id, lane.id, dateKey, slot.hour) : false
                  const isSelected = isWaitlistSelected(lane.id, dateKey, slot.hour)
                  const timeCheck = canBookTime(dateKey, slot.hour)
                  const tooLate = !past && !booked && !timeCheck.allowed

                  const getBookingVisualHeight = () => {
                    if (!booked || !isStartOfBooking) return 0
                    const bookingEnd = booked.startHour + booked.duration / 60
                    let count = 0
                    for (const vs of visibleTimeSlots) { if (vs.hour >= booked.startHour && vs.hour < bookingEnd) count++ }
                    return count
                  }
                  const visualSpan = getBookingVisualHeight()

                  // §6: show allocation coverage on the coach's OWN coach bookings.
                  const ownCoachBooking = !!booked && !!booked.isCoachBooking && !!userIsCoach && !!user && (
                    (booked.customerEmail?.toLowerCase() === user.email?.toLowerCase()) || booked.userId === user.id
                  )
                  const myCoachColor = (customerRecord as any)?.color as string | undefined
                  // SPEC_MOBILE_BOOKING_UPDATES §3 — the user's OWN (non-coach) booking
                  // renders BLUE "Your booking" so they spot it instantly. Precedence:
                  // admin-name view → own-coach coverage → own → tentative → booked.
                  const isOwnBooking = !!booked && !!user && !isAdmin && !ownCoachBooking && !booked.isCoachBooking && (
                    (booked.customerEmail?.toLowerCase() === user.email?.toLowerCase()) || booked.userId === user.id
                  )
                  const useBlueBlock = isTentative || isOwnBooking

                  if (isLaneInactiveAtHalfHour) {
                    return (
                      <div key={lane.id} className="relative border-l-2 border-black min-h-[32px] bg-white">
                        <div className="absolute inset-0 flex items-center justify-center"><div className="w-4 h-[1px] bg-gray-300" /></div>
                      </div>
                    )
                  }

                  if (blocked) {
                    const isBlockStart = Math.abs(blocked.startHour - slot.hour) < 0.01
                    const blockSpan = (() => {
                      if (!isBlockStart) return 0
                      const bEnd = blocked.startHour + blocked.duration / 60
                      let count = 0
                      for (const vs of visibleTimeSlots) { if (vs.hour >= blocked.startHour && vs.hour < bEnd) count++ }
                      return count
                    })()
                    return (
                      <div key={lane.id} className="relative border-l-2 border-black min-h-[32px] bg-[repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6_4px,#e5e7eb_4px,#e5e7eb_8px)]">
                        {isBlockStart && (
                          <div className="absolute inset-x-0.5 top-0.5 z-10 rounded-md px-1.5 py-1 border border-gray-400 bg-gray-200/90" style={{ height: `${blockSpan * 32 - 4}px` }}>
                            <div className="text-[9px] font-semibold text-gray-700 truncate">🔧 Unavailable</div>
                            <div className="text-[8px] text-gray-600 truncate">{(blocked as any).reason ?? 'Service'}</div>
                          </div>
                        )}
                      </div>
                    )
                  }

                  return (
                    <div key={lane.id}
                      className={`relative border-l-2 border-black min-h-[32px] transition-all duration-150 ${past ? 'bg-gray-200' : waitlistMode ? (isSelected ? 'bg-amber-100 cursor-pointer ring-2 ring-inset ring-amber-400' : 'cursor-pointer hover:bg-amber-50') : booked ? '' : tooLate ? 'bg-gray-200' : canBook && hasDurations ? 'bg-emerald-50 hover:bg-emerald-100 cursor-pointer group' : band}`}
                      onClick={() => {
                        if (past || isLaneInactiveAtHalfHour) return
                        if (waitlistMode) { toggleWaitlistSelection(lane.id, dateKey, slot.hour); return }
                        if (!booked && canBook && hasDurations && timeCheck.allowed) handleSlotClick(lane, slot)
                      }}>
                      {!booked && !past && bs.isStart && bs.multi && (
                        <div className="absolute top-0 left-0 z-[5] text-[7px] leading-tight font-semibold text-gray-600 bg-white/70 rounded-br px-1 py-0.5 pointer-events-none max-w-full truncate">
                          {bandTagText(lane.id, dateKey, bs.seg)}
                        </div>
                      )}
                      {isStartOfBooking && booked && ownCoachBooking && (
                        <div className="absolute inset-x-0.5 top-0.5 z-10 rounded-md overflow-hidden border border-black/10"
                          style={{ height: `${visualSpan * 32 - 4}px` }}>
                          <CoverageBlockBg booking={booked} coachColor={myCoachColor} />
                          <div className="relative z-10 px-1.5 py-0.5">
                            <div className="text-[8px] font-semibold drop-shadow" style={{ color: getContrastText(myCoachColor) }}>
                              {formatTime(booked.startHour)}-{formatTime(booked.startHour + booked.duration / 60)} 🏅
                              {booked.status === 'cancelled' && <span className="ml-1">(cancelled)</span>}
                            </div>
                          </div>
                        </div>
                      )}
                      {isStartOfBooking && booked && !ownCoachBooking && (
                        <div className={`absolute inset-x-0.5 top-0.5 z-10 rounded-md px-1.5 py-1 border ${useBlueBlock ? 'bg-gradient-to-br from-blue-100 to-blue-50 border-blue-200' : 'bg-gradient-to-br from-red-100 to-red-50 border-red-200'}`}
                          style={{ height: `${visualSpan * 32 - 4}px` }}>
                          <div className={`text-[9px] font-semibold truncate ${useBlueBlock ? 'text-blue-700' : 'text-red-700'}`}>
                            {isAdmin ? booked.customerName : isOwnBooking ? 'Your booking' : isTentative ? 'Tentative' : 'Booked'}
                            {booked.status === 'cancelled' && <span className="ml-1 text-orange-500">(cancelled)</span>}
                            {isTentative && !isOwnBooking && <span className="ml-1">⏳</span>}
                          </div>
                          <div className={`text-[8px] ${useBlueBlock ? 'text-blue-500' : 'text-red-500'}`}>
                            {formatTime(booked.startHour)}-{formatTime(booked.startHour + booked.duration / 60)}
                            {isAdmin && booked.isCoachBooking && <span className="ml-1 text-orange-500">🏅</span>}
                          </div>
                          {(waitlistCount > 0 || userOnWaitlist) && !waitlistMode && (
                            <div className="flex items-center gap-0.5 mt-0.5">
                              <span className="text-[7px] bg-amber-200 text-amber-700 px-1 rounded-full font-medium">🔔{waitlistCount}</span>
                              {userOnWaitlist && <span className="text-[7px] bg-emerald-200 text-emerald-700 px-1 rounded-full font-medium">You</span>}
                            </div>
                          )}
                          {waitlistMode && isSelected && (
                            <div className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 rounded-full flex items-center justify-center text-white text-[8px] font-bold shadow">✓</div>
                          )}
                        </div>
                      )}
                      {isMiddleOfBooking && <div className={`absolute inset-0 ${useBlueBlock ? 'bg-blue-50/30' : 'bg-red-50/30'}`} />}
                      {past && !booked && <div className="absolute inset-0 flex items-center justify-center pointer-events-none"><span className="text-[14px] leading-none text-gray-400 font-medium">–</span></div>}
                      {tooLate && !booked && <div className="absolute inset-0 flex items-center justify-center"><span className="text-[8px] text-gray-400">Too late</span></div>}
                      {canBook && hasDurations && !booked && !past && !tooLate && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <span className="text-[15px] leading-none text-emerald-400 font-semibold group-hover:text-emerald-600 transition-colors">+</span>
                        </div>
                      )}
                      {!past && !booked && canBook && hasDurations && timeCheck.allowed && !waitlistMode && (
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <div className="flex items-center gap-0.5 bg-emerald-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full shadow-lg shadow-emerald-500/30"><span>+</span><span>Book</span></div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        </div>
      </div>

      {/* Modals */}
      {modalOpen && selectedSlot && (
        <BookingModal lane={selectedSlot.lane} date={selectedSlot.date} startHour={selectedSlot.startHour} existingBookings={bookings}
          onClose={() => { setModalOpen(false); setSelectedSlot(null) }} onConfirm={handleBookingConfirm} />
      )}
      {authModalOpen && <AuthModal onClose={() => { setAuthModalOpen(false); setPendingAction(null) }} onSuccess={handleAuthSuccess} />}
      {waitlistModalOpen && (
        <WaitlistModal selectedSlots={waitlistSelections} onClose={() => setWaitlistModalOpen(false)}
          onSuccess={() => { setWaitlistModalOpen(false); setWaitlistMode(false); setWaitlistSelections([]) }} />
      )}
    </div>
  )
}

// Weekly-release notice + live countdown (SPEC_BOOKING_WINDOW #1). Shown to
// customers + L2 coaches. L1 coaches use the rolling window and never see this.
function formatReleaseHour(h: number): string {
  const whole = Math.floor(h)
  const mins = Math.round((h - whole) * 60)
  const period = whole >= 12 ? 'pm' : 'am'
  const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole
  return mins > 0 ? `${display}:${mins.toString().padStart(2, '0')}${period}` : `${display}:00${period}`
}

function ReleaseBanner({ role, tier, settings, nextWeekOpen, lastDay }: {
  role: 'coach' | 'customer'; tier: 'L1' | 'L2'; settings: any; nextWeekOpen: boolean; lastDay: Date
}) {
  // Tick every second so the countdown stays live.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (nextWeekOpen) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3 flex items-center gap-2">
        <span className="text-lg">✅</span>
        <p className="text-sm font-medium text-emerald-800">
          Next week is now open — book through {lastDay.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}.
        </p>
      </div>
    )
  }

  const release = getNextReleaseDate(role, tier, settings)
  const totalSec = Math.max(0, Math.floor((release.getTime() - getAWSTNow().getTime()) / 1000))
  // Only surface the countdown within the admin-configured window before release.
  // When time-to-release exceeds it, hide the banner entirely (admin SSOT).
  const visibleWithinSec = (settings.releaseCountdownHours ?? 24) * 3600
  if (totalSec > visibleWithinSec) return null
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  const countdown = days > 0 ? `${days}d ${hours}h ${mins}m` : hours > 0 ? `${hours}h ${mins}m ${secs}s` : `${mins}m ${secs}s`

  const dayName = release.toLocaleDateString('en-US', { weekday: 'long' })
  const releaseHour = role === 'coach' && tier === 'L2' ? (settings.l2CoachOpenHour ?? 17) : (settings.customerOpenHour ?? 19)

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-2xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
      <p className="text-sm font-medium text-blue-800 flex items-center gap-2">
        <span className="text-lg">🗓️</span>
        <span>Next week opens <strong>{dayName} {formatReleaseHour(releaseHour)}</strong> AWST</span>
        {role === 'coach' && tier === 'L2' && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold">L2 priority</span>}
      </p>
      <span className="text-sm font-semibold text-blue-700 tabular-nums">⏳ {countdown}</span>
    </div>
  )
}
