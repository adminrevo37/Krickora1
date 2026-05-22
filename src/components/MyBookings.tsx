import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useBookings } from '../hooks/useBookingStore'
import { useAuth } from '../hooks/useAuth'
import { useWaitlist } from '../hooks/useWaitlist'
import { LANES, formatDateKey, formatTime, generateGoogleCalendarUrl, generateOutlookCalendarUrl, getLanePrice, getCoachPrice, type Booking } from '../lib/booking-data'
import { formatAccessCode } from '../lib/access-code'
import AuthModal from './AuthModal'
import RescheduleModal from './RescheduleModal'
import AthleteAllocationEditor from './AthleteAllocationEditor'

export default function MyBookings() {
  const { bookings, cancelBooking, canCancel, createTentativeNextWeek, confirmTentative, cancelTentative, getTentativeBookings, rescheduleBooking, updateAthleteSlots } = useBookings()
  const { user, isCoach, isCustomer, getAllCoaches, assignCoach, removeCoach, customerRecord } = useAuth()
  const { getUserEntries, removeFromWaitlist, notifications, dismissNotification } = useWaitlist(user?.id)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [showAuth, setShowAuth] = useState(false)
  const [activeTab, setActiveTab] = useState<'upcoming' | 'past' | 'waitlist' | 'coaches' | 'tentative'>('upcoming')
  const [tentativeTime, setTentativeTime] = useState<Record<string, number>>({})
  const [rescheduleBookingData, setRescheduleBookingData] = useState<Booking | null>(null)
  const [athleteEditBooking, setAthleteEditBooking] = useState<Booking | null>(null)

  // Use the customerRecord from useAuth (already fetched from Convex)
  // For the coach athlete editor, we need the coach's Convex _id
  // Fallback to email if customerRecord hasn't loaded yet
  const coachIdForAthletes = customerRecord?._id ?? user?.email ?? ''

  const formatEndHour = (startHour: number, duration: number) => formatTime(startHour + duration / 60)

  const athleteNameCandidates = [
    user?.name,
    (customerRecord as any)?.name,
    (customerRecord as any)?.fullName,
    user?.email?.split('@')[0],
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(n => n.toLowerCase().trim())
  const isAthleteInBooking = (b: Booking) => {
    if (!user || !b.athleteSlots || b.athleteSlots.length === 0) return false
    return b.athleteSlots.some(s => {
      const slotName = s.athleteName.toLowerCase().trim()
      return athleteNameCandidates.includes(slotName)
    })
  }
  const userBookings = user
    ? bookings.filter(b => (b.customerEmail.toLowerCase() === user.email.toLowerCase() || b.userId === user.id || isAthleteInBooking(b)) && b.status !== 'tentative')
        .sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour)
    : []

  const tentativeBookings = user ? getTentativeBookings(user.id) : []

  const now = new Date()
  const todayKey = formatDateKey(now)
  const isUpcoming = (b: Booking) => {
    if (b.status === 'cancelled') return false
    if (b.date > todayKey) return true
    if (b.date === todayKey && b.startHour > now.getHours()) return true
    return false
  }

  const upcomingBookings = userBookings.filter(isUpcoming)
  const pastBookings = userBookings.filter(b => !isUpcoming(b) && b.status !== 'cancelled')
  const cancelledBookings = userBookings.filter(b => b.status === 'cancelled')
  const userWaitlistEntries = user ? getUserEntries(user.id) : []
  const userNotifications = notifications
  const coaches = getAllCoaches()
  const assignedCoachIds: string[] = customerRecord?.assignedCoachIds ?? []

  const getLane = (laneId: string) => LANES.find(l => l.id === laneId)
  const getVariantName = (booking: Booking) => {
    if (!booking.variantId) return null
    const lane = getLane(booking.laneId)
    return lane?.variants?.find(v => v.id === booking.variantId)?.name ?? null
  }
  const getBookingPrice = (booking: Booking) => {
    if (booking.isCoachBooking) return booking.coachPrice ?? getCoachPrice(booking.duration)
    const lane = getLane(booking.laneId)
    if (!lane) return 40
    return getLanePrice(lane, booking.variantId ?? null, booking.duration)
  }

  const handleCancel = async (bookingId: string) => {
    setCancelError(null)
    const check = canCancel(bookingId)
    if (!check.allowed) { setCancelError(check.reason ?? 'Cannot cancel this booking.'); return }
    setCancellingId(bookingId)
    await new Promise(r => setTimeout(r, 800))
    await cancelBooking(bookingId, user?.id)
    setCancellingId(null)
  }

  const handleCreateTentative = async (bookingId: string) => {
    const adjustedHour = tentativeTime[bookingId]
    const result = await createTentativeNextWeek(bookingId, adjustedHour)
    if (!result) setCancelError('Could not create tentative booking — slot may be taken.')
  }

  const handleConfirmTentative = async (bookingId: string) => { await confirmTentative(bookingId) }
  const handleCancelTentative = async (bookingId: string) => { await cancelTentative(bookingId) }

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

  const formatDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number)
    return new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  const formatDuration = (mins: number) => {
    const hrs = Math.floor(mins / 60)
    const m = mins % 60
    if (hrs > 0 && m > 0) return `${hrs}hr ${m}min`
    if (hrs > 0) return `${hrs}hr`
    return `${mins}min`
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 shadow-sm text-center">
          <div className="text-4xl mb-3">🎫</div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-gray-200 mb-1">My Bookings</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Sign in to view and manage your bookings.</p>
          <button onClick={() => setShowAuth(true)} className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-xl shadow-md transition-all">Sign In / Create Account</button>
          {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSuccess={() => setShowAuth(false)} initialMode="signin" />}
        </div>
      </div>
    )
  }

  const tabItems = [
    { key: 'upcoming' as const, label: 'Upcoming', count: upcomingBookings.length },
    { key: 'past' as const, label: 'Past', count: pastBookings.length + cancelledBookings.length },
    { key: 'waitlist' as const, label: 'Waitlist', count: userWaitlistEntries.length },
    ...(isCoach ? [{ key: 'tentative' as const, label: 'Tentative', count: tentativeBookings.length }] : []),
    ...(isCustomer ? [{ key: 'coaches' as const, label: 'My Coaches', count: assignedCoachIds.length }] : []),
  ]

  // Render a booking card for upcoming tab (shared between coach and customer)
  const renderUpcomingBooking = (booking: Booking) => {
    const lane = getLane(booking.laneId)
    const variantName = getVariantName(booking)
    const price = getBookingPrice(booking)
    const cancelCheck = canCancel(booking.id)

    // Athlete-only view: if the user is only an athlete in this booking (not the owner/coach),
    // show ONLY their athlete slot info and hide everything else.
    const isOwner = !!user && (booking.customerEmail.toLowerCase() === user.email.toLowerCase() || booking.userId === user.id)
    const mySlot = !isOwner && user && booking.athleteSlots
      ? booking.athleteSlots.find(s => athleteNameCandidates.includes(s.athleteName.toLowerCase().trim()))
      : null
    if (mySlot) {
      const athleteCalParams = { laneName: lane?.name ?? booking.laneId, variantName: variantName ?? undefined, date: booking.date, startHour: mySlot.startHour, duration: mySlot.durationMinutes, customerName: user?.name ?? '', accessCode: mySlot.accessCode }
      const athleteCalUrl = generateGoogleCalendarUrl(athleteCalParams)
      const athleteOutlookUrl = generateOutlookCalendarUrl(athleteCalParams)
      return (
        <div key={booking.id} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div className="w-10 h-10 bg-orange-50 dark:bg-orange-900/20 rounded-lg flex items-center justify-center text-lg shrink-0">{lane?.icon ?? '🏏'}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-gray-800 dark:text-gray-200">
                  Coaching Session
                  {variantName && <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">{variantName}</span>}
                  <span className="ml-1 text-orange-500">🏅</span>
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{lane?.name ?? booking.laneId}</div>
                <div className="text-sm text-gray-600 dark:text-gray-300 mt-0.5 font-medium">{formatDate(booking.date)} &middot; {formatTime(mySlot.startHour)} – {formatTime(mySlot.startHour + mySlot.durationMinutes / 60)}</div>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className="text-xs bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 px-2 py-0.5 rounded-full font-medium">{formatDuration(mySlot.durationMinutes)}</span>
                  <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded-full font-medium">Coach: {booking.customerName}</span>
                </div>
                {mySlot.accessCode && (
                  <div className="mt-2 flex items-center gap-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-200 dark:border-blue-800/50">
                    <span className="text-sm">🔑</span>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Your Access Code</div>
                      <div className="text-base font-mono font-bold tracking-[0.2em] text-blue-800 dark:text-blue-200">{formatAccessCode(mySlot.accessCode)}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 shrink-0">
              <a href={athleteCalUrl} target="_blank" rel="noopener noreferrer" className="text-xs px-2.5 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800/50 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all flex items-center gap-1" title="Add to Google Calendar">📅 Google</a>
              <a href={athleteOutlookUrl} target="_blank" rel="noopener noreferrer" className="text-xs px-2.5 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800/50 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all flex items-center gap-1" title="Add to Outlook Calendar">📆 Outlook</a>
            </div>
          </div>
        </div>
      )
    }
    const calParams = { laneName: lane?.name ?? booking.laneId, variantName: variantName ?? undefined, date: booking.date, startHour: booking.startHour, duration: booking.duration, customerName: booking.customerName, accessCode: booking.accessCode }
    const calUrl = generateGoogleCalendarUrl(calParams)
    const outlookUrl = generateOutlookCalendarUrl(calParams)
    const isCoachBooking = booking.isCoachBooking

    return (
      <div key={booking.id} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg flex items-center justify-center text-lg shrink-0">{lane?.icon ?? '🏏'}</div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-gray-800 dark:text-gray-200">
                {lane?.name ?? booking.laneId}
                {variantName && <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full font-medium ${variantName === 'Truman' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>{variantName}</span>}
                {isCoachBooking && <span className="ml-1 text-orange-500">🏅</span>}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{formatDate(booking.date)} &middot; {formatTime(booking.startHour)} - {formatEndHour(booking.startHour, booking.duration)}</div>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span className="text-xs bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 rounded-full font-medium">{formatDuration(booking.duration)}</span>
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">${price}</span>
                {booking.additionalLaneIds && booking.additionalLaneIds.length > 0 && (
                  <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full font-medium">
                    +{booking.additionalLaneIds.length} lane{booking.additionalLaneIds.length > 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {/* Athlete allocations display — hidden on mobile, shown below full-width */}
              {booking.athleteSlots && booking.athleteSlots.length > 0 && (
                <div className="mt-2.5 bg-orange-50 dark:bg-orange-900/10 rounded-lg p-2.5 border border-orange-200 dark:border-orange-800/30 hidden sm:block">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="text-[10px] font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wider">Athletes ({booking.athleteSlots.length})</div>
                    {isCoach && isCoachBooking && (
                      <button
                        onClick={() => setAthleteEditBooking(booking)}
                        className="text-[10px] font-semibold text-orange-500 hover:text-orange-700 dark:hover:text-orange-300 transition-colors"
                      >
                        ✏️ Edit
                      </button>
                    )}
                  </div>
                  {/* Mini timeline */}
                  <div className="relative bg-orange-100 dark:bg-orange-900/20 rounded h-5 mb-1.5 overflow-hidden">
                    {booking.athleteSlots.map((s, i) => {
                      const totalMin = booking.duration
                      const offsetMin = (s.startHour - booking.startHour) * 60
                      const left = (offsetMin / totalMin) * 100
                      const width = (s.durationMinutes / totalMin) * 100
                      const colors = ['bg-orange-400', 'bg-blue-400', 'bg-emerald-400', 'bg-purple-400', 'bg-pink-400', 'bg-cyan-400']
                      return (
                        <div
                          key={i}
                          className={`absolute top-0.5 h-4 ${colors[i % colors.length]} rounded text-[8px] text-white font-bold flex items-center justify-center overflow-hidden px-0.5`}
                          style={{ left: `${left}%`, width: `${Math.max(width, 2)}%` }}
                          title={`${s.athleteName}: ${formatTime(s.startHour)}–${formatTime(s.startHour + s.durationMinutes / 60)}`}
                        >
                          <span className="truncate">{s.athleteName}</span>
                        </div>
                      )
                    })}
                  </div>
                  <div className="space-y-1">
                    {booking.athleteSlots.map((s, i) => (
                      <div key={i} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 bg-white dark:bg-gray-900 rounded-lg px-2 py-1.5 border border-orange-100 dark:border-orange-800/20">
                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                          <span className="text-[10px] font-medium text-gray-700 dark:text-gray-300 truncate">{s.athleteName}</span>
                          <span className="text-[10px] text-gray-400">·</span>
                          <span className="text-[10px] text-gray-500">{formatTime(s.startHour)}–{formatTime(s.startHour + s.durationMinutes / 60)}</span>
                          <span className="text-[10px] text-gray-400">·</span>
                          <span className="text-[10px] text-gray-500">{s.durationMinutes}min</span>
                        </div>
                        {s.accessCode && (
                          <span className="text-[9px] font-mono font-bold text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 px-1.5 py-0.5 rounded self-start sm:self-auto sm:ml-1 sm:shrink-0 whitespace-nowrap">🔑 {formatAccessCode(s.accessCode)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Coach booking with no athletes yet — prompt to add (desktop only, mobile version below) */}
              {isCoach && isCoachBooking && (!booking.athleteSlots || booking.athleteSlots.length === 0) && (
                <button
                  onClick={() => setAthleteEditBooking(booking)}
                  className="mt-2.5 w-full py-2 border-2 border-dashed border-orange-300 dark:border-orange-700 rounded-lg text-xs font-semibold text-orange-500 dark:text-orange-400 hover:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-all items-center justify-center gap-1.5 hidden sm:flex"
                >
                  🏏 Add Athlete Allocations
                </button>
              )}

              {booking.accessCode && (
                <div className="mt-2 flex items-center gap-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-200 dark:border-blue-800/50">
                  <span className="text-sm">🔑</span>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Door Access Code</div>
                    <div className="text-base font-mono font-bold tracking-[0.2em] text-blue-800 dark:text-blue-200">{formatAccessCode(booking.accessCode)}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0 ml-3">
            <div className="flex gap-1.5">
              <a href={calUrl} target="_blank" rel="noopener noreferrer" className="text-xs px-2.5 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800/50 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all flex items-center gap-1" title="Add to Google Calendar">📅 Google</a>
              <a href={outlookUrl} target="_blank" rel="noopener noreferrer" className="text-xs px-2.5 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800/50 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all flex items-center gap-1" title="Add to Outlook Calendar">📆 Outlook</a>
            </div>
            {/* Coach: Edit athletes */}
            {isCoach && isCoachBooking && (
              <button onClick={() => setAthleteEditBooking(booking)}
                className="text-xs px-3 py-1.5 rounded-lg border border-orange-200 dark:border-orange-800/50 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 transition-all font-semibold">✏️ Edit Athletes</button>
            )}
            {/* Coach: Repeat next week */}
            {isCoach && isCoachBooking && (
              <button onClick={() => handleCreateTentative(booking.id)}
                className="text-xs px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800/50 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all">⏳ Repeat</button>
            )}
            {/* Reschedule button */}
            {cancelCheck.allowed && (
              <button onClick={() => setRescheduleBookingData(booking)}
                className="text-xs px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-800/50 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-all">
                📅 Reschedule
              </button>
            )}
            <button onClick={() => handleCancel(booking.id)} disabled={cancellingId === booking.id || !cancelCheck.allowed}
              title={!cancelCheck.allowed ? cancelCheck.reason : 'Cancel booking'}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${cancelCheck.allowed ? 'border-red-200 dark:border-red-800/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20' : 'border-gray-200 dark:border-gray-700 text-gray-400 cursor-not-allowed'} disabled:opacity-50`}>
              {cancellingId === booking.id ? 'Cancelling...' : !cancelCheck.allowed ? '🔒 Locked' : 'Cancel'}
            </button>
            {!cancelCheck.allowed && <span className="text-[10px] text-gray-400 max-w-[120px] text-right leading-tight">Within 2hr window</span>}
          </div>
        </div>

        {/* Mobile-only full-width athlete allocation — breaks out of card padding to span full screen width */}
        {booking.athleteSlots && booking.athleteSlots.length > 0 && (
          <div className="-mx-4 mt-3 bg-orange-50 dark:bg-orange-900/10 p-4 border-t border-b border-orange-200 dark:border-orange-800/30 sm:hidden">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wider">Athletes ({booking.athleteSlots.length})</div>
              {isCoach && isCoachBooking && (
                <button
                  onClick={() => setAthleteEditBooking(booking)}
                  className="text-xs font-semibold text-orange-500 hover:text-orange-700 dark:hover:text-orange-300 transition-colors"
                >
                  ✏️ Edit
                </button>
              )}
            </div>
            {/* Mini timeline */}
            <div className="relative bg-orange-100 dark:bg-orange-900/20 rounded h-6 mb-2 overflow-hidden">
              {booking.athleteSlots.map((s, i) => {
                const totalMin = booking.duration
                const offsetMin = (s.startHour - booking.startHour) * 60
                const left = (offsetMin / totalMin) * 100
                const width = (s.durationMinutes / totalMin) * 100
                const colors = ['bg-orange-400', 'bg-blue-400', 'bg-emerald-400', 'bg-purple-400', 'bg-pink-400', 'bg-cyan-400']
                return (
                  <div
                    key={i}
                    className={`absolute top-0.5 h-5 ${colors[i % colors.length]} rounded text-[9px] text-white font-bold flex items-center justify-center overflow-hidden px-1`}
                    style={{ left: `${left}%`, width: `${Math.max(width, 2)}%` }}
                    title={`${s.athleteName}: ${formatTime(s.startHour)}–${formatTime(s.startHour + s.durationMinutes / 60)}`}
                  >
                    <span className="truncate">{s.athleteName}</span>
                  </div>
                )
              })}
            </div>
            <div className="space-y-1.5">
              {booking.athleteSlots.map((s, i) => (
                <div key={i} className="bg-white dark:bg-gray-900 rounded-lg px-3 py-2 border border-orange-100 dark:border-orange-800/20">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{s.athleteName}</span>
                    {s.accessCode && (
                      <span className="text-xs font-mono font-bold text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 px-2 py-0.5 rounded whitespace-nowrap shrink-0">🔑 {formatAccessCode(s.accessCode)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>{formatTime(s.startHour)}–{formatTime(s.startHour + s.durationMinutes / 60)}</span>
                    <span className="text-gray-300">·</span>
                    <span>{s.durationMinutes}min</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Mobile-only add athletes prompt */}
        {isCoach && isCoachBooking && (!booking.athleteSlots || booking.athleteSlots.length === 0) && (
          <button
            onClick={() => setAthleteEditBooking(booking)}
            className="-mx-4 mt-3 w-[calc(100%+2rem)] py-3 border-t-2 border-b-2 border-dashed border-orange-300 dark:border-orange-700 text-sm font-semibold text-orange-500 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-all flex items-center justify-center gap-1.5 sm:hidden"
          >
            🏏 Add Athlete Allocations
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 ${isCoach ? 'bg-orange-500' : 'bg-emerald-500'} rounded-full flex items-center justify-center text-white text-lg font-bold`}>{user.name.charAt(0).toUpperCase()}</div>
            <div>
              <h2 className="text-lg font-bold text-gray-800 dark:text-gray-200">🎫 My Bookings</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">{user.name} &middot; {user.email} {isCoach && <span className="text-orange-500">🏅 Coach</span>}</p>
            </div>
          </div>
          {userNotifications.length > 0 && <span className="flex items-center gap-1 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2.5 py-1 rounded-full font-semibold animate-pulse">🔔 {userNotifications.length} new</span>}
        </div>
      </div>

      {cancelError && (
        <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
          <span>⚠️</span><p className="text-sm text-red-700 dark:text-red-400">{cancelError}</p>
          <button onClick={() => setCancelError(null)} className="ml-auto text-red-400 hover:text-red-600 text-xs">✕</button>
        </div>
      )}

      {/* Notifications */}
      {userNotifications.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider flex items-center gap-2"><span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />Slot Available!</h3>
          {userNotifications.map((notif) => (
            <div key={notif.id} className="bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-800/50 p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-lg flex items-center justify-center text-lg shrink-0">🔔</div>
                  <div>
                    <div className="font-semibold text-gray-800 dark:text-gray-200 text-sm">A slot has opened up!</div>
                    <div className="text-sm text-gray-600 dark:text-gray-400 mt-0.5"><strong>{notif.laneName}</strong> on {formatDate(notif.date)} at {formatTime(notif.hour)}</div>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <a href={`/?book=${notif.laneId}&date=${notif.date}&hour=${notif.hour}`} className="text-xs px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-lg transition-all text-center">Book Now</a>
                  <button onClick={() => dismissNotification(notif.id)} className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700 transition-all">Dismiss</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1 overflow-x-auto">
        {tabItems.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`flex-1 text-xs font-semibold py-2 px-3 rounded-lg transition-all whitespace-nowrap ${activeTab === tab.key ? 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700'}`}>
            {tab.label} {tab.count > 0 && <span className="ml-1 text-[10px] bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded-full">{tab.count}</span>}
          </button>
        ))}
      </div>

      {/* Upcoming */}
      {activeTab === 'upcoming' && (
        <div className="space-y-3">
          {upcomingBookings.length === 0 ? (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
              <div className="text-4xl mb-3">📭</div><h3 className="font-semibold text-gray-800 dark:text-gray-200">No upcoming bookings</h3>
              <p className="text-sm text-gray-500 mt-1">Book a session from the calendar above!</p>
            </div>
          ) : upcomingBookings.map(renderUpcomingBooking)}
        </div>
      )}

      {/* Tentative (Coach only) */}
      {activeTab === 'tentative' && isCoach && (
        <div className="space-y-3">
          {tentativeBookings.length === 0 ? (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
              <div className="text-4xl mb-3">⏳</div><h3 className="font-semibold text-gray-800 dark:text-gray-200">No tentative bookings</h3>
              <p className="text-sm text-gray-500 mt-1">Use the &quot;Repeat&quot; button on upcoming bookings to tentatively book the same session next week.</p>
            </div>
          ) : tentativeBookings.map((booking) => {
            const lane = getLane(booking.laneId)
            const price = getBookingPrice(booking)
            return (
              <div key={booking.id} className="bg-blue-50 dark:bg-blue-900/10 rounded-xl border border-blue-200 dark:border-blue-800/50 p-4 shadow-sm">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center text-lg shrink-0">⏳</div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-gray-800 dark:text-gray-200">{lane?.name ?? booking.laneId} <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">(Tentative)</span></div>
                      <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{formatDate(booking.date)} &middot; {formatTime(booking.startHour)} - {formatEndHour(booking.startHour, booking.duration)}</div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full font-medium">{formatDuration(booking.duration)}</span>
                        <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">${price}</span>
                      </div>
                      {/* Athlete allocations on tentative */}
                      {booking.athleteSlots && booking.athleteSlots.length > 0 && (
                        <div className="mt-2 space-y-0.5">
                          <div className="flex items-center justify-between">
                            <div className="text-[10px] font-semibold text-orange-600 uppercase">Athletes:</div>
                            <button onClick={() => setAthleteEditBooking(booking)} className="text-[10px] font-semibold text-orange-500 hover:text-orange-700 transition-colors">✏️ Edit</button>
                          </div>
                          {booking.athleteSlots.map((s, i) => (
                            <div key={i} className="text-[10px] text-gray-500">{s.athleteName}: {formatTime(s.startHour)}-{formatTime(s.startHour + s.durationMinutes / 60)} ({s.durationMinutes}min)</div>
                          ))}
                        </div>
                      )}
                      {(!booking.athleteSlots || booking.athleteSlots.length === 0) && (
                        <button
                          onClick={() => setAthleteEditBooking(booking)}
                          className="mt-2 w-full py-1.5 border-2 border-dashed border-orange-300 dark:border-orange-700 rounded-lg text-[10px] font-semibold text-orange-500 dark:text-orange-400 hover:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-all flex items-center justify-center gap-1"
                        >
                          🏏 Add Athletes
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0 ml-3">
                    <button onClick={() => handleConfirmTentative(booking.id)}
                      className="text-xs px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-lg transition-all">✓ Confirm</button>
                    <button onClick={() => handleCancelTentative(booking.id)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all">Remove</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Past + Cancelled */}
      {activeTab === 'past' && (
        <div className="space-y-3">
          {cancelledBookings.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-red-500 uppercase tracking-wider">Cancelled</h4>
              {cancelledBookings.map((booking) => {
                const lane = getLane(booking.laneId)
                return (
                  <div key={booking.id} className="bg-red-50/50 dark:bg-red-900/10 rounded-xl border border-red-200 dark:border-red-800/30 p-4 opacity-70">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-red-100 dark:bg-red-900/20 rounded-lg flex items-center justify-center text-lg shrink-0">{lane?.icon ?? '🏏'}</div>
                      <div>
                        <div className="font-medium text-gray-600 dark:text-gray-400">{lane?.name ?? booking.laneId} <span className="text-red-500 text-xs">(cancelled)</span></div>
                        <div className="text-sm text-gray-400">{formatDate(booking.date)} &middot; {formatTime(booking.startHour)} - {formatEndHour(booking.startHour, booking.duration)}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {pastBookings.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Past Sessions</h4>
              {pastBookings.map((booking) => {
                const lane = getLane(booking.laneId)
                const variantName = getVariantName(booking)
                const price = getBookingPrice(booking)
                return (
                  <div key={booking.id} className="bg-gray-50 dark:bg-gray-900/50 rounded-xl border border-gray-200 dark:border-gray-800 p-4 opacity-60">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center text-lg shrink-0">{lane?.icon ?? '🏏'}</div>
                      <div>
                        <div className="font-medium text-gray-600 dark:text-gray-400">{lane?.name ?? booking.laneId}{variantName && <span className="ml-1.5 text-xs text-gray-500">({variantName})</span>}</div>
                        <div className="text-sm text-gray-400">{formatDate(booking.date)} &middot; {formatTime(booking.startHour)} - {formatEndHour(booking.startHour, booking.duration)} &middot; ${price}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {pastBookings.length === 0 && cancelledBookings.length === 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
              <div className="text-4xl mb-3">📭</div><h3 className="font-semibold text-gray-800 dark:text-gray-200">No past bookings</h3>
            </div>
          )}
        </div>
      )}

      {/* Waitlist */}
      {activeTab === 'waitlist' && (
        <div className="space-y-3">
          {userWaitlistEntries.length === 0 ? (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
              <div className="text-4xl mb-3">🔔</div><h3 className="font-semibold text-gray-800 dark:text-gray-200">No waitlist entries</h3>
              <p className="text-sm text-gray-500 mt-1">Use the &quot;Join Waitlist&quot; button on the calendar.</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
              {userWaitlistEntries.map((entry) => {
                const lane = getLane(entry.laneId)
                return (
                  <div key={entry.id} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{lane?.icon ?? '🏏'}</span>
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{lane?.name ?? entry.laneId}</span>
                      <span className="text-xs text-gray-500">{formatDate(entry.date)} at {formatTime(entry.hour)}</span>
                    </div>
                    <button onClick={() => removeFromWaitlist(entry.id)} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Remove</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* My Coaches (Customer only) */}
      {activeTab === 'coaches' && isCustomer && (
        <div className="space-y-3">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Assign Coaches to Your Account</h4>
            <div className="space-y-2">
              {coaches.map(coach => {
                const isAssigned = assignedCoachIds.includes(coach._id)
                return (
                  <div key={coach._id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50 dark:bg-gray-800">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center text-white text-xs font-bold">{coach.name.charAt(0).toUpperCase()}</div>
                      <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{coach.name}</div>
                        <div className="text-[10px] text-gray-500">{coach.email}</div>
                      </div>
                    </div>
                    <button onClick={() => {
                      const convexId = customerRecord?._id
                      if (convexId) {
                        isAssigned ? removeCoach(convexId, coach._id) : assignCoach(convexId, coach._id)
                      }
                    }}
                      disabled={!customerRecord}
                      className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-all ${isAssigned ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-800' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-orange-50'} disabled:opacity-50 disabled:cursor-not-allowed`}>
                      {isAssigned ? '✓ Assigned' : '+ Assign'}
                    </button>
                  </div>
                )
              })}
              {coaches.length === 0 && <p className="text-sm text-gray-500 text-center py-4">No coaches registered yet.</p>}
            </div>
          </div>
        </div>
      )}

      {/* Reschedule Modal */}
      {rescheduleBookingData && (
        <RescheduleModal
          booking={rescheduleBookingData}
          allBookings={bookings}
          onClose={() => setRescheduleBookingData(null)}
          onReschedule={(opts) => handleReschedule(rescheduleBookingData, opts)}
          isCoach={isCoach}
        />
      )}

      {/* Athlete Allocation Editor Modal */}
      {athleteEditBooking && user && (
        <AthleteAllocationEditor
          bookingId={athleteEditBooking.id}
          bookingStartHour={athleteEditBooking.startHour}
          bookingDuration={athleteEditBooking.duration}
          currentSlots={athleteEditBooking.athleteSlots ?? []}
          coachId={coachIdForAthletes}
          onSave={handleSaveAthleteSlots}
          onClose={() => setAthleteEditBooking(null)}
        />
      )}
    </div>
  )
}
