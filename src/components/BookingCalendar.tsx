import { useState, useMemo, useEffect, useRef } from 'react'
import {
  LANES,
  getCoachRolling7Days,
  getVisibleWeekDays,
  getPastWeekDays,
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
import { CoachCalendarBlock } from './CoverageTimeline'
import { dayDotState } from '../lib/coverage'
import RepeatBookingButton from './RepeatBookingButton'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useBookings } from '../hooks/useBookingStore'
import { useLaneBlocks } from '../hooks/useLaneBlocks'
import { useAuth } from '../hooks/useAuth'
import { useSettings } from '../hooks/useSettings'
import BookingModal from './BookingModal'
import AuthModal from './AuthModal'
import WaitlistModal from './WaitlistModal'
import { trackEvent, startBookingFlow, trackFunnelStep } from '../lib/tracker'

export default function BookingCalendar({ impersonatedEmail, initialDate }: { impersonatedEmail?: string; initialDate?: string } = {}) {
  const { user, isAdmin: realIsAdmin, isCoach: realIsCoach, customerRecord } = useAuth()
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
  // SPEC_COACH_CALENDAR §1E — coach back-navigation. 0 = live view; -1/-2 = past
  // weeks (read-only review, own bookings only). Customers never leave 0.
  const [weekOffset, setWeekOffset] = useState(0)
  const weekDays = useMemo(() => {
    if (userIsCoach && weekOffset < 0) return getPastWeekDays(-weekOffset, releaseRole, coachTierNorm, settings)
    if (isL1Coach) return getCoachRolling7Days(coachWindowDays)
    return getVisibleWeekDays(releaseRole, coachTierNorm, settings)
  }, [userIsCoach, weekOffset, isL1Coach, coachWindowDays, releaseRole, coachTierNorm, settings])

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

  // §1E — when the visible week changes (coach back/forward nav), keep selectedDay
  // inside it: jump to the first day of a past week, or back to today on the live week.
  useEffect(() => {
    if (weekDays.some(d => formatDateKey(d) === formatDateKey(selectedDay))) return
    if (weekOffset < 0) setSelectedDay(weekDays[0])
    else setSelectedDay(weekDays.find(d => isToday(d)) ?? weekDays[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekDays])

  const allTimeSlots = useMemo(() => {
    const { open, close } = getHoursForDate(settings, selectedDay)
    const slots: TimeSlot[] = []
    for (let h = open; h < close; h += 0.5) slots.push({ hour: h, label: formatTime(h) })
    return slots
  }, [selectedDay, settings])
  // COST-1b: pull ONLY the date range of the week strip the user is currently
  // viewing (L1 = rolling window, L2/customer = M–S release week, or a past week
  // under coach back-nav). Navigating weeks re-windows the subscription, so each
  // client holds ~7–8 days live instead of ~56. weekDays is ascending, so [0]..[last].
  const gridWindow = useMemo(() => ({
    from: formatDateKey(weekDays[0]),
    to: formatDateKey(weekDays[weekDays.length - 1]),
  }), [weekDays])
  const { bookings, canBookTime, bookingsLoading } = useBookings(gridWindow)
  const { isLaneBlocked } = useLaneBlocks()

  const [modalOpen, setModalOpen] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<{ lane: Lane; date: Date; startHour: number } | null>(null)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<{ type: 'book'; lane: Lane; slot: TimeSlot } | { type: 'waitlist'; hour: number } | null>(null)
  // SPEC_MOBILE_BOOKING_UPDATES §4 — the "waitlist mode" toggle is gone; the modal
  // is opened directly from a full row's JOIN WAITLIST band, pre-seeded with the hour.
  const [waitlistSelections, setWaitlistSelections] = useState<{ laneId: string; date: string; hour: number }[]>([])
  const [waitlistModalOpen, setWaitlistModalOpen] = useState(false)

  const dateKey = formatDateKey(selectedDay)

  // SPEC_COACH_CALENDAR §1D/§1E — past-session review for coaches.
  const ownerMatch = (b: Booking) =>
    !!user && ((b.customerEmail?.toLowerCase() === user.email?.toLowerCase()) || b.userId === user.id)
  const dayIsPast = useMemo(() => {
    const m = getAWSTNow(); m.setHours(0, 0, 0, 0)
    return selectedDay < m && !isToday(selectedDay)
  }, [selectedDay])
  // On a past day a coach reviews ONLY their own bookings (centre-wide data hidden),
  // read-only. On live/future days everyone sees the full grid as before.
  const reviewingPast = userIsCoach && dayIsPast
  const displayBookings = useMemo(
    () => (reviewingPast ? bookings.filter(ownerMatch) : bookings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reviewingPast, bookings, user]
  )
  // §1D — 3-colour allocation dots on the coach week strip (own coach bookings/day).
  const myBookingsByDay = useMemo(() => {
    const m = new Map<string, Booking[]>()
    if (!userIsCoach) return m
    for (const b of bookings) {
      if (b.status === 'cancelled' || !ownerMatch(b)) continue
      const arr = m.get(b.date) ?? []
      arr.push(b)
      m.set(b.date, arr)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings, userIsCoach, user])

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

  // SPEC_MOBILE_BOOKING_UPDATES §4.5 — PUBLIC waitlist data from Convex (the single
  // source of truth; the old local waitlist-store was removed). Counts only ACTIVE
  // waiters; the per-day positions power "You're #k in the queue".
  const waitlistRows = (useQuery(
    api.queries.listWaitlistByLaneDate,
    user ? { laneId: '*', date: dateKey } : 'skip'
  ) ?? []) as Array<{ hour: number; status?: string; isMine?: boolean }>
  const myWaitlistPositions = (useQuery(
    api.waitlist.myWaitlistDayPositions,
    user ? { date: dateKey } : 'skip'
  ) ?? {}) as Record<string, number>
  const waitlistByHour = useMemo(() => {
    const count = new Map<number, number>()
    const mine = new Set<number>()
    for (const r of waitlistRows) {
      const st = r.status ?? 'waiting'
      if (st !== 'waiting' && st !== 'offered') continue
      count.set(r.hour, (count.get(r.hour) ?? 0) + 1)
      if (r.isMine) mine.add(r.hour)
    }
    return { count, mine }
  }, [waitlistRows])

  // The full-row JOIN WAITLIST label is centred on the part of the matrix that is
  // actually ON SCREEN (the grid scrolls horizontally on mobile), and auto-tracks
  // the visible lane area as the user scrolls sideways — so the full text is always
  // readable instead of sitting off-screen in the middle of the 5-lane band.
  const TIME_COL_W = 70
  const gridScrollRef = useRef<HTMLDivElement>(null)
  const [waitlistLabelX, setWaitlistLabelX] = useState(0)
  useEffect(() => {
    const el = gridScrollRef.current
    if (!el) return
    const update = () => {
      const bandW = el.scrollWidth - TIME_COL_W
      if (bandW <= 0) return
      const half = Math.min(120, bandW / 2)
      let c = el.scrollLeft + (el.clientWidth + TIME_COL_W) / 2 - TIME_COL_W
      c = Math.max(half, Math.min(bandW - half, c))
      setWaitlistLabelX(c)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      ro?.disconnect()
    }
  }, [dateKey])

  const laneActiveHalfHours = useMemo(() => {
    const map = new Map<string, Set<number>>()
    for (const lane of LANES) map.set(lane.id, getActiveHalfHoursForLane(displayBookings, lane.id, dateKey))
    return map
  }, [displayBookings, dateKey])

  // Valid start times for coaches on the selected day (whole hours + weekday
  // half-hours 7:30am–3:30pm + L1 6:30am). Defined here (before visibleTimeSlots)
  // so the row filter can show empty coach half-hour rows as bookable.
  const validCoachStartsForDay = useMemo(
    () => (userIsCoach ? getValidCoachStartTimes(selectedDay, coachTierNorm) : []),
    [userIsCoach, selectedDay, coachTierNorm]
  )

  const visibleTimeSlots = useMemo(() => {
    const base = allTimeSlots.filter(slot => {
      if (slot.hour === Math.floor(slot.hour)) return true
      // SPEC_MOBILE_BOOKING_UPDATES §7.1 — 3:30pm is a COACH-ONLY start row (all tiers,
      // weekdays). Never shown to customers as an empty bookable start. BUT
      // (SPEC_30MIN_GAP_FILL) if a coach booking actually OCCUPIES 3:30, show the row to
      // customers so it renders as "Booked" — making the 3:00–3:30 gap-fill read
      // correctly. Empty 3:30 cells on other lanes still render as inactive "–", never a
      // "+", so no bookable 3:30 start leaks.
      // Coach weekday half-hour starts (7:30am–3:30pm) are bookable start rows for
      // coaches — show them empty so the coach can pick the slot. (Generalises the
      // old 3:30pm-only rule.) Customers never see them empty; from 4pm onwards
      // there are no coach half-hour starts, so those rows stay hidden unless occupied.
      if (userIsCoach && validCoachStartsForDay.includes(slot.hour)) return true
      // Other half-hours: show if any lane is active there (e.g. a 30-min coach slot,
      // or a customer 30-min gap-fill rendering as "Booked").
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
  }, [allTimeSlots, laneActiveHalfHours, userIsCoach, isL1Coach, selectedDay, validCoachStartsForDay])

  const laneStartTimes = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const lane of LANES) map.set(lane.id, getAvailableStartTimes(displayBookings, lane.id, dateKey))
    return map
  }, [displayBookings, dateKey])

  const handleSlotClick = (lane: Lane, slot: TimeSlot) => {
    if (isPast(selectedDay, slot.hour)) return
    if (isSelectedDayClosed) return // facility closed — booking blocked (server also rejects)
    const booked = isSlotBooked(bookings, lane.id, dateKey, slot.hour)
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
    // SPEC_ANALYTICS_BUILD_2026-06 C2.5 — a slot selection starts a fresh booking
    // attempt (new flowId); the funnel ladder is reconstructed per flow. Customer
    // flows only (coaches/admin skip payment → would skew the checkout funnel).
    if (!isAdmin && !userIsCoach) {
      startBookingFlow()
      trackFunnelStep('slot_select', { laneId: lane.id, date: dateKey, hour: slot.hour })
    }
    setSelectedSlot({ lane, date: selectedDay, startHour: slot.hour })
    setModalOpen(true)
  }

  // §4.2 — open the waitlist modal for a full row, pre-seeded with this hour. The
  // modal lets the user add the day's other full hours in one confirm (§4.3).
  const openWaitlistForHour = (hour: number) => {
    if (!user) { setPendingAction({ type: 'waitlist', hour }); setAuthModalOpen(true); return }
    setWaitlistSelections([{ laneId: '*', date: dateKey, hour }])
    setWaitlistModalOpen(true)
  }

  // Check if ALL lanes are booked/unavailable at this hour (so we can offer waitlist)
  const isTimeSlotFullyBooked = (date: string, hour: number) => {
    return LANES.every(lane => {
      const laneActiveSet = laneActiveHalfHours.get(lane.id) ?? new Set()
      const isHalf = hour !== Math.floor(hour)
      const booked = isSlotBooked(displayBookings, lane.id, date, hour)
      if (booked) return true
      if (isHalf && !laneActiveSet.has(hour)) return true // lane inactive at this half-hour
      return false
    })
  }

  // FEB-3 (audit 2026-06): getCustomerDurations is O(slots×5×bookings) and was called
  // PER grid cell on EVERY render (scroll, hover, the 1 Hz release tick, waitlist
  // state…). Precompute it once per [bookings, day, slots, settings] change into a
  // lane→hour→durations map; cells just look up. Pure function → identical values.
  const custByLaneHour = useMemo(() => {
    const m = new Map<string, Map<number, number[]>>()
    for (const lane of LANES) {
      const inner = new Map<number, number[]>()
      for (const s of visibleTimeSlots) inner.set(s.hour, getCustomerDurations(displayBookings, lane.id, dateKey, s.hour))
      m.set(lane.id, inner)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayBookings, dateKey, visibleTimeSlots, settings])

  // FEB-4: isTimeSlotFullyBooked (a 5-lane scan) was recomputed per cell for the
  // full-row check + the waitlist-band probe. Memoize once per row.
  const fullyBookedByHour = useMemo(() => {
    const m = new Map<number, boolean>()
    for (const s of visibleTimeSlots) m.set(s.hour, isTimeSlotFullyBooked(dateKey, s.hour))
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTimeSlots, dateKey, displayBookings, laneActiveHalfHours])

  // Whole-hour rows the CURRENT user's OWN (non-cancelled) booking occupies on this
  // day. A fully-booked row is normally collapsed into a single JOIN WAITLIST band
  // for customers — but if the customer OWNS a slot on that row, the band hides their
  // own booking entirely. (The renderBlockHere rescue below only re-anchors a booking
  // that SPILLS into a non-band row; a booking whose rows are ALL full had nowhere to
  // anchor → invisible.) So a row the user owns is NEVER banded — it renders per-lane,
  // showing their blue "Your booking" beside the other booked lanes. Matches the
  // whole-hour semantics of isSlotBooked (hour h booked iff start ≤ h < end).
  const myBookedHoursToday = useMemo(() => {
    const s = new Set<number>()
    if (!user || isAdmin) return s
    for (const b of displayBookings) {
      if (b.date !== dateKey || b.status === 'cancelled' || !ownerMatch(b)) continue
      const end = b.startHour + b.duration / 60
      for (let h = Math.floor(b.startHour); h < end; h++) if (h >= b.startHour) s.add(h)
    }
    return s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayBookings, dateKey, user, isAdmin])

  const handleAuthSuccess = () => {
    setAuthModalOpen(false)
    if (pendingAction?.type === 'book') {
      if (!isAdmin && !userIsCoach) {
        startBookingFlow()
        trackFunnelStep('slot_select', { laneId: pendingAction.lane.id, date: dateKey, hour: pendingAction.slot.hour })
      }
      setSelectedSlot({ lane: pendingAction.lane, date: selectedDay, startHour: pendingAction.slot.hour })
      setModalOpen(true)
    } else if (pendingAction?.type === 'waitlist') {
      setWaitlistSelections([{ laneId: '*', date: dateKey, hour: pendingAction.hour }])
      setWaitlistModalOpen(true)
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

  // Other full/waitlistable hours on this day (for the modal's multi-hour join, §4.3).
  const fullHoursToday = useMemo(
    () => visibleTimeSlots
      .filter(s => !isPast(selectedDay, s.hour) && !isSelectedDayClosed && isTimeSlotFullyBooked(dateKey, s.hour))
      .map(s => s.hour),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleTimeSlots, selectedDay, isSelectedDayClosed, dateKey, bookings, laneActiveHalfHours]
  )

  // SPEC_PUSH_NOTIFICATIONS_V2 §5/§8 + MOBILE §4.6 — handle waitlist push deep-links:
  //   ?book=<lane>&date=<d>&hour=<h>(&wl=1) → open the held slot's booking (checkout)
  //   ?wlDecline=<lane>&date=<d>&hour=<h>   → pass the offer to the next person
  const declineWaitlistOffer = useMutation(api.waitlist.declineWaitlistOffer)
  const [deepLinkHandled, setDeepLinkHandled] = useState(false)
  useEffect(() => {
    if (deepLinkHandled || typeof window === 'undefined') return
    const p = new URLSearchParams(window.location.search)
    const cleanUrl = () => window.history.replaceState({}, '', window.location.pathname)
    const declineLane = p.get('wlDecline')
    const bookLane = p.get('book')
    const dateP = p.get('date')
    const hourP = p.get('hour')
    if (declineLane && dateP && hourP) {
      setDeepLinkHandled(true)
      declineWaitlistOffer({ laneId: declineLane, date: dateP, hour: Number(hourP) }).catch(() => {})
      cleanUrl()
      return
    }
    if (bookLane && dateP && hourP && user) {
      setDeepLinkHandled(true)
      const lane = LANES.find(l => l.id === bookLane)
      const match = weekDays.find(d => formatDateKey(d) === dateP)
      if (lane && match) {
        setSelectedDay(match)
        setSelectedSlot({ lane, date: match, startHour: Number(hourP) })
        setModalOpen(true)
      }
      cleanUrl()
    }
  }, [deepLinkHandled, user, weekDays, declineWaitlistOffer])

  // SPEC_ANALYTICS_BUILD_2026-06 C2.5 — top-of-funnel engagement signal (one per
  // calendar mount), counted above the per-attempt conversion ladder.
  useEffect(() => { trackEvent('calendar_open') }, [])

  // Determine header label
  const nextWeekOpen = !isL1Coach && isNextWeekOpen(releaseRole, coachTierNorm, settings)
  const headerLabel = isL1Coach
    ? `📅 Next ${coachWindowDays} Days (Rolling)`
    : nextWeekOpen ? '📅 This Week + Next Week' : '📅 This Week'

  return (
    <div className="space-y-6">
      {/* Weekly-release banner (customers + L2 coaches only) */}
      {!isL1Coach && (
        <ReleaseBanner role={releaseRole} tier={coachTierNorm} settings={settings} nextWeekOpen={nextWeekOpen} lastDay={weekDays[weekDays.length - 1]} />
      )}
      {/* Week Day Selector */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm">
        {/* §2 — hide the "This Week"/month chrome on mobile; keep the day strip below. */}
        <div className="hidden sm:flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-800">{headerLabel}</h2>
          <div className="flex items-center gap-2">
            {userIsCoach && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${coachTierNorm === 'L2' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>🏅 {coachTierNorm === 'L2' ? 'L2 Coach' : 'L1 Coach'}</span>
            )}
            <span className="text-sm text-gray-500">{weekDays[0].toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} &middot; AWST</span>
          </div>
        </div>
        {/* §1E — coach back/forward week navigation (read-only review of past weeks). */}
        {userIsCoach && (
          <div className="flex items-center justify-between mb-3">
            <button type="button" onClick={() => setWeekOffset((o) => Math.max(-2, o - 1))} disabled={weekOffset <= -2}
              className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${weekOffset <= -2 ? 'border-gray-200 text-gray-300 cursor-not-allowed' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>← Prev week</button>
            <span className="text-[11px] font-medium text-gray-500">{weekOffset === 0 ? 'This week' : weekOffset === -1 ? 'Last week' : `${-weekOffset} weeks ago`}</span>
            <button type="button" onClick={() => setWeekOffset((o) => Math.min(0, o + 1))} disabled={weekOffset >= 0}
              className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${weekOffset >= 0 ? 'border-gray-200 text-gray-300 cursor-not-allowed' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>Next week →</button>
          </div>
        )}
        <div className={`grid ${weekDays.length === 8 ? 'grid-cols-8' : 'grid-cols-7'} gap-2`}>
          {weekDays.map((day) => {
            const active = formatDateKey(day) === formatDateKey(selectedDay)
            const today = isToday(day)
            const awstNow = getAWSTNow()
            awstNow.setHours(0, 0, 0, 0)
            const pastDay = day < awstNow && !today
            const dk = formatDateKey(day)
            const hasOverride = laneConfig.overrides.some((o) => dk >= o.startDate && dk <= o.endDate)
            // §1E — coaches may open past days (read-only review); customers cannot.
            const dayDisabled = pastDay && !userIsCoach
            // §1D — coach allocation dot for that day's OWN coach bookings.
            const allocDot = userIsCoach ? dayDotState(myBookingsByDay.get(dk) ?? [], true) : null
            return (
              <button key={formatDateKey(day)} onClick={() => setSelectedDay(day)} disabled={dayDisabled}
                className={`relative flex flex-col items-center py-2.5 px-1 rounded-xl transition-all duration-200 text-center ${active ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 scale-105' : dayDisabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : pastDay ? 'bg-gray-100 text-gray-500 hover:bg-emerald-50 cursor-pointer' : 'bg-gray-50 text-gray-700 hover:bg-emerald-50 cursor-pointer'}`}>
                {hasOverride && <span title="Custom lane layout" className="absolute top-1 right-1 text-[9px] leading-none text-amber-500">⚙</span>}
                <span className={`text-xs font-medium ${active ? 'text-emerald-100' : 'text-gray-500'}`}>{formatDayLabel(day)}</span>
                <span className={`text-lg font-bold mt-0.5 ${active ? 'text-white' : ''}`}>{day.getDate()}</span>
                {allocDot ? (
                  <div className={`w-1.5 h-1.5 rounded-full mt-1 ${allocDot === 'green' ? 'bg-emerald-400' : allocDot === 'amber' ? 'bg-amber-400' : 'bg-red-500'}`} />
                ) : today ? (
                  <div className={`w-1.5 h-1.5 rounded-full mt-1 ${active ? 'bg-white' : 'bg-emerald-500'}`} />
                ) : null}
              </button>
            )
          })}
        </div>
        {/* §1D — dot key (coach only). */}
        {userIsCoach && (
          <div className="flex items-center gap-3 flex-wrap text-[10px] text-gray-500 mt-2.5">
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />Fully allocated</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />Partly</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />Needs athletes</span>
          </div>
        )}
      </div>

      {/* §1E — read-only review banner when a coach opens a past day. */}
      {reviewingPast && (
        <div className="bg-gray-100 border border-gray-300 rounded-2xl px-4 py-2.5 flex items-center gap-2">
          <span className="text-base">🕓</span>
          <p className="text-sm font-medium text-gray-600">Reviewing past sessions — read only. Showing your bookings only.</p>
        </div>
      )}

      {/* Date Header + Legend — DESKTOP ONLY. On mobile the full date and the
          legends are removed entirely (the selected day is obvious from the day
          strip above, and the grid gets the full height). */}
      <div className="hidden sm:block">
        <h3 className="text-xl font-bold text-gray-800">{selectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
        <p className="text-sm text-gray-500 mt-0.5">{isToday(selectedDay) ? '🟢 Today' : formatDayLabel(selectedDay)} &middot; {formatTime(getHoursForDate(settings, selectedDay).open)} - {formatTime(getHoursForDate(settings, selectedDay).close)} AWST &middot; 5 Lanes</p>
      </div>
      <div className="hidden sm:block space-y-3">
        <LegendRow />
        <LaneLegend />
      </div>

      {/* Calendar Grid */}
      {/* Frozen lane-header row (top) + frozen Time column (left) so they stay
          visible while scrolling the grid on mobile. The grid scrolls inside this
          bounded box (both axes) rather than the whole page. */}
      {/* §5 — the grid scrolls INSIDE this bounded box so the frozen lane-header row
          (sticky top-0 below) stays locked. On mobile the cap is tighter (60dvh) so
          the grid actually overflows the box and scrolls internally instead of the
          whole page scrolling the header away. Desktop keeps the taller 72vh. */}
      <div className="relative">
      {/* Hold the grid back behind a spinner until the FIRST booking data arrives,
          so users never see a momentarily-empty calendar (all booked slots would
          otherwise flash as available). Once loaded, Convex keeps it live-updated. */}
      {bookingsLoading && (
        <div className="absolute inset-0 z-50 rounded-2xl bg-white/95 flex flex-col items-center justify-center gap-2">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Loading bookings…</span>
        </div>
      )}
      <div ref={gridScrollRef} className="bg-white rounded-2xl border-2 border-black shadow-sm overflow-auto max-h-[60dvh] sm:max-h-[72vh]">
        <div className="min-w-0 sm:min-w-[560px]">
        <div className="grid grid-cols-[48px_repeat(5,minmax(0,1fr))] sm:grid-cols-[70px_repeat(5,1fr)] border-b-2 border-black bg-white sticky top-0 z-30">
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
            const rowPast = isPast(selectedDay, slot.hour)
            // §4.2 — a fully-booked row becomes a single amber JOIN WAITLIST band for
            // regular customers (admins/coaches keep the per-lane booking view).
            // SPEC_30MIN_GAP_FILL: NEVER on a half-hour row (e.g. 3:30) — those only
            // appear to show a coach booking that occupies them; the other lanes are
            // merely "inactive" there, not bookable, so offering a waitlist for a time we
            // don't normally sell is confusing. Half-hour rows always render per-lane (so
            // the coach booking shows as "Booked" and empty cells stay blank).
            const rowFull = !rowPast && !isSelectedDayClosed && (fullyBookedByHour.get(slot.hour) ?? false)
            // Never collapse a full row into the waitlist band if the user owns a
            // booking on this hour — render per-lane so their "Your booking" shows
            // (they don't need a waitlist for an hour they're already booked into).
            const showWaitlistBand = rowFull && !isAdmin && !userIsCoach && !isHalfHour && !myBookedHoursToday.has(slot.hour)
            const hourWaitCount = waitlistByHour.count.get(slot.hour) ?? 0
            const myQueuePos = myWaitlistPositions[String(slot.hour)]
            const onThisHour = waitlistByHour.mine.has(slot.hour) || myQueuePos != null
            return (
              <div key={slot.hour} className={`grid grid-cols-[48px_repeat(5,minmax(0,1fr))] sm:grid-cols-[70px_repeat(5,1fr)] ${slotIdx < visibleTimeSlots.length - 1 ? `border-b ${isHalfHour ? 'border-gray-300' : 'border-black'}` : ''}`}>
                <div className="p-1 sm:p-1.5 flex items-center justify-center sticky left-0 z-20 bg-white">
                  <span className={`text-[10px] sm:text-[11px] font-medium text-gray-500 ${isHalfHour ? 'opacity-60' : ''}`}>{slot.label}</span>
                </div>
                {showWaitlistBand ? (
                  <button type="button" onClick={() => { if (!onThisHour) openWaitlistForHour(slot.hour) }}
                    className={`relative z-30 col-span-5 border-l-2 border-black min-h-[40px] transition-colors ${onThisHour ? 'bg-amber-100 cursor-default' : 'bg-amber-50 hover:bg-amber-100 cursor-pointer'}`}>
                    {/* Absolutely positioned + centred on the visible lane area (waitlistLabelX),
                        so it tracks horizontal scroll and stays fully readable on mobile. */}
                    <span
                      style={{ left: waitlistLabelX }}
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-semibold text-amber-700 pointer-events-none">
                      {onThisHour ? (
                        <>✓ You're #{myQueuePos ?? '—'} in the queue · {hourWaitCount} waiting</>
                      ) : (
                        <>🔔 JOIN WAITLIST · {hourWaitCount > 0 ? `${hourWaitCount} ${hourWaitCount === 1 ? 'person' : 'people'} waiting` : 'Be first on the waitlist'}</>
                      )}
                    </span>
                  </button>
                ) : (
                <>
                {LANES.map((lane) => {
                  const laneActiveSet = laneActiveHalfHours.get(lane.id) ?? new Set()
                  const booked = isSlotBooked(displayBookings, lane.id, dateKey, slot.hour)
                  const blocked = !booked ? isLaneBlocked(lane.id, dateKey, slot.hour) : null
                  const past = isPast(selectedDay, slot.hour)
                  // A half-hour cell is "inactive" (renders "–") unless a booking is
                  // active there — EXCEPT a coach valid half-hour start (e.g. weekday
                  // 7:30am–3:30pm), which must render as a bookable "+" for coaches.
                  const isCoachHalfStart = userIsCoach && validCoachStartsForDay.includes(slot.hour)
                  const isLaneInactiveAtHalfHour = isHalfHour && !laneActiveSet.has(slot.hour) && !booked && !blocked && !isCoachHalfStart
                  // SPEC_RECONFIGURABLE_LANES: per-segment colour band + band-start tag
                  const band = bandClassForSlot(lane.id, dateKey, slot.hour)
                  const bs = bandStart(lane.id, dateKey, slot.hour)

                  const isStartOfBooking = booked && Math.abs(booked.startHour - slot.hour) < 0.01
                  const isMiddleOfBooking = booked && !isStartOfBooking
                  // A fully-booked whole-hour row renders as a single JOIN WAITLIST band
                  // INSTEAD of per-lane cells, so a booking whose true start row is that band
                  // never renders its "Booked" block there → its continuation rows below look
                  // empty. Anchor the block at the booking's FIRST visible row that is NOT a
                  // band, so it always shows.
                  const bookingEndHour = booked ? booked.startHour + booked.duration / 60 : 0
                  const isWaitlistBandRow = (h: number) =>
                    !isAdmin && !userIsCoach && h === Math.floor(h) &&
                    !isPast(selectedDay, h) && !isSelectedDayClosed && (fullyBookedByHour.get(h) ?? false) &&
                    !myBookedHoursToday.has(h)
                  let renderBlockHere = false
                  if (booked) {
                    for (const vs of visibleTimeSlots) {
                      if (vs.hour >= booked.startHour && vs.hour < bookingEndHour && !isWaitlistBandRow(vs.hour)) {
                        renderBlockHere = Math.abs(vs.hour - slot.hour) < 0.01
                        break
                      }
                    }
                  }
                  const validStarts = laneStartTimes.get(lane.id) ?? []
                  const isValidStart = validStarts.includes(slot.hour) || (userIsCoach && validCoachStartsForDay.includes(slot.hour)) || isAdmin
                  // SPEC_30MIN_GAP_FILL: resolve the customer durations once. A slot whose ONLY
                  // option is [30] is an unavoidable 30-min gap (before a half-hour coach booking
                  // or against closing) — render it distinctly so it reads as a short slot, not a
                  // normal hour. Computed once and reused by canBook/hasDurations below.
                  const custDurations = !isSelectedDayClosed && !past && !booked && isValidStart ? (custByLaneHour.get(lane.id)?.get(slot.hour) ?? []) : []
                  const isGapFillSlot = !userIsCoach && !isAdmin && custDurations.length === 1 && custDurations[0] === 30
                  // Probe the 30-min minimum unit (not a full hour) so a valid 30-min gap-fill
                  // slot is bookable. The real gating is isValidStart + hasDurations (which only
                  // expose a 30-min slot for an unavoidable gap); this is just the space check.
                  const canBook = !isSelectedDayClosed && !past && !booked && !blocked && isValidStart && canBookSlot(displayBookings, lane.id, dateKey, slot.hour, 30)
                  const hasDurations = !isSelectedDayClosed && !past && !booked && isValidStart ? custDurations.length > 0 || (userIsCoach && validCoachStartsForDay.includes(slot.hour)) || isAdmin : false
                  const timeCheck = canBookTime(dateKey, slot.hour)
                  const tooLate = !past && !booked && !timeCheck.allowed

                  const getBookingVisualHeight = () => {
                    if (!booked || !renderBlockHere) return 0
                    // Span from the anchor row (slot.hour) — not the true start, which may be
                    // an earlier hidden band row — down to the booking end.
                    let count = 0
                    for (const vs of visibleTimeSlots) { if (vs.hour >= slot.hour && vs.hour < bookingEndHour) count++ }
                    return count
                  }
                  const visualSpan = getBookingVisualHeight()

                  // §1A/§1B: BLUE allocation coverage on the coach's OWN coach bookings.
                  const ownCoachBooking = !!booked && !!booked.isCoachBooking && !!userIsCoach && !!user && (
                    (booked.customerEmail?.toLowerCase() === user.email?.toLowerCase()) || booked.userId === user.id
                  )
                  // §1F — compact ↻ Repeat sits on the coach's OWN COMPLETED sessions in
                  // the LIVE week only (never on back-nav past weeks).
                  const sessionEnded = !!booked && isPast(selectedDay, booked.startHour + booked.duration / 60)
                  const canRepeatHere = !!booked && ownCoachBooking && isStartOfBooking && weekOffset === 0 && sessionEnded && booked.status !== 'cancelled'
                  // SPEC_MOBILE_BOOKING_UPDATES §3 — the user's OWN (non-coach) booking
                  // renders BLUE "Your booking" so they spot it instantly. Precedence:
                  // admin-name view → own-coach coverage → own → booked.
                  const isOwnBooking = !!booked && !!user && !isAdmin && !ownCoachBooking && !booked.isCoachBooking && (
                    (booked.customerEmail?.toLowerCase() === user.email?.toLowerCase()) || booked.userId === user.id
                  )
                  const useBlueBlock = isOwnBooking
                  // SPEC_CHECKOUT_ABANDONMENT — the owner's OWN unpaid booking shows
                  // amber "Awaiting payment", never a plain "Booked" (others still
                  // see it held as red — it's a real hold until it auto-cancels).
                  const isOwnPending = isOwnBooking && booked?.status === 'pending_payment'

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
                      className={`relative border-l-2 border-black min-h-[32px] transition-all duration-150 ${past ? 'bg-gray-200' : booked ? '' : tooLate ? 'bg-gray-200' : canBook && hasDurations ? 'bg-emerald-50 hover:bg-emerald-100 cursor-pointer group' : band}`}
                      onClick={() => {
                        if (past || isLaneInactiveAtHalfHour) return
                        if (!booked && canBook && hasDurations && timeCheck.allowed) handleSlotClick(lane, slot)
                      }}>
                      {!booked && !past && bs.isStart && bs.multi && (
                        <div className="absolute top-0 left-0 z-[5] text-[7px] leading-tight font-semibold text-gray-600 bg-white/70 rounded-br px-1 py-0.5 pointer-events-none max-w-full truncate">
                          {bandTagText(lane.id, dateKey, bs.seg)}
                        </div>
                      )}
                      {renderBlockHere && booked && ownCoachBooking && (
                        <div className="absolute inset-x-0.5 top-0.5 z-10 rounded-md overflow-hidden border border-blue-300"
                          style={{ height: `${visualSpan * 32 - 4}px` }}>
                          <CoachCalendarBlock booking={booked} heightPx={visualSpan * 32 - 4} />
                          {canRepeatHere && (
                            <div className="absolute bottom-0.5 right-0.5 z-20" onClick={(e) => e.stopPropagation()}>
                              <RepeatBookingButton booking={booked} compact />
                            </div>
                          )}
                        </div>
                      )}
                      {renderBlockHere && booked && !ownCoachBooking && (
                        <div className={`absolute inset-x-0.5 top-0.5 z-10 rounded-md px-1.5 py-1 border ${isOwnPending ? 'bg-gradient-to-br from-amber-100 to-amber-50 border-amber-300' : useBlueBlock ? 'bg-gradient-to-br from-blue-100 to-blue-50 border-blue-200' : 'bg-gradient-to-br from-red-100 to-red-50 border-red-200'}`}
                          style={{ height: `${visualSpan * 32 - 4}px` }}>
                          <div className={`text-[9px] font-semibold truncate ${isOwnPending ? 'text-amber-700' : useBlueBlock ? 'text-blue-700' : 'text-red-700'}`}>
                            {isOwnPending ? '⏳ Awaiting payment' : isAdmin ? booked.customerName : isOwnBooking ? 'Your booking' : 'Booked'}
                            {booked.status === 'cancelled' && <span className="ml-1 text-orange-500">(cancelled)</span>}
                          </div>
                          <div className={`text-[8px] ${isOwnPending ? 'text-amber-600' : useBlueBlock ? 'text-blue-500' : 'text-red-500'}`}>
                            {formatTime(booked.startHour)}-{formatTime(booked.startHour + booked.duration / 60)}
                            {isAdmin && booked.isCoachBooking && <span className="ml-1 text-orange-500">🏅</span>}
                          </div>
                        </div>
                      )}
                      {isMiddleOfBooking && !renderBlockHere && <div className={`absolute inset-0 ${useBlueBlock ? 'bg-blue-50/30' : 'bg-red-50/30'}`} />}
                      {past && !booked && <div className="absolute inset-0 flex items-center justify-center pointer-events-none"><span className="text-[14px] leading-none text-gray-400 font-medium">–</span></div>}
                      {tooLate && !booked && <div className="absolute inset-0 flex items-center justify-center"><span className="text-[8px] text-gray-400">Too late</span></div>}
                      {canBook && hasDurations && !booked && !past && !tooLate && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          {isGapFillSlot ? (
                            <span className="px-1 py-0.5 rounded border border-emerald-400 text-emerald-600 text-[8px] font-semibold leading-none group-hover:bg-emerald-100 transition-colors">30 min</span>
                          ) : (
                            <span className="text-[15px] leading-none text-emerald-400 font-semibold group-hover:text-emerald-600 transition-colors">+</span>
                          )}
                        </div>
                      )}
                      {!past && !booked && canBook && hasDurations && timeCheck.allowed && (
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <div className="flex items-center gap-0.5 bg-emerald-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full shadow-lg shadow-emerald-500/30"><span>+</span><span>Book</span></div>
                        </div>
                      )}
                    </div>
                  )
                })}
                </>
                )}
              </div>
            )
          })}
        </div>
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
        <WaitlistModal selectedSlots={waitlistSelections} availableHours={fullHoursToday} date={dateKey}
          onClose={() => setWaitlistModalOpen(false)}
          onSuccess={() => { setWaitlistModalOpen(false); setWaitlistSelections([]) }} />
      )}
    </div>
  )
}

// Status legend (SPEC_MOBILE_BOOKING_UPDATES §3 adds the blue "Your booking").
function LegendRow() {
  const item = (cls: string, label: string) => (
    <div className="flex items-center gap-1.5"><div className={`w-3 h-3 rounded ${cls}`} /><span className="text-gray-600">{label}</span></div>
  )
  return (
    <div className="flex items-center gap-4 text-xs flex-wrap">
      {item('bg-emerald-100 border border-emerald-300', 'Available')}
      {item('bg-red-100 border border-red-300', 'Booked')}
      {item('bg-blue-100 border border-blue-300', 'Your booking')}
      {item('bg-amber-100 border border-amber-300', 'Waitlist')}
      {item('bg-gray-200 border border-gray-300', 'Past')}
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
  // FEB-7 (audit 2026-06): keep the countdown live, but tick every SECOND only while a
  // sub-day countdown (seconds visible) is actually shown. Otherwise — d/h/m display, or
  // the banner rendering null because release is beyond the visibility window — tick
  // every 30 s, so this isn't a forever 1 Hz re-render for nothing.
  const [, setTick] = useState(0)
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>
    const schedule = () => {
      const release = getNextReleaseDate(role, tier, settings)
      const totalSec = Math.max(0, Math.floor((release.getTime() - getAWSTNow().getTime()) / 1000))
      const visibleWithinSec = (settings.releaseCountdownHours ?? 24) * 3600
      const showsSeconds = !nextWeekOpen && totalSec <= visibleWithinSec && totalSec < 86400
      id = setTimeout(() => { setTick((t) => t + 1); schedule() }, showsSeconds ? 1000 : 30000)
    }
    schedule()
    return () => clearTimeout(id)
  }, [role, tier, settings, nextWeekOpen])

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
