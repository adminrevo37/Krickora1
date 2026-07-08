import { useCallback, useMemo } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import { type Booking, getAWSTNow } from '../lib/booking-data'
import type { Id } from '../../convex/_generated/dataModel'
import { getSettingsStore } from '../lib/settings-store'
import { useAuth } from './useAuth'

// Convert Convex booking doc to local Booking type
function toBooking(doc: any): Booking {
  return {
    id: doc._id,
    laneId: doc.laneId,
    variantId: doc.variantId ?? null,
    date: doc.date,
    startHour: doc.startHour,
    duration: doc.duration,
    customerName: doc.customerName,
    customerEmail: doc.customerEmail,
    customerPhone: doc.customerPhone,
    userId: doc.userId,
    status: doc.status as Booking['status'],
    stripeSessionId: doc.stripeSessionId,
    isCoachBooking: doc.isCoachBooking,
    coachPrice: doc.coachPrice,
    priceInCents: doc.priceInCents,
    additionalLaneIds: doc.additionalLaneIds,
    athleteSlots: doc.athleteSlots,
    creditApplied: doc.creditApplied,
    cancelledAt: doc.cancelledAt,
    cancelledByUserId: doc.cancelledByUserId,
    refilledMinutes: doc.refilledMinutes,
    originalCoachId: doc.originalCoachId,
    accessCode: doc.accessCode,
    discountCode: doc.discountCode,
    modificationHistory: doc.modificationHistory,
    notes: doc.notes,
    mates: doc.mates,
    createdByAdmin: doc.createdByAdmin,
    autoDoor: doc.autoDoor, // SPEC_TEAM_BOOKING_AUTODOOR
    isClubBooking: doc.isClubBooking, // SPEC_CLUB_TEAM_BOOKINGS
    bookingGroupId: doc.bookingGroupId, // SPEC_CLUB_TEAM_BOOKINGS block id
  }
}

// ── Cancellation policy (pure) ───────────────────────────────────────────────
// Given a booking object, may the caller cancel it now? Extracted as a pure
// function so screens that source bookings OUTSIDE the shared grid subscription
// (My Bookings → owner-scoped queries) can evaluate it without a lookup into the
// narrow grid array. Mirrors the server-enforced windows (SSOT settings).
export function evaluateCancellation(
  booking: Booking | undefined,
): { allowed: boolean; reason?: string; willBeCharged?: boolean } {
  if (!booking) return { allowed: false, reason: 'Booking not found.' }
  if (booking.status === 'cancelled')
    return { allowed: false, reason: 'Already cancelled.' }
  const [year, month, day] = booking.date.split('-').map(Number)
  const whole = Math.floor(booking.startHour)
  const mins = Math.round((booking.startHour - whole) * 60)
  const bookingStart = new Date(year, month - 1, day, whole, mins, 0)
  const now = getAWSTNow()
  const hoursUntil = (bookingStart.getTime() - now.getTime()) / (1000 * 60 * 60)
  // Once the session has STARTED, neither coach nor customer can cancel it
  // retrospectively (admins handle any post-start clean-up server-side).
  if (hoursUntil <= 0) {
    return { allowed: false, reason: 'This session has already started and can no longer be cancelled.' }
  }
  // Coach bookings can always be cancelled, but will be charged within the
  // admin-configured late-cancel window (SSOT: coachLateCancellationHours).
  if (booking.isCoachBooking) {
    const coachLateHours = getSettingsStore().get().coachLateCancellationHours ?? 24
    if (hoursUntil < coachLateHours) {
      return { allowed: true, willBeCharged: true, reason: `Cancellation within ${coachLateHours} hour${coachLateHours !== 1 ? 's' : ''} of booking — you will still be charged to your statement.` }
    }
    return { allowed: true }
  }
  // SSOT: the server enforces customerCancellationHours (falling back to the
  // legacy cancellationHoursBefore). Mirror that precedence here.
  const cs = getSettingsStore().get()
  const cancellationHours = cs.customerCancellationHours ?? cs.cancellationHoursBefore ?? 2
  if (hoursUntil < cancellationHours) {
    return {
      allowed: false,
      reason: `Bookings can only be cancelled or changed at least ${cancellationHours} hour${cancellationHours !== 1 ? 's' : ''} before the session starts.`,
    }
  }
  return { allowed: true }
}

