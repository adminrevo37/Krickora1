import { useState, useMemo } from 'react'
import { useBookings } from '../hooks/useBookingStore'
import { useAuth } from '../hooks/useAuth'
import { useWaitlist } from '../hooks/useWaitlist'
import {
  LANES,
  formatDateKey,
  formatTime,
  generateGoogleCalendarUrl,
  generateOutlookCalendarUrl,
  getLanePrice,
  getCoachPrice,
  type Booking,
} from '../lib/booking-data'
import { formatAccessCode } from '../lib/access-code'
import AuthModal from './AuthModal'
import RescheduleModal from './RescheduleModal'
import AthleteAllocationEditor from './AthleteAllocationEditor'
import EditBookingModal from './EditBookingModal'

// ── helpers ──────────────────────────────────────────────────────────────────

function getMondayOfWeek(d: Date): Date {
  const day = d.getDay() // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day)
  const mon = new Date(d)
  mon.setDate(d.getDate() + diff)
  mon.setHours(0, 0, 0, 0)
  return mon
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function toDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const SLOT_COLORS = [
  'bg-orange-400', 'bg-blue-400', 'bg-emerald-400', 'bg-purple-400',
  'bg-pink-400', 'bg-cyan-400', 'bg-amber-400', 'bg-indigo-400',
]

function formatDuration(mins: number): string {
  const hrs = Math.floor(mins / 60)
  const m = mins % 60
  if (hrs > 0 && m > 0) return `${hrs}hr ${m}min`
  if (hrs > 0) return `${hrs}hr`
  return `${mins}min`
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  })
}

// ── component ─────────────────────────────────────────────────────────────────

