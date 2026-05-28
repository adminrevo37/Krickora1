import { useState, useMemo } from 'react'
import {
  LANES,
  PRICING,
  generateTimeSlots,
  getCurrentWeekDays,
  getCoachRolling7Days,
  getAWSTNow,
  formatDateKey,
  formatDayLabel,
  formatTime,
  isToday,
  isPast,
  isSlotBooked,
  canBookSlot,
  canAccessCalendar,
  getCalendarAccessMessage,
  getActiveHalfHoursForLane,
  getAvailableStartTimes,
  getCustomerDurations,
  getValidCoachStartTimes,
  isWeekday,
  CLOSING_HOUR,
  type Booking,
  type Lane,
  type TimeSlot,
} from '../lib/booking-data'
import { useBookings } from '../hooks/useBookingStore'
import { useLaneBlocks } from '../hooks/useLaneBlocks'
import { useAuth } from '../hooks/useAuth'
import { useWaitlist } from '../hooks/useWaitlist'
import { useSettings } from '../hooks/useSettings'
import BookingModal from './BookingModal'
import AuthModal from './AuthModal'
import WaitlistModal from './WaitlistModal'

export default function BookingCalendar({ impersonatedEmail }: { impersonatedEmail?: string } = {}) {
  const { user, isAdmin: realIsAdmin, isCoach: realIsCoach, customerRecord } = useAuth()
  // When impersonating, behave as a regular customer (not admin/coach)
  const isAdmin = impersonatedEmail ? false : realIsAdmin
  const userIsCoach = impersonatedEmail ? false : realIsCoach
  const { settings } = useSettings()

  // Wait for customerRecord to load before deciding tier — otherwise L2 coaches
  // see a brief L1 flash while Convex resolves the record.
  const coachTierLoaded = customerRecord !== undefined && customerRecord !== null
  const coachTierEarly = ((customerRecord as any)?.coachTier ?? 'L1') as 'L1' | 'L2' | 'Bowling' | 'BowlingL2'
  // Only L1 coaches (incl. Bowling L1) get the rolling window. L2 coaches see the weekly view like customers.
  // If the record hasn't loaded yet, default to NON-L1 (weekly view) to avoid an L1 flash for L2 coaches.
  const isL1Coach = userIsCoach && coachTierLoaded && coachTierEarly !== 'L2' && coachTierEarly !== 'BowlingL2'
  const coachWindowDays = settings.coachBookingWindowDays ?? 8
  const weekDays = useMemo(() => {
    if (isL1Coach) return getCoachRolling7Days(coachWindowDays)
    return getCurrentWeekDays()
  }, [isL1Coach, coachWindowDays])

  const allTimeSlots = useMemo(() => generateTimeSlots(), [])
  const [selectedDay, setSelectedDay] = useState<Date>(() => {
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
  const { bookings, addBooking, canBookTime } = useBookings()
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
  const userRole = user?.role ?? 'customer'
  const coachTier = ((customerRecord as any)?.coachTier ?? 'L1') as 'L1' | 'L2' | 'Bowling' | 'BowlingL2'
  // Normalise 4-value tier to 2-value for access-control functions
  const coachTierNorm: 'L1' | 'L2' | null = (coachTier === 'L2' || coachTier === 'BowlingL2') ? 'L2' : 'L1'
  const hasAccess = canAccessCalendar(userRole as 'coach' | 'customer' | 'admin', coachTierNorm, settings)

  const laneActiveHalfHours = useMemo(() => {
    const map = new Map<string, Set<number>>()
    for (const lane of LANES) map.set(lane.id, getActiveHalfHoursForLane(bookings, lane.id, dateKey))
    return map
  }, [bookings, dateKey])

  const visibleTimeSlots = useMemo(() => {
    return allTimeSlots.filter(slot => {
      if (slot.hour === Math.floor(slot.hour)) return true
      // Always show 3:30pm row for coaches on weekdays so they can make bookings
      if (userIsCoach && slot.hour === 15.5 && isWeekday(selectedDay)) return true
      for (const activeSet of laneActiveHalfHours.values()) {
        if (activeSet.has(slot.hour)) return true
      }
      return false
    })
  }, [allTimeSlots, laneActiveHalfHours, userIsCoach, selectedDay])

  const laneStartTimes = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const lane of LANES) map.set(lane.id, getAvailableStartTimes(bookings, lane.id, dateKey))
    return map
  }, [bookings, dateKey])

  // Valid start times for coaches on the selected day (3:30pm Mon–Fri only, empty on weekends)
  const validCoachStartsForDay = useMemo(
    () => (userIsCoach ? getValidCoachStartTimes(selectedDay) : []),
    [userIsCoach, selectedDay]
  )

  const handleSlotClick = (lane: Lane, slot: TimeSlot) => {
    if (isPast(selectedDay, slot.hour)) return
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

  const handleBookingConfirm = async (booking: Booking) => {
    try { await addBooking(booking) } catch {}
    setModalOpen(false)
    setSelectedSlot(null)
  }

  const startWaitlistMode = () => {
    if (!user) { setPendingAction({ type: 'waitlist' }); setAuthModalOpen(true); return }
    setWaitlistMode(true); setWaitlistSelections([])
  }

  const confirmWaitlist = () => { if (waitlistSelections.length === 0) return; setWaitlistModalOpen(true) }
  const cancelWaitlistMode = () => { setWaitlistMode(false); setWaitlistSelections([]) }

  if (!hasAccess && !isAdmin) {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-8 shadow-sm text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">Calendar Not Yet Available</h2>
          <p className="text-sm text-gray-500 mb-4">{getCalendarAccessMessage(userRole as 'coach' | 'customer', coachTierNorm, settings)}</p>
          <div className="inline-flex items-center gap-2 bg-amber-50 text-amber-700 px-4 py-2 rounded-xl text-sm font-medium">⏰ Check back later</div>
        </div>
      </div>
    )
  }

  // Determine header label
  const headerLabel = isL1Coach ? `📅 Next ${coachWindowDays} Days (Rolling)` : '📅 This Week'
  const tierBadge: string | null = userIsCoach ? coachTier : null

  return (
    <div className="space-y-6">
      {/* Week Day Selector */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-800">{headerLabel}</h2>
          <div className="flex items-center gap-2">
            {userIsCoach && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${tierBadge === 'L2' ? 'bg-purple-100 text-purple-700' : tierBadge === 'Bowling' ? 'bg-green-100 text-green-700' : tierBadge === 'BowlingL2' ? 'bg-teal-100 text-teal-700' : 'bg-orange-100 text-orange-700'}`}>🏅 {tierBadge === 'L2' ? 'L2 Coach' : tierBadge === 'Bowling' ? 'Bowling L1 Coach' : tierBadge === 'BowlingL2' ? 'Bowling L2 Coach' : 'L1 Coach'}</span>
            )}
            <span className="text-sm text-gray-500">{weekDays[0].toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} &middot; AWST</span>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-2">
          {weekDays.map((day) => {
            const active = formatDateKey(day) === formatDateKey(selectedDay)
            const today = isToday(day)
            const awstNow = getAWSTNow()
            awstNow.setHours(0, 0, 0, 0)
            const pastDay = day < awstNow && !today
            return (
              <button key={formatDateKey(day)} onClick={() => setSelectedDay(day)} disabled={pastDay}
                className={`relative flex flex-col items-center py-2.5 px-1 rounded-xl transition-all duration-200 text-center ${active ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 scale-105' : pastDay ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-gray-50 text-gray-700 hover:bg-emerald-50 cursor-pointer'}`}>
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
          <p className="text-sm text-gray-500 mt-0.5">{isToday(selectedDay) ? '🟢 Today' : formatDayLabel(selectedDay)} &middot; 7am - 9pm AWST &middot; 5 Lanes</p>
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
            <button onClick={startWaitlistMode} className="text-xs px-3 py-1.5 bg-amber-100 text-amber-700 font-semibold rounded-lg hover:bg-amber-200 transition-all flex items-center gap-1.5">🔔 Join Waitlist</button>
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

      {/* Calendar Grid */}
      <div className="bg-white rounded-2xl border-2 border-black shadow-sm overflow-x-auto">
        <div className="min-w-[560px]">
        <div className="grid grid-cols-[70px_repeat(5,1fr)] border-b-2 border-black bg-white">
          <div className="p-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center justify-center">Time</div>
          {LANES.map((lane) => (
            <div key={lane.id} className="p-2 text-center border-l-2 border-black">
              <div className="text-sm">{lane.icon}</div>
              <div className="text-[11px] font-semibold text-gray-700 mt-0.5 leading-tight">{lane.shortName}</div>
              {lane.variants ? (
                <div className="flex items-center justify-center gap-1 mt-0.5">
                  <span className="text-[8px] px-1 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">Truman</span>
                  <span className="text-[8px] text-gray-400">/</span>
                  <span className="text-[8px] px-1 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">Std</span>
                </div>
              ) : (
                <div className={`text-[9px] mt-0.5 px-1 py-0.5 rounded-full inline-block ${lane.type === 'bowling-machine' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                  {lane.type === 'bowling-machine' ? 'Machine' : '9m Run Up'}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="max-h-[600px] overflow-y-auto">
          {visibleTimeSlots.map((slot, slotIdx) => {
            const isHalfHour = slot.hour !== Math.floor(slot.hour)
            return (
              <div key={slot.hour} className={`grid grid-cols-[70px_repeat(5,1fr)] ${slotIdx < visibleTimeSlots.length - 1 ? `border-b ${isHalfHour ? 'border-gray-300' : 'border-black'}` : ''}`}>
                <div className={`p-1.5 flex items-center justify-center ${isHalfHour ? 'opacity-60' : ''}`}>
                  <span className="text-[11px] font-medium text-gray-500">{slot.label}</span>
                </div>
                {LANES.map((lane) => {
                  const laneActiveSet = laneActiveHalfHours.get(lane.id) ?? new Set()
                  const booked = isSlotBooked(bookings, lane.id, dateKey, slot.hour)
                  const blocked = !booked ? isLaneBlocked(lane.id, dateKey, slot.hour) : null
                  const past = isPast(selectedDay, slot.hour)
                  const isLaneInactiveAtHalfHour = isHalfHour && !laneActiveSet.has(slot.hour) && !booked && !blocked
                  const isTentative = booked?.status === 'tentative'

                  const isStartOfBooking = booked && Math.abs(booked.startHour - slot.hour) < 0.01
                  const isMiddleOfBooking = booked && !isStartOfBooking
                  const validStarts = laneStartTimes.get(lane.id) ?? []
                  const isValidStart = validStarts.includes(slot.hour) || (userIsCoach && validCoachStartsForDay.includes(slot.hour)) || isAdmin
                  const canBook = !past && !booked && !blocked && isValidStart && canBookSlot(bookings, lane.id, dateKey, slot.hour, 60)
                  const hasDurations = !past && !booked && isValidStart ? getCustomerDurations(bookings, lane.id, dateKey, slot.hour).length > 0 || (userIsCoach && validCoachStartsForDay.includes(slot.hour)) || isAdmin : false
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
                      className={`relative border-l-2 border-black min-h-[32px] transition-all duration-150 ${past ? 'bg-gray-100' : waitlistMode ? (isSelected ? 'bg-amber-100 cursor-pointer ring-2 ring-inset ring-amber-400' : 'cursor-pointer hover:bg-amber-50') : booked ? '' : tooLate ? 'bg-gray-100' : canBook && hasDurations ? 'hover:bg-emerald-50/50 cursor-pointer group' : 'bg-white'}`}
                      onClick={() => {
                        if (past || isLaneInactiveAtHalfHour) return
                        if (waitlistMode) { toggleWaitlistSelection(lane.id, dateKey, slot.hour); return }
                        if (!booked && canBook && hasDurations && timeCheck.allowed) handleSlotClick(lane, slot)
                      }}>
                      {isStartOfBooking && booked && (
                        <div className={`absolute inset-x-0.5 top-0.5 z-10 rounded-md px-1.5 py-1 border ${isTentative ? 'bg-gradient-to-br from-blue-100 to-blue-50 border-blue-200' : 'bg-gradient-to-br from-red-100 to-red-50 border-red-200'}`}
                          style={{ height: `${visualSpan * 32 - 4}px` }}>
                          <div className={`text-[9px] font-semibold truncate ${isTentative ? 'text-blue-700' : 'text-red-700'}`}>
                            {isAdmin ? booked.customerName : isTentative ? 'Tentative' : 'Booked'}
                            {booked.status === 'cancelled' && <span className="ml-1 text-orange-500">(cancelled)</span>}
                            {isTentative && <span className="ml-1">⏳</span>}
                          </div>
                          <div className={`text-[8px] ${isTentative ? 'text-blue-500' : 'text-red-500'}`}>
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
                      {isMiddleOfBooking && <div className={`absolute inset-0 ${isTentative ? 'bg-blue-50/30' : 'bg-red-50/30'}`} />}
                      {past && !booked && <div className="absolute inset-0 flex items-center justify-center"><div className="w-3 h-[1px] bg-gray-300 rotate-45" /></div>}
                      {tooLate && !booked && <div className="absolute inset-0 flex items-center justify-center"><span className="text-[8px] text-gray-400">Too late</span></div>}
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