// ── Booking write actions (no subscription) ──────────────────────────────────
// Create / cancel / update / modify / allocate WITHOUT subscribing to the grid
// array, so screens that don't render the grid (My Bookings, the admin booking
// modals) can mutate without pulling the reactive booking window (COST-1 / FEA-6).
export function useBookingActions() {
  const createBookingMut = useMutation(api.mutations.createBooking)
  const updateBookingMut = useMutation(api.mutations.updateBooking)
  const cancelBookingMut = useMutation(api.mutations.cancelBooking)
  const modifyMut = useMutation(api.mutations.modifyBooking)
  const updateAthleteSlotsMut = useMutation(api.mutations.updateBookingAthleteSlots)

  const addBooking = useCallback(
    async (booking: Booking) => {
      const id = await createBookingMut({
        laneId: booking.laneId,
        variantId: booking.variantId ?? undefined,
        date: booking.date,
        startHour: booking.startHour,
        duration: booking.duration,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone,
        userId: booking.userId,
        status: booking.status,
        stripeSessionId: booking.stripeSessionId,
        isCoachBooking: booking.isCoachBooking,
        coachPrice: booking.coachPrice,
        additionalLaneIds: booking.additionalLaneIds,
        // athleteId carried as string from the UI; validator types it as
        // Id<"athletes"> — cast at the mutation boundary.
        athleteSlots: booking.athleteSlots as any,
        creditApplied: booking.creditApplied,
        accessCode: booking.accessCode,
        discountCode: booking.discountCode,
        notes: booking.notes,
        paymentStatus: booking.paymentStatus,
        priceInCents: booking.priceInCents,
        createdByAdmin: booking.createdByAdmin,
        autoDoor: booking.autoDoor, // SPEC_TEAM_BOOKING_AUTODOOR
        bookingGroupId: booking.bookingGroupId, // SPEC_CLUB_TEAM_BOOKINGS block id
      })
      return id
    },
    [createBookingMut]
  )

  const cancelBooking = useCallback(
    async (bookingId: string, userId?: string) => {
      try {
        await cancelBookingMut({
          id: bookingId as Id<"bookings">,
          cancelledByUserId: userId,
        })
        return true
      } catch {
        return false
      }
    },
    [cancelBookingMut]
  )

  const updateBooking = useCallback(
    async (bookingId: string, updates: Partial<Booking>) => {
      const convexUpdates: Record<string, any> = {}
      if (updates.date !== undefined) convexUpdates.date = updates.date
      if (updates.startHour !== undefined) convexUpdates.startHour = updates.startHour
      if (updates.laneId !== undefined) convexUpdates.laneId = updates.laneId
      if (updates.status !== undefined) convexUpdates.status = updates.status
      if (updates.duration !== undefined) convexUpdates.duration = updates.duration
      if (updates.customerName !== undefined) convexUpdates.customerName = updates.customerName
      if (updates.customerEmail !== undefined) convexUpdates.customerEmail = updates.customerEmail
      if (updates.customerPhone !== undefined) convexUpdates.customerPhone = updates.customerPhone
      if (updates.coachPrice !== undefined) convexUpdates.coachPrice = updates.coachPrice
      if (updates.athleteSlots !== undefined) convexUpdates.athleteSlots = updates.athleteSlots
      if (updates.additionalLaneIds !== undefined) convexUpdates.additionalLaneIds = updates.additionalLaneIds
      if (updates.accessCode !== undefined) convexUpdates.accessCode = updates.accessCode
      if (updates.refilledMinutes !== undefined) convexUpdates.refilledMinutes = updates.refilledMinutes
      if (updates.notes !== undefined) convexUpdates.notes = updates.notes
      if (updates.autoDoor !== undefined) convexUpdates.autoDoor = updates.autoDoor // SPEC_TEAM_BOOKING_AUTODOOR

      await updateBookingMut({
        id: bookingId as Id<"bookings">,
        ...convexUpdates,
      })
      return null
    },
    [updateBookingMut]
  )

  // Unified modify (SPEC_MODIFY_BOOKING_UPGRADE) — one path for lane/variant/date/
  // time/duration. Returns requiresPayment + the Stripe top-up amount when a
  // customer price increase needs paying; the modal then redirects to checkout.
  const modifyBooking = useCallback(
    async (bookingId: string, opts: {
      newDate?: string; newStartHour?: number; newDuration?: number;
      newLaneId?: string; newVariantId?: string;
      newAdditionalLaneIds?: string[]; userId: string; newAccessCode?: string;
    }): Promise<{
      success: boolean; error?: string;
      requiresPayment?: boolean; topUpAmountCents?: number;
      creditAppliedCents?: number; credited?: boolean;
      creditIssuedCents?: number;
      priceDifferenceCents?: number; droppedAthletes?: string[];
    }> => {
      try {
        const res = await modifyMut({
          id: bookingId as Id<"bookings">,
          newDate: opts.newDate,
          newStartHour: opts.newStartHour,
          newDuration: opts.newDuration,
          newLaneId: opts.newLaneId,
          newVariantId: opts.newVariantId,
          newAdditionalLaneIds: opts.newAdditionalLaneIds,
          newAccessCode: opts.newAccessCode,
          userId: opts.userId,
        })
        return { ...res, success: true }
      } catch (err: any) {
        return { success: false, error: getErrorMessage(err) ?? 'Failed to modify booking.' }
      }
    },
    [modifyMut]
  )

  const updateAthleteSlots = useCallback(
    async (
      bookingId: string,
      athleteSlots: { athleteId?: string; athleteName: string; startHour: number; durationMinutes: number }[],
      userId: string,
      confirmedOverride?: boolean,
    ) => {
      try {
        await updateAthleteSlotsMut({
          id: bookingId as Id<"bookings">,
          // athleteId is carried as a string from the editor; the mutation
          // validator types it as Id<"athletes"> — cast at the boundary.
          athleteSlots: athleteSlots as any,
          userId,
          confirmedOverride,
        })
        return { success: true }
      } catch (err: any) {
        const msg: string = getErrorMessage(err) ?? 'Failed to update athlete allocations.'
        // Bug #3: a same-athlete double-booking is a soft warning, not a hard
        // failure. The mutation tags it with CONFLICT:: — surface it so the UI
        // can confirm and re-submit with confirmedOverride.
        if (typeof msg === 'string' && msg.includes('CONFLICT::')) {
          const human = (msg.split('CONFLICT::')[1] ?? '').split('\n')[0].trim()
          return { success: false, conflict: true, error: human || 'This athlete is already booked at that time.' }
        }
        return { success: false, error: msg }
      }
    },
    [updateAthleteSlotsMut]
  )

  return { addBooking, cancelBooking, updateBooking, modifyBooking, updateAthleteSlots }
}

