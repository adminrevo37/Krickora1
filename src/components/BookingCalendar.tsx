import { useState, useMemo, useEffect } from 'react'
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
  isLaneCustomStart,
  isCoachEdgeStart,
  isWeekday,
  type Booking,
  type Lane,
  type TimeSlot,
} from '../lib/booking-data'
import { getHoursForDate } from '../lib/settings-store'
import { useLaneConfigState } from '../hooks/useLaneConfig'
import { LaneHeaderInner, LaneLegend, bandClassForSlot, bandStart, bandTagText } from './laneDisplay'
import { getDaySegments, resolveSegment, segmentIsClosed, segmentHasCustomStarts, segmentStartHours, resolveLaneAt } from '../lib/lanes'
import { CoachCalendarBlock } from './CoverageTimeline'
import { dayDotState } from '../lib/coverage'
import RepeatBookingButton from './RepeatBookingButton'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useBookings } from '../hooks/useBookingStore'
import { useLaneBlocks } from '../hooks/useLaneBlocks'
import { useAuth } from '../hooks/useAuth'
import { getErrorMessage } from '../lib/errors'
import ModalShell from './ModalShell'
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
  // When an admin is "viewing as" a COACH, still mark THAT coach's own coach
  // bookings as their blue coverage block (not an anonymous "Booked"), and don't
  // collapse full rows into the JOIN WAITLIST band (coaches never see it) — so the
  // admin can actually see the coach's schedule. (useAuth overrides user.email/role
  // to the viewed account during impersonation, so ownCoachBooking's own-match still
  // scopes this to the viewed coach.) We deliberately do NOT flip the rest of the grid
  // into coach-view mode (start-time grid / release window / tier resolution) during
  // impersonation — only the own-booking marking. Outside impersonation = userIsCoach.
  const renderAsCoachOwner = impersonatedEmail ? ((user?.role as string) === 'coach') : userIsCoach
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
  const [pendingAction, setPendingAction] = useState<{ type: 'book'; lane: Lane; slot: TimeSlot } | { type: 'waitlist'; hour: number; pool: 'bm' | 'ru' } | null>(null)
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

  // SPEC_WAITLIST_SPLIT_BM_RU — the waitlist is split into BM / RU pools keyed
  // by each lane's MODE at (date, hour). PUBLIC waitlist data from Convex: rows
  // across the pool sentinels ('*bm' / '*ru' / legacy '*'); counts only ACTIVE
  // waiters, per hour PER POOL (a legacy '*' row counts toward both pools). The
  // per-day positions power "#k in the queue" per pool band.
  const waitlistRows = (useQuery(
    api.queries.listWaitlistPoolsByDate,
    user ? { date: dateKey } : 'skip'
  ) ?? []) as Array<{ laneId: string; hour: number; status?: string; isMine?: boolean }>
  const myWaitlistPositions = (useQuery(
    api.waitlist.myWaitlistDayPoolPositions,
    user ? { date: dateKey } : 'skip'
  ) ?? {}) as Record<string, { bm?: number; ru?: number }>
  const waitlistByHour = useMemo(() => {
    const count = { bm: new Map<number, number>(), ru: new Map<number, number>() }
    const mine = { bm: new Set<number>(), ru: new Set<number>() }
    for (const r of waitlistRows) {
      const st = r.status ?? 'waiting'
      if (st !== 'waiting' && st !== 'offered') continue
      const pools: Array<'bm' | 'ru'> =
        r.laneId === '*bm' ? ['bm'] : r.laneId === '*ru' ? ['ru'] : ['bm', 'ru']
      for (const p of pools) {
        count[p].set(r.hour, (count[p].get(r.hour) ?? 0) + 1)
        if (r.isMine) mine[p].add(r.hour)
      }
    }
    return { count, mine }
  }, [waitlistRows])

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

  // SPEC_LANE_SEGMENT_BOOKING_TIMES — half-hour rows introduced by the lane layout
  // (a segment boundary on the half-hour, or a custom bookable start on the half-hour)
  // must appear as grid rows even with no booking there, so closed periods render and
  // offset bookable starts (e.g. 12:30) are reachable.
  const segmentHalfHours = useMemo(() => {
    const set = new Set<number>()
    for (const lane of LANES) {
      const { segments } = getDaySegments(lane.id, dateKey)
      for (const seg of segments) {
        if (seg.startHour !== Math.floor(seg.startHour)) set.add(seg.startHour)
        if (segmentHasCustomStarts(seg)) {
          for (const h of segmentStartHours(seg)) if (h !== Math.floor(h)) set.add(h)
        }
      }
    }
    return set
  }, [dateKey, laneConfig])

  const visibleTimeSlots = useMemo(() => {
    const base = allTimeSlots.filter(slot => {
      if (slot.hour === Math.floor(slot.hour)) return true
      // Layout-introduced half-hour rows (segment boundaries / offset custom starts).
      if (segmentHalfHours.has(slot.hour)) return true
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
  }, [allTimeSlots, laneActiveHalfHours, userIsCoach, isL1Coach, selectedDay, validCoachStartsForDay, segmentHalfHours])

  const laneStartTimes = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const lane of LANES) map.set(lane.id, getAvailableStartTimes(displayBookings, lane.id, dateKey))
    return map
    // laneConfig: getAvailableStartTimes reads the day's segments (closed / custom starts).
  }, [displayBookings, dateKey, laneConfig])

  const handleSlotClick = (lane: Lane, slot: TimeSlot) => {
    if (isPast(selectedDay, slot.hour)) return
    if (isSelectedDayClosed) return // facility closed — booking blocked (server also rejects)
    const booked = isSlotBooked(bookings, lane.id, dateKey, slot.hour)
    if (booked) return
    const timeCheck = canBookTime(dateKey, slot.hour)
    if (!timeCheck.allowed) return
    if (!isAdmin) {
      if (userIsCoach) {
        // Day-level coach starts OR a per-lane segment CUSTOM start (e.g. a
        // Saturday split offering 9:30/10:30/… — SPEC_LANE_SEGMENT_BOOKING_TIMES)
        // OR a booking-created / segment-opening half-hour edge (coach adjacency,
        // every day — 2026-08-11).
        if (
          !validCoachStartsForDay.includes(slot.hour) &&
          !isLaneCustomStart(lane.id, dateKey, slot.hour) &&
          !isCoachEdgeStart(displayBookings, lane.id, dateKey, slot.hour)
        ) return
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

  // §4.2 + SPEC_WAITLIST_SPLIT_BM_RU — open the waitlist modal for a full POOL
  // (BM or RU), pre-seeded with this hour. The modal lets the user add the day's
  // other full hours FOR THAT POOL in one confirm (§4.3).
  const [waitlistPool, setWaitlistPool] = useState<'bm' | 'ru'>('bm')
  const openWaitlistForHour = (hour: number, pool: 'bm' | 'ru') => {
    if (!user) { setPendingAction({ type: 'waitlist', hour, pool }); setAuthModalOpen(true); return }
    setWaitlistPool(pool)
    setWaitlistSelections([{ laneId: `*${pool}`, date: dateKey, hour }])
    setWaitlistModalOpen(true)
  }

  // SPEC_WAITLIST_SPLIT_BM_RU — a lane's pool at (date, hour), from the resolved
  // lane layout (override + intra-day-segment aware): a lane running as BM for
  // part of a day is BM-pool for exactly those hours. Closed segments are in
  // NEITHER pool (never bookable → never waitlistable).
  const lanePoolAt = (laneId: string, hour: number): 'bm' | 'ru' | null => {
    const seg = resolveSegment(getDaySegments(laneId, dateKey).segments, hour)
    if (segmentIsClosed(seg)) return null
    return seg.mode === 'RU' ? 'ru' : 'bm'
  }

  // A POOL is full at a whole hour when every one of its (non-closed) lanes has a
  // booking. Service-blocked lanes count as NOT booked — a blocked lane suppresses
  // its pool's band, matching the old whole-row behaviour.
  const isPoolFullAtHour = (hour: number, pool: 'bm' | 'ru') => {
    const poolLanes = LANES.filter(lane => lanePoolAt(lane.id, hour) === pool)
    if (poolLanes.length === 0) return false
    return poolLanes.every(lane => !!isSlotBooked(displayBookings, lane.id, dateKey, hour))
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
  }, [displayBookings, dateKey, visibleTimeSlots, settings, laneConfig])

  // FEB-4: pool fullness (a per-lane scan) is recomputed per cell for the band
  // probe otherwise. Memoize once per row per pool.
  const poolFullByHour = useMemo(() => {
    const m = new Map<number, { bm: boolean; ru: boolean }>()
    for (const s of visibleTimeSlots) {
      if (s.hour !== Math.floor(s.hour)) continue // bands are whole-hour only
      m.set(s.hour, { bm: isPoolFullAtHour(s.hour, 'bm'), ru: isPoolFullAtHour(s.hour, 'ru') })
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTimeSlots, dateKey, displayBookings, laneConfig])

  // Whole-hour rows + POOLS the CURRENT user's OWN (non-cancelled) booking occupies
  // on this day. A full pool is normally collapsed into a JOIN WAITLIST band for
  // customers — but if the customer OWNS a lane of that pool on that row, the band
  // would hide their own booking entirely. (The renderBlockHere rescue below only
  // re-anchors a booking that SPILLS into a non-band row; a booking whose rows are
  // ALL banded had nowhere to anchor → invisible.) So a pool the user owns a lane
  // in is NEVER banded on that hour — it renders per-lane, showing their blue
  // "Your booking" beside the other booked lanes. The OTHER pool can still band.
  const myBookedPoolHours = useMemo(() => {
    const m = new Map<number, Set<'bm' | 'ru'>>()
    if (!user || isAdmin) return m
    for (const b of displayBookings) {
      if (b.date !== dateKey || b.status === 'cancelled' || !ownerMatch(b)) continue
      const end = b.startHour + b.duration / 60
      const laneIds = [b.laneId, ...((b as any).additionalLaneIds ?? [])]
      for (let h = Math.floor(b.startHour); h < end; h++) {
        if (h < b.startHour) continue
        for (const lid of laneIds) {
          const p = lanePoolAt(lid, h)
          if (!p) continue
          const set = m.get(h) ?? new Set<'bm' | 'ru'>()
          set.add(p)
          m.set(h, set)
        }
      }
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayBookings, dateKey, user, isAdmin, laneConfig])

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
      setWaitlistPool(pendingAction.pool)
      setWaitlistSelections([{ laneId: `*${pendingAction.pool}`, date: dateKey, hour: pendingAction.hour }])
      setWaitlistModalOpen(true)
    }
    setPendingAction(null)
  }

  const handleBookingConfirm = async (booking: Booking) => {
    // SPEC_WAITLIST_ALT_TIME_OFFER_2026-08 — the booking landed, so close the offer
    // to the other recipients and honour their choice about the original queue
    // entry. Best-effort: the booking itself is already made and the server
    // validated availability, so a failure here only leaves a stale-looking offer
    // that the liveness check will kill anyway.
    if (acceptingOffer) {
      const a = acceptingOffer
      setAcceptingOffer(null)
      acceptWaitlistOffer({
        offerId: a.offerId as any,
        bookingId: String(booking?.id ?? ''),
        dropOriginalEntry: a.dropOriginalEntry,
      })
        .then((r: any) => {
          setDeclineNotice({
            ok: true,
            text: r?.droppedEntry
              ? 'Booked — and your original waitlist request has been removed.'
              : 'Booked. You’re still on the waitlist for your original time.',
          })
        })
        .catch(() => { /* the offer's liveness check will close it out */ })
    }
    // Bug N-8: BookingModal now persists the booking itself (awaited, with errors
    // surfaced) before showing its success screen — so this no longer writes.
    // It just closes the modal; the reactive listBookings query refreshes the
    // calendar and My Bookings. Previously this swallowed write errors (`catch {}`),
    // masking failed bookings as confirmed.
    setModalOpen(false)
    setSelectedSlot(null)
  }

  // Other full/waitlistable hours on this day PER POOL (for the modal's
  // multi-hour join, §4.3 — the checklist only offers hours full for the pool
  // the user is joining).
  const fullHoursByPool = useMemo(() => {
    const out: Record<'bm' | 'ru', number[]> = { bm: [], ru: [] }
    for (const s of visibleTimeSlots) {
      if (s.hour !== Math.floor(s.hour)) continue
      if (isPast(selectedDay, s.hour) || isSelectedDayClosed) continue
      const full = poolFullByHour.get(s.hour)
      if (full?.bm) out.bm.push(s.hour)
      if (full?.ru) out.ru.push(s.hour)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTimeSlots, selectedDay, isSelectedDayClosed, dateKey, poolFullByHour])

  // SPEC_PUSH_NOTIFICATIONS_V2 §5/§8 + MOBILE §4.6 — handle waitlist push deep-links:
  //   ?book=<lane>&date=<d>&hour=<h>(&wl=1) → open the held slot's booking (checkout)
  //   ?wlDecline=<lane>&date=<d>&hour=<h>   → pass the offer to the next person
  // U15 — "manage my queue place" sheet, opened from the green band.
  const [manageQueue, setManageQueue] = useState<{ hour: number; pool: 'bm' | 'ru'; position: number | null; waiting: number } | null>(null)
  const [leavingQueue, setLeavingQueue] = useState(false)
  const [leaveQueueError, setLeaveQueueError] = useState<string | null>(null)
  const removeFromWaitlist = useMutation(api.mutations.removeFromWaitlist)
  // The band data (listWaitlistPoolsByDate) is privacy-trimmed and carries no row
  // id, so the id for Leave comes from the caller's OWN waitlist rows.
  const myWaitlistRowsForDay = (useQuery(
    api.queries.listWaitlistByUser,
    user?.id ? { userId: user.id } : 'skip',
  ) ?? []) as Array<{ _id: string; laneId: string; date: string; hour: number; status?: string }>

  // SPEC_WAITLIST_ALT_TIME_OFFER_2026-08 — an alternative-time offer opened from a
  // push/email link. The server owns ownership + liveness (a public customer
  // booking the slot silently kills it), so this is a query, not a stored flag.
  const [pendingOfferToken, setPendingOfferToken] = useState<string | null>(null)
  const offer = useQuery(
    api.waitlistOffers.getOfferByToken,
    pendingOfferToken && user ? { token: pendingOfferToken } : 'skip',
  )
  const [offerSheetDismissed, setOfferSheetDismissed] = useState(false)
  // Default UNCHECKED: never withdraw a preference the customer didn't withdraw.
  const [dropOriginalEntry, setDropOriginalEntry] = useState(false)
  // Carried through the normal BookingModal flow so the offer can be closed out
  // once the booking actually succeeds.
  const [acceptingOffer, setAcceptingOffer] = useState<{ offerId: string; dropOriginalEntry: boolean } | null>(null)
  const acceptWaitlistOffer = useMutation(api.waitlistOffers.acceptWaitlistOffer)

  const declineWaitlistOffer = useMutation(api.waitlist.declineWaitlistOffer)
  const [deepLinkHandled, setDeepLinkHandled] = useState(false)
  // U4 — result of a ?wlDecline deep-link, shown as a banner. Previously the
  // decline ran fire-and-forget with `.catch(() => {})` and no UI at all.
  const [declineNotice, setDeclineNotice] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    if (deepLinkHandled || typeof window === 'undefined') return
    const p = new URLSearchParams(window.location.search)
    const cleanUrl = () => window.history.replaceState({}, '', window.location.pathname)
    const declineLane = p.get('wlDecline')
    const bookLane = p.get('book')
    const dateP = p.get('date')
    const hourP = p.get('hour')
    // SPEC_WAITLIST_ALT_TIME_OFFER_2026-08 — ?offer=<token> is an admin offer of a
    // DIFFERENT time to someone on the waitlist. Resolution is a server query
    // (ownership + liveness), so just stash the token here and let the effect below
    // act on it once it resolves.
    const offerToken = p.get('offer')
    if (offerToken) {
      if (!user) return // wait for auth, exactly like ?book
      setDeepLinkHandled(true)
      setPendingOfferToken(offerToken)
      cleanUrl()
      return
    }
    if (declineLane && dateP && hourP) {
      // U4 — this used to fire before auth resolved (cold PWA start from a push),
      // so the mutation was rejected unauthenticated while `deepLinkHandled` was
      // already latched: never retried, silently swallowed, and the user believed
      // they had passed while the offer held the slot until it expired. Gate on
      // `user` exactly like the ?book branch below, and report the outcome.
      if (!user) return
      setDeepLinkHandled(true)
      declineWaitlistOffer({ laneId: declineLane, date: dateP, hour: Number(hourP) })
        .then(() => setDeclineNotice({ ok: true, text: 'Offer passed — it has gone to the next person in the queue.' }))
        .catch((err) => setDeclineNotice({
          ok: false,
          text: getErrorMessage(err) ?? 'Could not pass that offer — it may have already expired.',
        }))
      cleanUrl()
      return
    }
    if (bookLane && dateP && hourP && user) {
      // U11 — the availability check below is only meaningful once bookings have
      // loaded; until then an empty list would read as "free".
      if (bookingsLoading) return
      setDeepLinkHandled(true)
      const lane = LANES.find(l => l.id === bookLane)
      const match = weekDays.find(d => formatDateKey(d) === dateP)
      const hourNum = Number(hourP)
      // U11 (SPEC_UI_IMPROVEMENTS_2026-08) — a stale offer push used to open the
      // modal unconditionally: the slot looked bookable and only failed after
      // "Continue to Payment". And when the date wasn't in the visible week the
      // link did NOTHING AT ALL — no modal, no message. Validate first, and always
      // say something.
      if (!lane || !match) {
        setDeclineNotice({ ok: false, text: 'That booking link is for a date outside your current booking window.' })
      } else if (isSlotBooked(bookings, lane.id, dateP, hourNum)) {
        setDeclineNotice({ ok: false, text: 'That slot is no longer available — someone else took it.' })
        setSelectedDay(match)
      } else {
        setSelectedDay(match)
        setSelectedSlot({ lane, date: match, startHour: hourNum })
        setModalOpen(true)
      }
      cleanUrl()
    }
  }, [deepLinkHandled, user, weekDays, declineWaitlistOffer, bookings, bookingsLoading])

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
      {/* U4 — outcome of a waitlist "Pass" push deep-link. */}
      {declineNotice && (
        <div className={`flex items-center gap-2 rounded-xl p-3 border ${declineNotice.ok
          ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/50'
          : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/50'}`}>
          <span>{declineNotice.ok ? '✅' : '⚠️'}</span>
          <p className={`text-sm flex-1 ${declineNotice.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
            {declineNotice.text}
          </p>
          <button
            onClick={() => setDeclineNotice(null)}
            aria-label="Dismiss"
            className={`text-xs ${declineNotice.ok ? 'text-emerald-400 hover:text-emerald-600' : 'text-red-400 hover:text-red-600'}`}
          >✕</button>
        </div>
      )}
      {/* Weekly-release banner (customers + L2 coaches only) */}
      {!isL1Coach && (
        <ReleaseBanner role={releaseRole} tier={coachTierNorm} settings={settings} nextWeekOpen={nextWeekOpen} lastDay={weekDays[weekDays.length - 1]} />
      )}
      {/* Week Day Selector */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
        {/* §2 — hide the "This Week"/month chrome on mobile; keep the day strip below. */}
        <div className="hidden sm:flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">{headerLabel}</h2>
          <div className="flex items-center gap-2">
            {userIsCoach && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${coachTierNorm === 'L2' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>🏅 {coachTierNorm === 'L2' ? 'L2 Coach' : 'L1 Coach'}</span>
            )}
            <span className="text-sm text-gray-500 dark:text-gray-400">{weekDays[0].toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} &middot; AWST</span>
          </div>
        </div>
        {/* §1E — coach back/forward week navigation (read-only review of past weeks). */}
        {userIsCoach && (
          <div className="flex items-center justify-between mb-3">
            <button type="button" onClick={() => setWeekOffset((o) => Math.max(-2, o - 1))} disabled={weekOffset <= -2}
              className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${weekOffset <= -2 ? 'border-gray-200 dark:border-gray-800 text-gray-300 dark:text-gray-600 cursor-not-allowed' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>← Prev week</button>
            <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{weekOffset === 0 ? 'This week' : weekOffset === -1 ? 'Last week' : `${-weekOffset} weeks ago`}</span>
            <button type="button" onClick={() => setWeekOffset((o) => Math.min(0, o + 1))} disabled={weekOffset >= 0}
              className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${weekOffset >= 0 ? 'border-gray-200 dark:border-gray-800 text-gray-300 dark:text-gray-600 cursor-not-allowed' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>Next week →</button>
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
                className={`relative flex flex-col items-center py-2.5 px-1 rounded-xl transition-all duration-200 text-center ${active ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 scale-105' : dayDisabled ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed' : pastDay ? 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer' : 'bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer'}`}>
                {hasOverride && <span title="Custom lane layout" className="absolute top-1 right-1 text-[9px] leading-none text-amber-500">⚙</span>}
                <span className={`text-xs font-medium ${active ? 'text-emerald-100' : 'text-gray-500 dark:text-gray-400'}`}>{formatDayLabel(day)}</span>
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
          <div className="flex items-center gap-3 flex-wrap text-[10px] text-gray-500 dark:text-gray-400 mt-2.5">
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />Fully allocated</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />Partly</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />Needs athletes</span>
          </div>
        )}
      </div>

      {/* §1E — read-only review banner when a coach opens a past day. */}
      {reviewingPast && (
        <div className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-2xl px-4 py-2.5 flex items-center gap-2">
          <span className="text-base">🕓</span>
          <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Reviewing past sessions — read only. Showing your bookings only.</p>
        </div>
      )}

      {/* Date Header + Legend — DESKTOP ONLY. On mobile the full date and the
          legends are removed entirely (the selected day is obvious from the day
          strip above, and the grid gets the full height). */}
      <div className="hidden sm:block">
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100">{selectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{isToday(selectedDay) ? '🟢 Today' : formatDayLabel(selectedDay)} &middot; {formatTime(getHoursForDate(settings, selectedDay).open)} - {formatTime(getHoursForDate(settings, selectedDay).close)} AWST &middot; 5 Lanes</p>
      </div>
      <div className="hidden sm:block space-y-3">
        <LegendRow />
        <LaneLegend />
      </div>
      {/* U29 (SPEC_UI_IMPROVEMENTS_2026-08) — the legends were `hidden sm:block`, so
          on mobile the colour key NEVER rendered. That included the new amber
          "join waitlist" / green "you're queued" band meanings, leaving the two
          most ambiguous colours on the grid entirely unexplained on the device
          most customers book from. Collapsible so it costs no default height. */}
      <details className="sm:hidden bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-3 py-2">
        <summary className="text-xs font-semibold text-gray-600 dark:text-gray-300 cursor-pointer select-none min-h-[32px] flex items-center">ⓘ Key</summary>
        <div className="pt-2 space-y-3">
          <LegendRow />
          <LaneLegend />
        </div>
      </details>

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
        <div className="absolute inset-0 z-50 rounded-2xl bg-white/95 dark:bg-gray-900/95 flex flex-col items-center justify-center gap-2">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Loading bookings…</span>
        </div>
      )}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border-2 border-black dark:border-gray-700 shadow-sm overflow-auto max-h-[60dvh] sm:max-h-[72vh]">
        <div className="min-w-0 sm:min-w-[560px]">
        {/* U22 — header must sit ABOVE the waitlist band (z-30); it tied and lost on DOM order. */}
        <div className="grid grid-cols-[48px_repeat(5,minmax(0,1fr))] sm:grid-cols-[70px_repeat(5,1fr)] border-b-2 border-black dark:border-gray-700 bg-white dark:bg-gray-900 sticky top-0 z-40">
          <div className="p-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center justify-center sticky left-0 z-50 bg-white dark:bg-gray-900">Time</div>
          {LANES.map((lane) => (
            <div key={lane.id} className="p-2 text-center border-l-2 border-black dark:border-gray-700 bg-white dark:bg-gray-900">
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
            // SPEC_WAITLIST_SPLIT_BM_RU §4.2 — a fully-booked POOL (all BM-mode
            // lanes, or all RU-mode lanes, at this hour) collapses into an amber
            // JOIN {BM|RU} WAITLIST band spanning that pool's CONTIGUOUS lane
            // columns; the other pool's lanes keep the per-lane view on the same
            // row (both pools can band at once). Never for admins/coaches, never
            // on a half-hour row (SPEC_30MIN_GAP_FILL — those only exist to show
            // a coach booking; other lanes are merely "inactive" there), and
            // never for a pool the user owns a booking in that hour (their blue
            // "Your booking" must render).
            const poolBandedAt = (h: number, pool: 'bm' | 'ru') =>
              h === Math.floor(h) && !isAdmin && !renderAsCoachOwner &&
              !isPast(selectedDay, h) && !isSelectedDayClosed &&
              (poolFullByHour.get(h)?.[pool] ?? false) &&
              !(myBookedPoolHours.get(h)?.has(pool))
            // Contiguous runs of same-pool banded columns → the FIRST lane of a
            // run renders the band button (span = run length); the rest render
            // nothing. On override days where modes interleave, each run bands
            // separately (decision #1).
            const bandRun = new Map<string, number | 'hidden'>()
            if (!isHalfHour) {
              let i = 0
              while (i < LANES.length) {
                const p = lanePoolAt(LANES[i].id, slot.hour)
                if (p && poolBandedAt(slot.hour, p)) {
                  let j = i
                  while (j < LANES.length && lanePoolAt(LANES[j].id, slot.hour) === p) j++
                  bandRun.set(LANES[i].id, j - i)
                  for (let k = i + 1; k < j; k++) bandRun.set(LANES[k].id, 'hidden')
                  i = j
                } else i++
              }
            }
            return (
              <div key={slot.hour} className={`grid grid-cols-[48px_repeat(5,minmax(0,1fr))] sm:grid-cols-[70px_repeat(5,1fr)] ${slotIdx < visibleTimeSlots.length - 1 ? `border-b ${isHalfHour ? 'border-gray-300' : 'border-black'}` : ''}`}>
                <div className="p-1 sm:p-1.5 flex items-center justify-center sticky left-0 z-20 bg-white dark:bg-gray-900">
                  <span className={`text-[10px] sm:text-[11px] font-medium text-gray-500 dark:text-gray-400 ${isHalfHour ? 'opacity-60' : ''}`}>{slot.label}</span>
                </div>
                {LANES.map((lane) => {
                  // SPEC_WAITLIST_SPLIT_BM_RU — pool band cells.
                  const runState = bandRun.get(lane.id)
                  if (runState === 'hidden') return null
                  if (typeof runState === 'number') {
                    const pool = lanePoolAt(lane.id, slot.hour) as 'bm' | 'ru'
                    const poolTag = pool.toUpperCase()
                    const hourWaitCount = waitlistByHour.count[pool].get(slot.hour) ?? 0
                    const myQueuePos = myWaitlistPositions[String(slot.hour)]?.[pool]
                    const onThisPool = waitlistByHour.mine[pool].has(slot.hour) || myQueuePos != null
                    return (
                      <button key={lane.id} type="button"
                        aria-label={onThisPool
                          ? `You are number ${myQueuePos ?? ''} in the ${poolTag} queue at ${formatTime(slot.hour)} — manage`
                          : `Join the ${poolTag} waitlist at ${formatTime(slot.hour)}`}
                        // U15 (SPEC_UI_IMPROVEMENTS_2026-08) — the green "you're queued"
                        // band used to discard clicks entirely: there was no way to see
                        // your position detail or leave the queue from the calendar at
                        // all. It now opens a small manage sheet.
                        onClick={() => {
                          if (onThisPool) setManageQueue({ hour: slot.hour, pool, position: myQueuePos ?? null, waiting: hourWaitCount })
                          else openWaitlistForHour(slot.hour, pool)
                        }}
                        style={{ gridColumn: `span ${runState} / span ${runState}` }}
                        className={`relative z-30 border-l-2 border-black min-h-[40px] px-1 flex items-center justify-center transition-colors ${onThisPool ? 'bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 cursor-pointer' : 'bg-amber-50 dark:bg-amber-900/30 hover:bg-amber-100 dark:hover:bg-amber-900/50 cursor-pointer'}`}>
                        <span className={`text-center text-[10px] sm:text-[11px] leading-tight font-semibold pointer-events-none ${onThisPool ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
                          {onThisPool ? (
                            <>✓ #{myQueuePos ?? '—'} in {poolTag} queue · {hourWaitCount} waiting</>
                          ) : (
                            <>🔔 JOIN {poolTag} WAITLIST{hourWaitCount > 0 ? ` · ${hourWaitCount} waiting` : ''}</>
                          )}
                        </span>
                      </button>
                    )
                  }
                  const laneActiveSet = laneActiveHalfHours.get(lane.id) ?? new Set()
                  const booked = isSlotBooked(displayBookings, lane.id, dateKey, slot.hour)
                  const blocked = !booked ? isLaneBlocked(lane.id, dateKey, slot.hour) : null
                  // SPEC_LANE_SEGMENT_BOOKING_TIMES — the segment covering this cell is
                  // CLOSED (setup/service in-layout). Rendered like a block, never bookable.
                  const closedSeg = !booked && !blocked
                    ? (() => { const seg = resolveSegment(getDaySegments(lane.id, dateKey).segments, slot.hour); return segmentIsClosed(seg) ? seg : null })()
                    : null
                  const past = isPast(selectedDay, slot.hour)
                  // A half-hour cell is "inactive" (renders "–") unless a booking is
                  // active there — EXCEPT a coach valid half-hour start (e.g. weekday
                  // 7:30am–3:30pm), which must render as a bookable "+" for coaches.
                  const isCoachHalfStart = userIsCoach && (validCoachStartsForDay.includes(slot.hour) || isLaneCustomStart(lane.id, dateKey, slot.hour) || isCoachEdgeStart(displayBookings, lane.id, dateKey, slot.hour))
                  // A half-hour cell renders "–" unless a booking activates it, a coach
                  // may start there, OR it's a valid CUSTOMER start on this lane (admin
                  // custom starts / segment opening edge — without this, custom-start
                  // cells rendered as inactive dashes customers couldn't click).
                  const isLaneInactiveAtHalfHour = isHalfHour && !laneActiveSet.has(slot.hour) && !booked && !blocked && !closedSeg && !isCoachHalfStart && !(laneStartTimes.get(lane.id) ?? []).includes(slot.hour)
                  // SPEC_RECONFIGURABLE_LANES: per-segment colour band + band-start tag
                  const band = bandClassForSlot(lane.id, dateKey, slot.hour)
                  const bs = bandStart(lane.id, dateKey, slot.hour)

                  const isStartOfBooking = booked && Math.abs(booked.startHour - slot.hour) < 0.01
                  const isMiddleOfBooking = booked && !isStartOfBooking
                  // A banded POOL hour hides its lanes' cells, so a booking whose true
                  // start row is banded never renders its "Booked" block there → its
                  // continuation rows below would look empty. Anchor the block at the
                  // booking's FIRST visible row where ITS OWN pool isn't banded, so it
                  // always shows. (Pool-aware: the other pool banding never hides this
                  // lane's cells.)
                  const bookingEndHour = booked ? booked.startHour + booked.duration / 60 : 0
                  const isWaitlistBandRow = (h: number) => {
                    const p = lanePoolAt(lane.id, h)
                    return p != null && poolBandedAt(h, p)
                  }
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
                  const canBook = !isSelectedDayClosed && !past && !booked && !blocked && !closedSeg && isValidStart && canBookSlot(displayBookings, lane.id, dateKey, slot.hour, 30)
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
                  const ownCoachBooking = !!booked && !!booked.isCoachBooking && !!renderAsCoachOwner && !!user && (
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
                  // U7 — exactly the condition the click handler acts on, so the cell
                  // is focusable/announced only when pressing it really books.
                  const cellIsBookable = !past && !isLaneInactiveAtHalfHour && !booked &&
                    canBook && hasDurations && timeCheck.allowed

                  if (isLaneInactiveAtHalfHour) {
                    return (
                      <div key={lane.id} className="relative border-l-2 border-black dark:border-gray-700 min-h-[32px] bg-white dark:bg-gray-900">
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
                      <div key={lane.id} className="relative border-l-2 border-black dark:border-gray-700 min-h-[32px] bg-[repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6_4px,#e5e7eb_4px,#e5e7eb_8px)] dark:bg-[repeating-linear-gradient(45deg,#1f2937,#1f2937_4px,#374151_4px,#374151_8px)]">
                        {isBlockStart && (
                          <div className="absolute inset-x-0.5 top-0.5 z-10 rounded-md px-1.5 py-1 border border-gray-400 dark:border-gray-600 bg-gray-200/90 dark:bg-gray-700/90" style={{ height: `${blockSpan * 32 - 4}px` }}>
                            <div className="text-[9px] font-semibold text-gray-700 dark:text-gray-200 truncate">🔧 Unavailable</div>
                            <div className="text-[8px] text-gray-600 dark:text-gray-300 truncate">{(blocked as any).reason ?? 'Service'}</div>
                          </div>
                        )}
                      </div>
                    )
                  }

                  // SPEC_LANE_SEGMENT_BOOKING_TIMES — a CLOSED segment renders like a block
                  // ("Closed"), gating the grid so the period never shows bookable.
                  if (closedSeg) {
                    const isClosedStart = Math.abs(closedSeg.startHour - slot.hour) < 0.01
                    const closedSpan = (() => {
                      if (!isClosedStart) return 0
                      let count = 0
                      for (const vs of visibleTimeSlots) { if (vs.hour >= closedSeg.startHour && vs.hour < closedSeg.endHour) count++ }
                      return count
                    })()
                    return (
                      <div key={lane.id} className="relative border-l-2 border-black dark:border-gray-700 min-h-[32px] bg-[repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6_4px,#e5e7eb_4px,#e5e7eb_8px)] dark:bg-[repeating-linear-gradient(45deg,#1f2937,#1f2937_4px,#374151_4px,#374151_8px)]">
                        {isClosedStart && (
                          <div className="absolute inset-x-0.5 top-0.5 z-10 rounded-md px-1.5 py-1 border border-gray-400 dark:border-gray-600 bg-gray-200/90 dark:bg-gray-700/90" style={{ height: `${closedSpan * 32 - 4}px` }}>
                            <div className="text-[9px] font-semibold text-gray-700 dark:text-gray-200 truncate">🔒 Closed</div>
                            <div className="text-[8px] text-gray-600 dark:text-gray-300 truncate">{formatTime(closedSeg.startHour)}–{formatTime(closedSeg.endHour)}</div>
                          </div>
                        )}
                      </div>
                    )
                  }

                  return (
                    /* U7 (SPEC_UI_IMPROVEMENTS_2026-08) — every bookable "+" cell was
                       a click-only <div>: unfocusable, invisible to screen readers,
                       and impossible to book with a keyboard at all (the day strip
                       and waitlist bands were already real buttons). Given the cell
                       also hosts nested interactive children (the Repeat control on
                       a coach block), it takes button SEMANTICS rather than becoming
                       a <button> element — nesting interactive content inside a
                       button is invalid and breaks those children. */
                    <div key={lane.id}
                      role={cellIsBookable ? 'button' : undefined}
                      tabIndex={cellIsBookable ? 0 : undefined}
                      aria-label={cellIsBookable ? `Book ${resolveLaneAt(lane.id, dateKey, slot.hour).name} at ${formatTime(slot.hour)}` : undefined}
                      className={`relative border-l-2 border-black min-h-[32px] transition-all duration-150 ${cellIsBookable ? 'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-inset' : ''} ${past ? 'bg-gray-200 dark:bg-gray-800' : booked ? '' : tooLate ? 'bg-gray-200 dark:bg-gray-800' : canBook && hasDurations ? 'bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 cursor-pointer group' : band}`}
                      onKeyDown={cellIsBookable ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleSlotClick(lane, slot)
                        }
                      } : undefined}
                      onClick={() => {
                        if (past || isLaneInactiveAtHalfHour) return
                        if (!booked && canBook && hasDurations && timeCheck.allowed) handleSlotClick(lane, slot)
                      }}>
                      {!booked && !past && bs.isStart && bs.multi && (
                        <div className="absolute top-0 left-0 z-[5] text-[7px] leading-tight font-semibold text-gray-600 dark:text-gray-300 bg-white/70 dark:bg-gray-900/70 rounded-br px-1 py-0.5 pointer-events-none max-w-full truncate">
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
        <WaitlistModal pool={waitlistPool} selectedSlots={waitlistSelections} availableHours={fullHoursByPool[waitlistPool]} date={dateKey}
          onClose={() => setWaitlistModalOpen(false)}
          onSuccess={() => { setWaitlistModalOpen(false); setWaitlistSelections([]) }} />
      )}
      {/* SPEC_WAITLIST_ALT_TIME_OFFER_2026-08 — an admin has offered this customer a
          DIFFERENT time from the one they queued for. The sheet states the terms
          (held for them vs an open race) and asks about their original request
          BEFORE handing off to the normal booking modal, so nothing is dropped
          silently and nothing about the payment path changes. */}
      {offer && !offerSheetDismissed && (
        <ModalShell
          onClose={() => setOfferSheetDismissed(true)}
          labelledBy="alt-offer-cust-title"
          overlayClassName="fixed inset-0 z-[60] flex items-center justify-center p-4"
          panelClassName="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-sm p-5"
        >
          {offer.state === 'live' ? (
            <>
              <h3 id="alt-offer-cust-title" className="text-base font-bold text-gray-900 dark:text-white">
                A different time has opened up
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                You&apos;re on the waitlist for <strong>{formatTime(offer.sourceHour)}</strong>, which isn&apos;t free yet — but this has come up:
              </p>
              <div className="mt-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 p-3">
                <div className="text-lg font-bold text-emerald-800 dark:text-emerald-300">
                  {formatTime(offer.hour)} – {formatTime(offer.hour + 1)}
                </div>
                <div className="text-xs text-emerald-700 dark:text-emerald-400">
                  {formatDayLabel(new Date(offer.date + 'T00:00:00'))} · {offer.pool === 'bm' ? 'Bowling machine' : 'Run-up'} lane
                </div>
              </div>
              <p className={`mt-3 text-xs rounded-lg p-2.5 border ${offer.exclusive
                ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/50 text-blue-800 dark:text-blue-300'
                : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50 text-amber-800 dark:text-amber-300'}`}>
                {offer.exclusive
                  ? 'This slot is reserved for you until the session starts.'
                  : `This has been offered to ${offer.recipientCount} people on the waitlist — it stays open until someone books it.`}
              </p>
              {offer.waitlistEntryId && (
                <label className="mt-3 flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={dropOriginalEntry}
                    onChange={e => setDropOriginalEntry(e.target.checked)}
                    className="mt-0.5 rounded"
                  />
                  <span>Also remove my {formatTime(offer.sourceHour)} waitlist request (leave it ticked off to stay in that queue too).</span>
                </label>
              )}
              <div className="flex gap-3 mt-4">
                <button
                  onClick={() => setOfferSheetDismissed(true)}
                  className="flex-1 py-2.5 min-h-[40px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold rounded-xl text-sm"
                >Not now</button>
                <button
                  onClick={() => {
                    const lane = LANES.find(l => l.id === offer.laneId)
                    const day = weekDays.find(d => formatDateKey(d) === offer.date)
                    if (!lane || !day) {
                      setDeclineNotice({ ok: false, text: 'That time is outside your current booking window — please contact us.' })
                      setOfferSheetDismissed(true)
                      return
                    }
                    setAcceptingOffer({ offerId: offer.offerId, dropOriginalEntry })
                    setSelectedDay(day)
                    setSelectedSlot({ lane, date: day, startHour: offer.hour })
                    setModalOpen(true)
                    setOfferSheetDismissed(true)
                  }}
                  className="flex-[2] py-2.5 min-h-[40px] bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl text-sm"
                >Book this time →</button>
              </div>
            </>
          ) : (
            <>
              <h3 id="alt-offer-cust-title" className="text-base font-bold text-gray-900 dark:text-white">
                {offer.state === 'booked_by_you' ? 'You already booked this' : 'This offer has closed'}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                {offer.state === 'taken'
                  ? 'Someone else booked it first — sorry. You’re still on the waitlist for your original time.'
                  : offer.state === 'passed'
                    ? 'That session has already started.'
                    : offer.state === 'cancelled'
                      ? 'We withdrew this offer. You’re still on the waitlist for your original time.'
                      : offer.state === 'booked_by_you'
                        ? 'It’s in My Bookings.'
                        : 'This link isn’t valid for your account.'}
              </p>
              <button
                onClick={() => setOfferSheetDismissed(true)}
                className="mt-4 w-full py-2.5 min-h-[40px] bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold rounded-xl text-sm"
              >Close</button>
            </>
          )}
        </ModalShell>
      )}

      {/* U15 — manage your place in a pool queue, from the green band. */}
      {manageQueue && (() => {
        const poolTag = manageQueue.pool.toUpperCase()
        const poolLabel = manageQueue.pool === 'bm' ? 'any bowling-machine lane' : 'any run-up lane'
        const entry = myWaitlistRowsForDay.find(
          w => w.date === dateKey && w.hour === manageQueue.hour && w.laneId === `*${manageQueue.pool}`
        )
        const close = () => { if (!leavingQueue) { setManageQueue(null); setLeaveQueueError(null) } }
        return (
          <ModalShell
            onClose={close}
            closeOnBackdrop={!leavingQueue}
            closeOnEscape={!leavingQueue}
            labelledBy="manage-queue-title"
            overlayClassName="fixed inset-0 z-[60] flex items-center justify-center p-4"
            panelClassName="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-sm p-5"
          >
            <h3 id="manage-queue-title" className="text-base font-bold text-gray-900 dark:text-white mb-1">
              You&apos;re in the {poolTag} queue
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {formatDayLabel(selectedDay)} at {formatTime(manageQueue.hour)} · {poolLabel}.
            </p>
            <div className="mt-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 p-3">
              <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                {manageQueue.position != null ? `#${manageQueue.position}` : '—'}
              </div>
              <div className="text-xs text-emerald-700 dark:text-emerald-400">
                {manageQueue.position === 1
                  ? 'You are next — you get first refusal when a lane frees up.'
                  : `${manageQueue.waiting} ${manageQueue.waiting === 1 ? 'person is' : 'people are'} waiting for this time.`}
              </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
              We&apos;ll notify you the moment a {poolTag} lane opens at this time. First in the queue gets first refusal.
            </p>
            {leaveQueueError && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{leaveQueueError}</p>}
            <div className="flex gap-3 mt-4">
              <button
                onClick={close}
                disabled={leavingQueue}
                className="flex-1 py-2.5 min-h-[40px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-all disabled:opacity-50"
              >Stay in queue</button>
              <button
                onClick={async () => {
                  if (!entry) { setLeaveQueueError('Could not find that waitlist entry — try the Waitlist tab in My Bookings.'); return }
                  setLeavingQueue(true); setLeaveQueueError(null)
                  try {
                    await removeFromWaitlist({ id: entry._id as any })
                    setManageQueue(null)
                  } catch (err) {
                    setLeaveQueueError(getErrorMessage(err) ?? 'Could not leave the waitlist — please try again.')
                  } finally { setLeavingQueue(false) }
                }}
                disabled={leavingQueue}
                className="flex-1 py-2.5 min-h-[40px] bg-red-500 hover:bg-red-600 text-white font-semibold rounded-xl transition-all disabled:opacity-50"
              >{leavingQueue ? 'Leaving…' : 'Leave waitlist'}</button>
            </div>
          </ModalShell>
        )
      })()}
    </div>
  )
}

// Status legend (SPEC_MOBILE_BOOKING_UPDATES §3 adds the blue "Your booking").
function LegendRow() {
  const item = (cls: string, label: string) => (
    <div className="flex items-center gap-1.5"><div className={`w-3 h-3 rounded ${cls}`} /><span className="text-gray-600 dark:text-gray-300">{label}</span></div>
  )
  return (
    <div className="flex items-center gap-4 text-xs flex-wrap">
      {item('bg-emerald-100 border border-emerald-300', 'Available')}
      {item('bg-red-100 border border-red-300', 'Booked')}
      {item('bg-blue-100 border border-blue-300', 'Your booking')}
      {item('bg-amber-100 border border-amber-300', 'Waitlist')}
      {item('bg-emerald-50 border border-emerald-300', 'On waitlist')}
      {item('bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600', 'Past')}
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
    // SYNC-8 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13): timers are throttled in
    // background tabs and frozen in a backgrounded PWA, so on resume the countdown
    // could show a stale value (including sitting at "0m 0s" without flipping to
    // the open state until the next tick fired). Re-tick immediately on resume.
    const onVisible = () => { if (!document.hidden) setTick((t) => t + 1) }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearTimeout(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [role, tier, settings, nextWeekOpen])

  if (nextWeekOpen) {
    return (
      <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 rounded-2xl px-4 py-3 flex items-center gap-2">
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