export default function MyBookings({ impersonatedEmail }: { impersonatedEmail?: string } = {}) {
  const {
    bookings, cancelBooking, canCancel,
    createTentativeNextWeek, confirmTentative, cancelTentative, getTentativeBookings,
    rescheduleBooking, updateAthleteSlots,
  } = useBookings()
  const { user, isCoach, isCustomer, getAllCoaches, assignCoach, removeCoach, customerRecord } = useAuth()
  const { getUserEntries, removeFromWaitlist, notifications, dismissNotification } = useWaitlist(user?.id)
  // When impersonating, filter bookings by the impersonated user's email
  const effectiveEmail = impersonatedEmail ?? user?.email

  const now = new Date()
  const todayKey = formatDateKey(now)

  // ── local state ─────────────────────────────────────────────────────────────
  const [weekOffset, setWeekOffset] = useState(0)
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey)
  const [activeTab, setActiveTab] = useState<'schedule' | 'past' | 'waitlist' | 'coaches'>('schedule')
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [showAuth, setShowAuth] = useState(false)
  const [rescheduleBookingData, setRescheduleBookingData] = useState<Booking | null>(null)
  const [athleteEditBooking, setAthleteEditBooking] = useState<Booking | null>(null)
  const [editBookingData, setEditBookingData] = useState<Booking | null>(null)

  const coachIdForAthletes = customerRecord?._id ?? user?.email ?? ''

  // ── derived booking lists ────────────────────────────────────────────────────

  const athleteNameCandidates = useMemo(() => [
    user?.name,
    (customerRecord as any)?.name,
    (customerRecord as any)?.fullName,
    user?.email?.split('@')[0],
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(n => n.toLowerCase().trim()), [user, customerRecord])

  const isAthleteInBooking = (b: Booking) => {
    if (!user || !b.athleteSlots || b.athleteSlots.length === 0) return false
    return b.athleteSlots.some(s => athleteNameCandidates.includes(s.athleteName.toLowerCase().trim()))
  }

  const userBookings = useMemo(() => (user || impersonatedEmail)
    ? bookings.filter(b =>
        (
          (effectiveEmail && b.customerEmail.toLowerCase() === effectiveEmail.toLowerCase()) ||
          (!impersonatedEmail && b.userId === user?.id) ||
          (!impersonatedEmail && isAthleteInBooking(b))
        ) &&
        b.status !== 'tentative',
      ).sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour)
    : [],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [bookings, user, athleteNameCandidates, effectiveEmail, impersonatedEmail])

  const tentativeBookings = user ? getTentativeBookings(user.id) : []

  const isUpcoming = (b: Booking) => {
    if (b.status === 'cancelled') return false
    if (b.date > todayKey) return true
    if (b.date === todayKey && b.startHour >= now.getHours()) return true
    return false
  }

  // Upcoming = confirmed + tentative merged, sorted by date+time
  const scheduleBookings = useMemo(() => [
    ...userBookings.filter(isUpcoming),
    ...tentativeBookings,
  ].sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [userBookings, tentativeBookings])

  const pastBookings = useMemo(() =>
    userBookings.filter(b => !isUpcoming(b) && b.status !== 'cancelled')
      .sort((a, b) => b.date.localeCompare(a.date) || a.startHour - b.startHour),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [userBookings])

  const cancelledBookings = useMemo(() =>
    userBookings.filter(b => b.status === 'cancelled')
      .sort((a, b) => b.date.localeCompare(a.date)),
  [userBookings])

  // ── week strip ───────────────────────────────────────────────────────────────

  const weekDays = useMemo(() => {
    const baseMonday = getMondayOfWeek(now)
    const monday = addDays(baseMonday, weekOffset * 7)
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(monday, i)
      const key = toDateKey(d)
      const dayBookings = scheduleBookings.filter(b => b.date === key)
      const hasUnallocated = dayBookings.some(
        b => b.isCoachBooking && (!b.athleteSlots || b.athleteSlots.length === 0),
      )
      const hasTentative = dayBookings.some(b => b.status === 'tentative')
      const hasBookings = dayBookings.length > 0
      return { date: d, key, label: DAY_LABELS[i], hasBookings, hasUnallocated, hasTentative }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOffset, scheduleBookings])

  const weekMonthLabel = useMemo(() => {
    const first = weekDays[0].date
    const last = weekDays[6].date
    const opts: Intl.DateTimeFormatOptions = { month: 'short', year: 'numeric' }
    if (first.getMonth() === last.getMonth()) {
      return first.toLocaleDateString('en-US', opts)
    }
    return `${first.toLocaleDateString('en-US', { month: 'short' })} – ${last.toLocaleDateString('en-US', opts)}`
  }, [weekDays])

  const selectedDayBookings = useMemo(
    () => scheduleBookings.filter(b => b.date === selectedDateKey),
    [scheduleBookings, selectedDateKey],
  )

  // ── actions ─────────────────────────────────────────────────────────────────

  const handleCancel = async (bookingId: string) => {
    setCancelError(null)
    const check = canCancel(bookingId)
    if (!check.allowed) { setCancelError(check.reason ?? 'Cannot cancel this booking.'); return }
    setCancellingId(bookingId)
    await cancelBooking(bookingId, user?.id)
    setCancellingId(null)
  }

  const handleReschedule = async (booking: Booking, opts: {
    newDate: string; newStartHour: number; newDuration: number;
    newLaneId?: string; newVariantId?: string;
    newAdditionalLaneIds?: string[]; newAccessCode?: string;
  }) => {
    if (!user) return { success: false, error: 'Not signed in.' }
    return await rescheduleBooking(booking.id, { ...opts, userId: user.id })
  }

  const handleSaveAthleteSlots = async (slots: { athleteName: string; startHour: number; durationMinutes: number }[]) => {
    if (!user || !athleteEditBooking) return { success: false, error: 'Not signed in.' }
    return await updateAthleteSlots(athleteEditBooking.id, slots, user.id)
  }

  // ── lane / pricing helpers ──────────────────────────────────────────────────

  const getLane = (laneId: string) => LANES.find(l => l.id === laneId)
  const getVariantName = (booking: Booking) => {
    if (!booking.variantId) return null
    return getLane(booking.laneId)?.variants?.find(v => v.id === booking.variantId)?.name ?? null
  }
  const getBookingPrice = (booking: Booking) => {
    if (booking.isCoachBooking) return booking.coachPrice ?? getCoachPrice(booking.duration)
    const lane = getLane(booking.laneId)
    if (!lane) return 40
    return getLanePrice(lane, booking.variantId ?? null, booking.duration)
  }

  const userWaitlistEntries = user ? getUserEntries(user.id) : []
  const userNotifications = notifications
  const coaches = getAllCoaches()
  const assignedCoachIds: string[] = customerRecord?.assignedCoachIds ?? []

  // ── not signed in ────────────────────────────────────────────────────────────

  if (!user) {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 shadow-sm text-center">
          <div className="text-4xl mb-3">🎫</div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-gray-200 mb-1">My Bookings</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Sign in to view and manage your bookings.</p>
          <button onClick={() => setShowAuth(true)} className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-xl shadow-md transition-all">
            Sign In / Create Account
          </button>
          {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSuccess={() => setShowAuth(false)} initialMode="signin" />}
        </div>
      </div>
    )
  }

  // ── tab config ───────────────────────────────────────────────────────────────

  const tabItems = [
    { key: 'schedule' as const, label: 'Schedule', count: scheduleBookings.length },
    { key: 'past' as const, label: 'Past', count: pastBookings.length + cancelledBookings.length },
    { key: 'waitlist' as const, label: 'Waitlist', count: userWaitlistEntries.length },
    ...(isCustomer ? [{ key: 'coaches' as const, label: 'My Coaches', count: assignedCoachIds.length }] : []),
  ]

  // ── card renderers ───────────────────────────────────────────────────────────

  const renderCoachBookingCard = (booking: Booking) => {
    const lane = getLane(booking.laneId)
    const variantName = getVariantName(booking)
    const cancelCheck = canCancel(booking.id)
    const isTentative = booking.status === 'tentative'
    const hasAthletes = (booking.athleteSlots ?? []).length > 0
    const needsAthletes = booking.isCoachBooking && !hasAthletes

    const cardBg = isTentative
      ? 'bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800/50'
      : needsAthletes
        ? 'bg-orange-50 dark:bg-orange-900/10 border-orange-300 dark:border-orange-700/60'
        : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800'

    return (
      <div
        key={booking.id}
        onClick={() => booking.isCoachBooking && setAthleteEditBooking(booking)}
        className={`rounded-xl border p-4 shadow-sm transition-all ${cardBg} ${booking.isCoachBooking ? 'cursor-pointer active:scale-[0.99]' : ''}`}
      >
        {/* Top row: time + lane */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-base font-bold text-gray-900 dark:text-white">
                {formatTime(booking.startHour)} – {formatTime(booking.startHour + booking.duration / 60)}
              </span>
              {isTentative && (
                <span className="text-[10px] font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded-full uppercase tracking-wide">Tentative</span>
              )}
              {needsAthletes && (
                <span className="text-[10px] font-semibold bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 px-1.5 py-0.5 rounded-full uppercase tracking-wide">No athletes</span>
              )}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {lane?.icon} {lane?.name ?? booking.laneId}
              {variantName && <span className="ml-1 text-gray-400">· {variantName}</span>}
              <span className="ml-1 text-gray-400">· {formatDuration(booking.duration)}</span>
            </div>
          </div>
          <span className="text-lg">{lane?.icon ?? '🏏'}</span>
        </div>

        {/* Athlete chips */}
        {hasAthletes && (
          <div className="overflow-x-auto -mx-1 px-1 pb-1">
            <div className="flex gap-1.5 min-w-0">
              {(booking.athleteSlots ?? []).map((s, i) => (
                <div
                  key={i}
                  className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-white text-[11px] font-semibold ${SLOT_COLORS[i % SLOT_COLORS.length]}`}
                >
                  <span>{s.athleteName.split(' ')[0]}</span>
                  <span className="opacity-75">{s.durationMinutes}m</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No-athletes dashed prompt */}
        {needsAthletes && (
          <div className="mt-2 border-2 border-dashed border-orange-300 dark:border-orange-700 rounded-lg py-2 flex items-center justify-center gap-1.5 text-xs font-semibold text-orange-500 dark:text-orange-400">
            🏏 Tap to add athlete allocations
          </div>
        )}

        {/* Tentative inline actions */}
        {isTentative && (
          <div className="mt-2.5 flex gap-2" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => confirmTentative(booking.id)}
              className="flex-1 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold rounded-lg transition-colors"
            >
              ✓ Confirm
            </button>
            <button
              onClick={() => cancelTentative(booking.id)}
              className="flex-1 py-1.5 border border-red-200 dark:border-red-700 text-red-600 dark:text-red-400 text-xs font-semibold rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              Remove
            </button>
          </div>
        )}

        {/* Confirmed booking actions */}
        {!isTentative && (
          <div className="mt-2.5 flex gap-1.5 flex-wrap" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => createTentativeNextWeek(booking.id, undefined)}
              className="text-[11px] px-2.5 py-1 rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
            >
              ⏳ Repeat
            </button>
            {cancelCheck.allowed && (
              <button
                onClick={() => setRescheduleBookingData(booking)}
                className="text-[11px] px-2.5 py-1 rounded-lg border border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors"
              >
                📅 Reschedule
              </button>
            )}
            <button
              onClick={() => handleCancel(booking.id)}
              disabled={cancellingId === booking.id || !cancelCheck.allowed}
              title={!cancelCheck.allowed ? cancelCheck.reason : 'Cancel booking'}
              className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-40 ${
                cancelCheck.allowed
                  ? 'border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                  : 'border-gray-200 dark:border-gray-700 text-gray-400 cursor-not-allowed'
              }`}
            >
              {cancellingId === booking.id ? '…' : cancelCheck.allowed ? 'Cancel' : '🔒'}
            </button>
          </div>
        )}

        {/* Access code */}
        {booking.accessCode && (
          <div className="mt-2.5 flex items-center gap-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-200 dark:border-blue-800/50" onClick={e => e.stopPropagation()}>
            <span>🔑</span>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Access Code</div>
              <div className="text-sm font-mono font-bold tracking-[0.2em] text-blue-800 dark:text-blue-200">{formatAccessCode(booking.accessCode)}</div>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderAthleteSlotCard = (booking: Booking) => {
    // User is an athlete allocated inside this coach's booking (not the owner)
    const lane = getLane(booking.laneId)
    const variantName = getVariantName(booking)
    const mySlot = booking.athleteSlots?.find(s =>
      athleteNameCandidates.includes(s.athleteName.toLowerCase().trim()),
    )
    if (!mySlot) return null
    const calParams = { laneName: lane?.name ?? booking.laneId, variantName: variantName ?? undefined, date: booking.date, startHour: mySlot.startHour, duration: mySlot.durationMinutes, customerName: user?.name ?? '', accessCode: mySlot.accessCode }
    return (
      <div key={booking.id} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-bold text-gray-900 dark:text-white">
                {formatTime(mySlot.startHour)} – {formatTime(mySlot.startHour + mySlot.durationMinutes / 60)}
              </span>
              <span className="text-[10px] font-semibold bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 px-1.5 py-0.5 rounded-full uppercase">Coaching</span>
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {lane?.icon} {lane?.name ?? booking.laneId}
              {variantName && <span className="ml-1">· {variantName}</span>}
              · {formatDuration(mySlot.durationMinutes)}
              · Coach: {booking.customerName}
            </div>
          </div>
          <span className="text-lg">{lane?.icon ?? '🏏'}</span>
        </div>
        {mySlot.accessCode && (
          <div className="flex items-center gap-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-200 dark:border-blue-800/50">
            <span>🔑</span>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Your Access Code</div>
              <div className="text-sm font-mono font-bold tracking-[0.2em] text-blue-800 dark:text-blue-200">{formatAccessCode(mySlot.accessCode)}</div>
            </div>
          </div>
        )}
        <div className="mt-2 flex gap-1.5">
          <a href={generateGoogleCalendarUrl(calParams)} target="_blank" rel="noopener noreferrer" className="text-[11px] px-2.5 py-1 rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">📅 Google</a>
          <a href={generateOutlookCalendarUrl(calParams)} target="_blank" rel="noopener noreferrer" className="text-[11px] px-2.5 py-1 rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors">📆 Outlook</a>
        </div>
      </div>
    )
  }

  const renderCustomerBookingCard = (booking: Booking) => {
    const lane = getLane(booking.laneId)
    const variantName = getVariantName(booking)
    const price = getBookingPrice(booking)
    const cancelCheck = canCancel(booking.id)
    const calParams = { laneName: lane?.name ?? booking.laneId, variantName: variantName ?? undefined, date: booking.date, startHour: booking.startHour, duration: booking.duration, customerName: booking.customerName, accessCode: booking.accessCode }
    return (
      <div key={booking.id} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <div className="text-base font-bold text-gray-900 dark:text-white">
              {formatTime(booking.startHour)} – {formatTime(booking.startHour + booking.duration / 60)}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {lane?.icon} {lane?.name ?? booking.laneId}
              {variantName && <span className="ml-1">· {variantName}</span>}
              <span className="ml-1">· {formatDuration(booking.duration)}</span>
              <span className="ml-1 font-semibold text-emerald-600 dark:text-emerald-400">· ${price}</span>
            </div>
          </div>
          <span className="text-lg">{lane?.icon ?? '🏏'}</span>
        </div>
        {booking.accessCode && (
          <div className="mb-2 flex items-center gap-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-200 dark:border-blue-800/50">
            <span>🔑</span>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Access Code</div>
              <div className="text-sm font-mono font-bold tracking-[0.2em] text-blue-800 dark:text-blue-200">{formatAccessCode(booking.accessCode)}</div>
            </div>
          </div>
        )}
        <div className="flex gap-1.5 flex-wrap">
          <a href={generateGoogleCalendarUrl(calParams)} target="_blank" rel="noopener noreferrer" className="text-[11px] px-2.5 py-1 rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">📅 Google</a>
          <a href={generateOutlookCalendarUrl(calParams)} target="_blank" rel="noopener noreferrer" className="text-[11px] px-2.5 py-1 rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors">📆 Outlook</a>
          {cancelCheck.allowed && (
            <>
              <button onClick={() => setEditBookingData(booking)} className="text-[11px] px-2.5 py-1 rounded-lg border border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors">✏️ Edit</button>
              <button onClick={() => setRescheduleBookingData(booking)} className="text-[11px] px-2.5 py-1 rounded-lg border border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors">📅 Reschedule</button>
            </>
          )}
          <button
            onClick={() => handleCancel(booking.id)}
            disabled={cancellingId === booking.id || !cancelCheck.allowed}
            title={!cancelCheck.allowed ? cancelCheck.reason : 'Cancel booking'}
            className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-40 ${
              cancelCheck.allowed
                ? 'border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                : 'border-gray-200 dark:border-gray-700 text-gray-400 cursor-not-allowed'
            }`}
          >
            {cancellingId === booking.id ? '…' : cancelCheck.allowed ? 'Cancel' : '🔒'}
          </button>
        </div>
      </div>
    )
  }

  const renderBookingCard = (booking: Booking) => {
    const isOwner = !!user && (
      booking.customerEmail.toLowerCase() === user.email.toLowerCase() ||
      booking.userId === user.id
    )
    if (!isOwner && isAthleteInBooking(booking)) return renderAthleteSlotCard(booking)
    if (booking.isCoachBooking || booking.status === 'tentative') return renderCoachBookingCard(booking)
    return renderCustomerBookingCard(booking)
  }

  // ── coach schedule: flat date-grouped list of ALL upcoming bookings ──────────

  const renderCoachSchedule = () => {
    // Group all upcoming bookings by date
    const byDate: Record<string, Booking[]> = {}
    for (const b of scheduleBookings) {
      if (!byDate[b.date]) byDate[b.date] = []
      byDate[b.date].push(b)
    }
    const sortedDates = Object.keys(byDate).sort()

    // Bookings that still need athlete allocation
    const unallocated = scheduleBookings.filter(
      b => b.isCoachBooking && (!b.athleteSlots || b.athleteSlots.length === 0)
    )

    if (sortedDates.length === 0) {
      return (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
          <div className="text-3xl mb-2">📭</div>
          <h3 className="font-semibold text-gray-700 dark:text-gray-300 text-sm">No upcoming bookings</h3>
          <p className="text-xs text-gray-400 mt-1">Book sessions from the calendar — they'll all appear here</p>
        </div>
      )
    }

    return (
      <div className="space-y-4">
        {/* ── Needs-allocation banner ── */}
        {unallocated.length > 0 && (
          <div className="bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-800/40 rounded-2xl p-3.5">
            <div className="flex items-center gap-2 mb-2.5">
              <span className="text-sm">⚠️</span>
              <span className="text-sm font-semibold text-orange-700 dark:text-orange-400">
                {unallocated.length} booking{unallocated.length > 1 ? 's' : ''} need{unallocated.length === 1 ? 's' : ''} athlete allocation
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-0.5">
              {unallocated.map(b => {
                const lane = getLane(b.laneId)
                const dateObj = new Date(b.date + 'T00:00:00')
                return (
                  <button
                    key={b.id}
                    onClick={() => setAthleteEditBooking(b)}
                    className="shrink-0 flex flex-col items-start px-3 py-2 bg-white dark:bg-gray-900 border border-orange-200 dark:border-orange-800 rounded-xl text-left hover:bg-orange-50 dark:hover:bg-orange-900/20 active:scale-95 transition-all"
                  >
                    <span className="text-[11px] font-bold text-orange-700 dark:text-orange-400">
                      {dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </span>
                    <span className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                      {formatTime(b.startHour)} · {lane?.shortName ?? b.laneId}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* ── All upcoming bookings, grouped by date ── */}
        {sortedDates.map(date => {
          const isToday = date === todayKey
          const isTomorrow = date === toDateKey(addDays(now, 1))
          const dayBookings = byDate[date]
          const dateObj = new Date(date + 'T00:00:00')
          const hasUnallocated = dayBookings.some(
            b => b.isCoachBooking && (!b.athleteSlots || b.athleteSlots.length === 0)
          )

          let dateLabel: string
          let dateSub: string
          if (isToday) {
            dateLabel = 'Today'
            dateSub = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
          } else if (isTomorrow) {
            dateLabel = 'Tomorrow'
            dateSub = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          } else {
            dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long' })
            dateSub = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          }

          return (
            <div key={date} className="space-y-2">
              {/* Date header */}
              <div className="flex items-center gap-2">
                <div className={`px-2.5 py-1 rounded-lg text-xs font-bold ${
                  isToday
                    ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                    : isTomorrow
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                }`}>
                  {dateLabel}
                </div>
                <span className="text-xs text-gray-400 dark:text-gray-500">{dateSub}</span>
                {hasUnallocated && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 font-semibold uppercase tracking-wide">
                    needs athletes
                  </span>
                )}
                <span className="ml-auto text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded-full">
                  {dayBookings.length}
                </span>
              </div>
              {dayBookings.map(b => (
                <div key={b.id}>{renderBookingCard(b)}</div>
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 ${isCoach ? 'bg-orange-500' : 'bg-emerald-500'} rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0`}>
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="text-base font-bold text-gray-900 dark:text-white leading-tight">
              {user.name} {isCoach && <span className="text-orange-500">🏅</span>}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
          </div>
        </div>
        {userNotifications.length > 0 && (
          <span className="flex items-center gap-1 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2 py-1 rounded-full font-semibold animate-pulse">
            🔔 {userNotifications.length}
          </span>
        )}
      </div>

      {/* Error banner */}
      {cancelError && (
        <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
          <span>⚠️</span>
          <p className="text-sm text-red-700 dark:text-red-400 flex-1">{cancelError}</p>
          <button onClick={() => setCancelError(null)} className="text-red-400 hover:text-red-600 text-xs">✕</button>
        </div>
      )}

      {/* Slot-available notifications */}
      {userNotifications.length > 0 && (
        <div className="space-y-2">
          {userNotifications.map((notif) => (
            <div key={notif.id} className="bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-800/50 p-3 flex items-center gap-3">
              <span className="text-xl shrink-0">🔔</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">Slot available!</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {notif.laneName} · {formatDate(notif.date)} at {formatTime(notif.hour)}
                </div>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <a href={`/?book=${notif.laneId}&date=${notif.date}&hour=${notif.hour}`} className="text-xs px-2.5 py-1 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-lg text-center">Book</a>
                <button onClick={() => dismissNotification(notif.id)} className="text-[10px] text-gray-400 hover:text-gray-600 text-center">Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1 overflow-x-auto">
        {tabItems.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 text-xs font-semibold py-2 px-3 rounded-lg transition-all whitespace-nowrap ${
              activeTab === tab.key
                ? 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className="ml-1 text-[10px] bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded-full">{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── SCHEDULE TAB — coaches see all upcoming in a flat list ── */}
      {activeTab === 'schedule' && isCoach && renderCoachSchedule()}

      {/* ── SCHEDULE TAB — customers keep the week-strip view ── */}
      {activeTab === 'schedule' && !isCoach && (
        <div className="space-y-3">
          {/* Week strip */}
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            {/* Month + nav */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-gray-800">
              <button
                onClick={() => setWeekOffset(w => w - 1)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
              >‹</button>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">{weekMonthLabel}</span>
                {weekOffset !== 0 && (
                  <button
                    onClick={() => { setWeekOffset(0); setSelectedDateKey(todayKey) }}
                    className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-1.5 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800/50 hover:bg-emerald-100 transition-colors"
                  >Today</button>
                )}
              </div>
              <button
                onClick={() => setWeekOffset(w => w + 1)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
              >›</button>
            </div>
            {/* 7-day grid */}
            <div className="grid grid-cols-7 gap-0">
              {weekDays.map(({ date, key, label, hasBookings, hasUnallocated, hasTentative }) => {
                const isToday = key === todayKey
                const isSelected = key === selectedDateKey
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedDateKey(key)}
                    className={`flex flex-col items-center py-2.5 px-1 transition-all relative ${
                      isSelected
                        ? 'bg-emerald-500 text-white'
                        : isToday
                          ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    <span className={`text-[10px] font-semibold uppercase tracking-wide mb-0.5 ${isSelected ? 'text-white/80' : ''}`}>{label}</span>
                    <span className={`text-sm font-bold leading-none ${isSelected ? 'text-white' : ''}`}>{date.getDate()}</span>
                    {/* Dot indicators */}
                    {hasBookings && (
                      <div className="flex gap-0.5 mt-1">
                        {hasUnallocated && (
                          <div className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white/80' : 'bg-orange-400'}`} />
                        )}
                        {hasTentative && (
                          <div className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white/60' : 'bg-blue-400'}`} />
                        )}
                        {!hasUnallocated && !hasTentative && (
                          <div className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white/80' : 'bg-emerald-400'}`} />
                        )}
                      </div>
                    )}
                    {!hasBookings && <div className="h-2 mt-1" />}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Selected day bookings */}
          {selectedDayBookings.length === 0 ? (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
              <div className="text-3xl mb-2">📭</div>
              <h3 className="font-semibold text-gray-700 dark:text-gray-300 text-sm">
                Nothing booked for {new Date(selectedDateKey + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </h3>
              {selectedDateKey === todayKey && (
                <p className="text-xs text-gray-400 mt-1">Book a session from the calendar!</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  {new Date(selectedDateKey + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                </h3>
                <span className="text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded-full">{selectedDayBookings.length}</span>
              </div>
              {selectedDayBookings.map(renderBookingCard)}
            </div>
          )}
        </div>
      )}

      {/* ── PAST TAB ── */}
      {activeTab === 'past' && (
        <div className="space-y-3">
          {cancelledBookings.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-red-500 uppercase tracking-wider">Cancelled</h4>
              {cancelledBookings.map(booking => {
                const lane = getLane(booking.laneId)
                return (
                  <div key={booking.id} className="bg-red-50/50 dark:bg-red-900/10 rounded-xl border border-red-200 dark:border-red-800/30 px-4 py-3 opacity-70 flex items-center gap-3">
                    <span className="text-lg shrink-0">{lane?.icon ?? '🏏'}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-600 dark:text-gray-400 truncate">{lane?.name ?? booking.laneId} <span className="text-red-400 text-xs">(cancelled)</span></div>
                      <div className="text-xs text-gray-400">{formatDate(booking.date)} · {formatTime(booking.startHour)} – {formatTime(booking.startHour + booking.duration / 60)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {pastBookings.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Past Sessions</h4>
              {pastBookings.map(booking => {
                const lane = getLane(booking.laneId)
                const price = getBookingPrice(booking)
                return (
                  <div key={booking.id} className="bg-gray-50 dark:bg-gray-900/50 rounded-xl border border-gray-100 dark:border-gray-800 px-4 py-3 opacity-60 flex items-center gap-3">
                    <span className="text-lg shrink-0">{lane?.icon ?? '🏏'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-600 dark:text-gray-400 truncate">{lane?.name ?? booking.laneId}</div>
                      <div className="text-xs text-gray-400">{formatDate(booking.date)} · {formatTime(booking.startHour)} – {formatTime(booking.startHour + booking.duration / 60)} · ${price}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {pastBookings.length === 0 && cancelledBookings.length === 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
              <div className="text-3xl mb-2">📭</div>
              <h3 className="font-semibold text-gray-700 dark:text-gray-300 text-sm">No past bookings yet</h3>
            </div>
          )}
        </div>
      )}

      {/* ── WAITLIST TAB ── */}
      {activeTab === 'waitlist' && (
        <div className="space-y-3">
          {userWaitlistEntries.length === 0 ? (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
              <div className="text-3xl mb-2">🔔</div>
              <h3 className="font-semibold text-gray-700 dark:text-gray-300 text-sm">No waitlist entries</h3>
              <p className="text-xs text-gray-400 mt-1">Use &quot;Join Waitlist&quot; on the calendar.</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
              {userWaitlistEntries.map(entry => {
                const lane = getLane(entry.laneId)
                return (
                  <div key={entry.id} className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base shrink-0">{lane?.icon ?? '🏏'}</span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">{lane?.name ?? entry.laneId}</div>
                        <div className="text-xs text-gray-400">{formatDate(entry.date)} at {formatTime(entry.hour)}</div>
                      </div>
                    </div>
                    <button onClick={() => removeFromWaitlist(entry.id)} className="text-xs text-gray-400 hover:text-red-500 transition-colors ml-3 shrink-0">Remove</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── MY COACHES TAB (customers only) ── */}
      {activeTab === 'coaches' && isCustomer && (
        <div className="space-y-3">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
            {coaches.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">No coaches registered yet.</p>
            ) : coaches.map(coach => {
              const isAssigned = assignedCoachIds.includes(coach._id)
              return (
                <div key={coach._id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {coach.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{coach.name}</div>
                      <div className="text-[10px] text-gray-400 truncate">{coach.email}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const id = customerRecord?._id
                      if (id) isAssigned ? removeCoach(id, coach._id) : assignCoach(id, coach._id)
                    }}
                    disabled={!customerRecord}
                    className={`ml-3 shrink-0 text-xs px-3 py-1.5 rounded-lg font-semibold transition-all disabled:opacity-50 ${
                      isAssigned
                        ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-800'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-orange-50 dark:hover:bg-orange-900/20'
                    }`}
                  >
                    {isAssigned ? '✓ Assigned' : '+ Assign'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {rescheduleBookingData && (
        <RescheduleModal
          booking={rescheduleBookingData}
          allBookings={bookings}
          onClose={() => setRescheduleBookingData(null)}
          onReschedule={opts => handleReschedule(rescheduleBookingData, opts)}
          isCoach={isCoach}
        />
      )}

      {editBookingData && (
        <EditBookingModal
          booking={editBookingData}
          onClose={() => setEditBookingData(null)}
          onSuccess={() => setEditBookingData(null)}
        />
      )}

      {athleteEditBooking && user && (
        <AthleteAllocationEditor
          bookingStartHour={athleteEditBooking.startHour}
          bookingDuration={athleteEditBooking.duration}
          currentSlots={athleteEditBooking.athleteSlots ?? []}
          coachId={coachIdForAthletes}
          onSave={handleSaveAthleteSlots}
          onClose={() => setAthleteEditBooking(null)}
          bottomSheet={isCoach}
          defaultSessionDuration={(customerRecord as any)?.defaultSessionDuration ?? undefined}
        />
      )}
    </div>
  )
}
