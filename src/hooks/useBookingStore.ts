import { useCallback, useMemo } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { type Booking, CLOSING_HOUR, getAWSTNow } from '../lib/booking-data'
import { getSettingsStore } from '../lib/settings-store'
import type { Id } from '../../convex/_generated/dataModel'

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
    additionalLaneIds: doc.additionalLaneIds,
    athleteSlots: doc.athleteSlots,
    creditApplied: doc.creditApplied,
    cancelledAt: doc.cancelledAt,
    cancelledByUserId: doc.cancelledByUserId,
    refilledMinutes: doc.refilledMinutes,
    originalCoachId: doc.originalCoachId,
    tentativeSourceId: doc.tentativeSourceId,
    tentativeForDate: doc.tentativeForDate,
    accessCode: doc.accessCode,
    discountCode: doc.discountCode,
    modificationHistory: doc.modificationHistory,
  }
}

export function useBookings() {
  const rawBookings = useQuery(api.queries.listBookings) ?? []
  const createBookingMut = useMutation(api.mutations.createBooking)
  const updateBookingMut = useMutation(api.mutations.updateBooking)
  const cancelBookingMut = useMutation(api.mutations.cancelBooking)
  const confirmTentativeMut = useMutation(api.mutations.confirmTentativeBooking)
  const createTentativeMut = useMutation(api.mutations.createTentativeNextWeek)
  const deleteBookingMut = useMutation(api.mutations.deleteBooking)
  const editDurationMut = useMutation(api.mutations.editBookingDuration)
  const rescheduleMut = useMutation(api.mutations.rescheduleBooking)
  const updateAthleteSlotsMut = useMutation(api.mutations.updateBookingAthleteSlots)

  const bookings: Booking[] = useMemo(
    () => rawBookings.map(toBooking),
    [rawBookings]
  )

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
        athleteSlots: booking.athleteSlots,
        creditApplied: booking.creditApplied,
        accessCode: booking.accessCode,
        discountCode: booking.discountCode,
        tentativeSourceId: booking.tentativeSourceId,
        tentativeForDate: booking.tentativeForDate,
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

  const canCancel = useCallback(
    (bookingId: string) => {
      const booking = bookings.find((b) => b.id === bookingId)
      if (!booking) return { allowed: false, reason: 'Booking not found.' }
      if (booking.status === 'cancelled')
        return { allowed: false, reason: 'Already cancelled.' }
      if (booking.status === 'tentative') return { allowed: true }
      const [year, month, day] = booking.date.split('-').map(Number)
      const whole = Math.floor(booking.startHour)
      const mins = Math.round((booking.startHour - whole) * 60)
      const bookingStart = new Date(year, month - 1, day, whole, mins, 0)
      const now = getAWSTNow()
      const hoursUntil =
        (bookingStart.getTime() - now.getTime()) / (1000 * 60 * 60)
      const s = getSettingsStore().get()
      // Coach bookings can always be cancelled, but will be charged if within the late-cancellation window
      if (booking.isCoachBooking) {
        const coachLateHours = s.coachLateCancellationHours
        if (hoursUntil < coachLateHours) {
          return { allowed: true, willBeCharged: true, reason: `Cancellation within ${coachLateHours} hours of booking — you will still be charged to your statement.` }
        }
        return { allowed: true }
      }
      const customerCancelHours = s.customerCancellationHours
      if (hoursUntil < customerCancelHours) {
        return {
          allowed: false,
          reason:
            `Bookings can only be cancelled or changed at least ${customerCancelHours} hour${customerCancelHours !== 1 ? 's' : ''} before the session starts.`,
        }
      }
      return { allowed: true }
    },
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
      if (minutesUntil < 10) {
        return {
          allowed: false,
          reason:
            'Bookings must be made at least 10 minutes before the session starts.',
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

  const updateBooking = useCallback(
    async (bookingId: string, updates: Partial<Booking>) => {
      const convexUpdates: Record<string, any> = {}
      if (updates.status !== undefined) convexUpdates.status = updates.status
      if (updates.athleteSlots !== undefined)
        convexUpdates.athleteSlots = updates.athleteSlots
      if (updates.coachPrice !== undefined)
        convexUpdates.coachPrice = updates.coachPrice
      if (updates.duration !== undefined)
        convexUpdates.duration = updates.duration
      if (updates.customerName !== undefined)
        convexUpdates.customerName = updates.customerName
      if (updates.customerEmail !== undefined)
        convexUpdates.customerEmail = updates.customerEmail
      if (updates.additionalLaneIds !== undefined)
        convexUpdates.additionalLaneIds = updates.additionalLaneIds
      if (updates.accessCode !== undefined)
        convexUpdates.accessCode = updates.accessCode
      if (updates.refilledMinutes !== undefined)
        convexUpdates.refilledMinutes = updates.refilledMinutes
      // UX-3: Forward scheduling + phone fields (previously dropped)
      if (updates.date !== undefined) convexUpdates.date = updates.date
      if (updates.startHour !== undefined) convexUpdates.startHour = updates.startHour
      if (updates.laneId !== undefined) convexUpdates.laneId = updates.laneId
      if (updates.customerPhone !== undefined) convexUpdates.customerPhone = updates.customerPhone

      await updateBookingMut({
        id: bookingId as Id<"bookings">,
        ...convexUpdates,
      })
      return bookings.find((b) => b.id === bookingId) ?? null
    },
    [updateBookingMut, bookings]
  )

  const createTentativeNextWeek = useCallback(
    async (sourceBookingId: string, adjustedStartHour?: number) => {
      try {
        const id = await createTentativeMut({
          sourceBookingId: sourceBookingId as Id<"bookings">,
          adjustedStartHour,
        })
        return id
      } catch {
        return null
      }
    },
    [createTentativeMut]
  )

  const confirmTentative = useCallback(
    async (bookingId: string) => {
      try {
        await confirmTentativeMut({
          id: bookingId as Id<"bookings">,
        })
        return true
      } catch {
        return false
      }
    },
    [confirmTentativeMut]
  )

  const cancelTentative = useCallback(
    async (bookingId: string) => {
      try {
        await deleteBookingMut({
          id: bookingId as Id<"bookings">,
        })
        return true
      } catch {
        return false
      }
    },
    [deleteBookingMut]
  )

  const getTentativeBookings = useCallback(
    (userId: string) => {
      return bookings.filter(
        (b) => b.userId === userId && b.status === 'tentative'
      )
    },
    [bookings]
  )

  const editBookingDuration = useCallback(
    async (bookingId: string, newDuration: number, userId: string) => {
      try {
        await editDurationMut({
          id: bookingId as Id<"bookings">,
          newDuration,
          userId,
        })
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err?.message ?? 'Failed to update duration.' }
      }
    },
    [editDurationMut]
  )

  const rescheduleBooking = useCallback(
    async (bookingId: string, opts: {
      newDate: string; newStartHour: number; newDuration: number;
      newLaneId?: string; newVariantId?: string;
      newAdditionalLaneIds?: string[]; userId: string; newAccessCode?: string;
    }) => {
      try {
        await rescheduleMut({
          id: bookingId as Id<"bookings">,
          newDate: opts.newDate,
          newStartHour: opts.newStartHour,
          newDuration: opts.newDuration,
          newLaneId: opts.newLaneId,
          newVariantId: opts.newVariantId,
          newAdditionalLaneIds: opts.newAdditionalLaneIds,
          userId: opts.userId,
          newAccessCode: opts.newAccessCode,
        })
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err?.message ?? 'Failed to reschedule.' }
      }
    },
    [rescheduleMut]
  )

  const updateAthleteSlots = useCallback(
    async (bookingId: string, athleteSlots: { athleteName: string; startHour: number; durationMinutes: number }[], userId: string) => {
      try {
        await updateAthleteSlotsMut({
          id: bookingId as Id<"bookings">,
          athleteSlots,
          userId,
        })
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err?.message ?? 'Failed to update athlete allocations.' }
      }
    },
    [updateAthleteSlotsMut]
  )

  return {
    bookings,
    addBooking,
    cancelBooking,
    canCancel,
    canBookTime,
    getBookingsForDate,
    getBookingsByEmail,
    getAllIncludingCancelled,
    updateBooking,
    editBookingDuration,
    rescheduleBooking,
    createTentativeNextWeek,
    confirmTentative,
    cancelTentative,
    getTentativeBookings,
    updateAthleteSlots,
  }
}