// ── My Bookings source (owner-scoped, full history) ──────────────────────────
// The caller's OWN bookings — full past + future — sourced from the owner-scoped
// indexed queries (listBookingsByEmail ∪ listBookingsByUserId), INDEPENDENT of the
// narrow grid window. Narrowing the shared grid subscription therefore does NOT
// shorten a user's My Bookings history (COST-1 / FEB-1).
//
// Both queries are auth-gated to self/admin and return full owner PII. When
// impersonating (admin viewing a customer) only the email query runs, mirroring
// MyBookings' existing impersonation filter.
//
// The parent/athlete case is unaffected: a child inside a COACH's booking lives on
// a row owned by the coach, whose athleteSlots are already stripped server-side for
// non-owners (stripBookingPII) — so that row never carried allocations through the
// shared array either. No regression.
export function useMyBookings(opts: { email?: string; userId?: string; impersonating: boolean }) {
  const byEmailRes = useQuery(
    api.queries.listBookingsByEmail,
    opts.email ? { email: opts.email } : 'skip'
  )
  const byUserIdRes = useQuery(
    api.queries.listBookingsByUserId,
    (!opts.impersonating && opts.userId) ? { userId: opts.userId } : 'skip'
  )
  const myBookingsLoading = opts.email != null && byEmailRes === undefined
  const myBookings: Booking[] = useMemo(() => {
    const map = new Map<string, Booking>()
    for (const d of (byEmailRes ?? [])) map.set(String((d as any)._id), toBooking(d))
    for (const d of (byUserIdRes ?? [])) {
      const k = String((d as any)._id)
      if (!map.has(k)) map.set(k, toBooking(d))
    }
    return [...map.values()]
  }, [byEmailRes, byUserIdRes])
  return { myBookings, myBookingsLoading }
}

export function useBookings(window?: { from: string; to: string }) {
  // useQuery returns `undefined` until the first server result arrives. Coercing
  // straight to [] makes the calendar render a FULLY EMPTY day during that window
  // (the "empty calendar flash"). Track the loading state so the UI can hold the
  // grid back until real booking data is in.
  //
  // COST-1 (audit 2026-06): the reactive GRID subscription is bounded to roughly the
  // VISIBLE calendar range, not the whole table. Every booking write re-streams this
  // window to every connected client, so a narrow window is the single biggest Convex
  // saving at scale.
  //
  // COST-1b (2026-06-23): the GRID now subscribes to EXACTLY the week the user is
  // viewing — the caller (BookingCalendar) passes the date range of its visible week
  // strip (L1 coach = rolling `coachBookingWindowDays`, L2 coach + customer = the
  // Mon–Sun release week, or a past week under coach back-nav). Navigating weeks
  // changes the window, so Convex drops the old subscription and subscribes the new
  // one → only ~7–8 days are ever live per client. The legacy ~56-day window below is
  // kept only as a fallback for any caller that doesn't pass a window.
  // My Bookings own/past history is sourced separately (useMyBookings) from the
  // owner-scoped indexed queries, so narrowing this does NOT shorten a user's history.
  const defaultWindow = useMemo(() => {
    const key = (offsetDays: number) => {
      const d = new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000)
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    }
    let coachWindow = 8
    try { coachWindow = getSettingsStore().get().coachBookingWindowDays ?? 8 } catch { /* settings not ready yet */ }
    const futureDays = Math.max(35, coachWindow + 7)
    return { from: key(-21), to: key(futureDays) }
  }, [])
  const bookingWindow = window ?? defaultWindow
  const rawBookingsResult = useQuery(api.queries.listBookings, bookingWindow)
  const bookingsLoading = rawBookingsResult === undefined
  const rawBookings = rawBookingsResult ?? []
  const { user, isAdmin } = useAuth()
  // isAdmin is derived from customerRecord.role (real auth, not impersonated role) — correct under impersonation
  // betterAuthUser.id is always the real session user ID (correct under impersonation too)
  const currentUserId = user?.id
  const currentUserEmail = user?.email?.toLowerCase()
  const actions = useBookingActions()

  const bookings: Booking[] = useMemo(() => {
    return rawBookings.map(doc => {
      const b = toBooking(doc)
      // Admins see full data for all bookings.
      // Everyone else only gets PII for their own bookings — other users'
      // bookings are stripped to scheduling fields only (lane/time/status)
      // so the calendar can still show occupancy without exposing customer data.
      if (isAdmin) return b
      // A booking is "mine" if the auth subject matches OR the email matches.
      // N-9: admin-created manual bookings store userId = customers._id (not the
      // auth subject), so a userId-only check stripped the owner's own booking to
      // "Booked"/'' and it then failed My Bookings' email filter — invisible to the
      // customer. The email match mirrors the backend's own ownership logic.
      const mine =
        (currentUserId && b.userId === currentUserId) ||
        (currentUserEmail && b.customerEmail?.toLowerCase() === currentUserEmail)
      if (mine) return b
      return {
        ...b,
        customerName: 'Booked',
        customerEmail: '',
        customerPhone: undefined,
      }
    })
  }, [rawBookings, isAdmin, currentUserId, currentUserEmail])

  const canCancel = useCallback(
    (bookingId: string) => evaluateCancellation(bookings.find((b) => b.id === bookingId)),
    [bookings]
  )

  const canBookTime = useCallback(
    (date: string, startHour: number) => {
      const [year, month, day] = date.split('-').map(Number)
      const whole = Math.floor(startHour)
      const mins = Math.round((startHour - whole) * 60)
      const bookingStart = new Date(year, month - 1, day, whole, mins, 0)
      const now = getAWSTNow()
      const minutesUntil =
        (bookingStart.getTime() - now.getTime()) / (1000 * 60)
      const noticeMinutes = getSettingsStore().get().minBookingNoticeMinutes ?? 10
      if (minutesUntil < noticeMinutes) {
        return {
          allowed: false,
          reason: `Bookings must be made at least ${noticeMinutes} minute${noticeMinutes !== 1 ? 's' : ''} before the session starts.`,
        }
      }
      return { allowed: true }
    },
    []
  )

  const getBookingsForDate = useCallback(
    (dateKey: string) => {
      return bookings.filter(
        (b) => b.date === dateKey && b.status !== 'cancelled'
      )
    },
    [bookings]
  )

  const getBookingsByEmail = useCallback(
    (email: string) => {
      return bookings.filter(
        (b) => b.customerEmail.toLowerCase() === email.toLowerCase()
      )
    },
    [bookings]
  )

  const getAllIncludingCancelled = useCallback(() => {
    return bookings
  }, [bookings])

  return {
    bookings,
    bookingsLoading,
    ...actions,
    canCancel,
    canBookTime,
    getBookingsForDate,
    getBookingsByEmail,
    getAllIncludingCancelled,
  }
}
