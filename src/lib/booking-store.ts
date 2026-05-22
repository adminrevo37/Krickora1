import { type Booking, LANES, CLOSING_HOUR, getAWSTNow, getCustomerPrice, getCoachPrice, formatDateKey, getNextWeekDate } from './booking-data'
import { getWaitlistStore } from './waitlist-store'
import { getUserStore } from './user-store'

type BookingListener = (bookings: Booking[]) => void

class BookingStore {
  private bookings: Booking[] = []
  private listeners: Set<BookingListener> = new Set()

  constructor(initialBookings: Booking[]) {
    this.bookings = [...initialBookings]
  }

  getAll(): Booking[] {
    return [...this.bookings]
  }

  getById(id: string): Booking | null {
    return this.bookings.find(b => b.id === id) ?? null
  }

  getByDate(dateKey: string): Booking[] {
    return this.bookings.filter(b => b.date === dateKey && b.status !== 'cancelled')
  }

  getByLaneAndDate(laneId: string, dateKey: string): Booking[] {
    return this.bookings.filter(b => b.laneId === laneId && b.date === dateKey && b.status !== 'cancelled')
  }

  getByUserEmail(email: string): Booking[] {
    return this.bookings.filter(b => b.customerEmail.toLowerCase() === email.toLowerCase())
  }

  getByUserId(userId: string): Booking[] {
    return this.bookings.filter(b => b.userId === userId)
  }

  getAllIncludingCancelled(): Booking[] {
    return [...this.bookings]
  }

  add(booking: Booking): void {
    const endHour = booking.startHour + booking.duration / 60
    const allLaneIds = [booking.laneId, ...(booking.additionalLaneIds ?? [])]
    for (const lid of allLaneIds) {
      const hasConflict = this.bookings.some(b => {
        if (b.laneId !== lid || b.date !== booking.date || b.status === 'cancelled') return false
        const bEnd = b.startHour + b.duration / 60
        return booking.startHour < bEnd && endHour > b.startHour
      })
      if (hasConflict) throw new Error('This slot is no longer available. Please choose another time.')
    }
    if (endHour > CLOSING_HOUR) throw new Error('Booking extends past closing time.')

    this.bookings.push({ ...booking })
    this.notify()
  }

  /**
   * Create a tentative booking for the same session next week.
   * Returns the tentative booking or null if the slot is taken.
   */
  createTentativeNextWeek(sourceBookingId: string, adjustedStartHour?: number): Booking | null {
    const source = this.bookings.find(b => b.id === sourceBookingId)
    if (!source || !source.isCoachBooking) return null

    const [year, month, day] = source.date.split('-').map(Number)
    const sourceDate = new Date(year, month - 1, day)
    const nextWeekDate = getNextWeekDate(sourceDate)
    const nextWeekKey = formatDateKey(nextWeekDate)
    const startHour = adjustedStartHour ?? source.startHour

    // Check for conflicts
    const endHour = startHour + source.duration / 60
    const allLaneIds = [source.laneId, ...(source.additionalLaneIds ?? [])]
    for (const lid of allLaneIds) {
      const hasConflict = this.bookings.some(b => {
        if (b.laneId !== lid || b.date !== nextWeekKey || b.status === 'cancelled') return false
        const bEnd = b.startHour + b.duration / 60
        return startHour < bEnd && endHour > b.startHour
      })
      if (hasConflict) return null
    }
    if (endHour > CLOSING_HOUR) return null

    const tentative: Booking = {
      id: crypto.randomUUID(),
      laneId: source.laneId,
      variantId: source.variantId,
      date: nextWeekKey,
      startHour,
      duration: source.duration,
      customerName: source.customerName,
      customerEmail: source.customerEmail,
      customerPhone: source.customerPhone,
      userId: source.userId,
      status: 'tentative',
      isCoachBooking: true,
      coachPrice: source.coachPrice,
      additionalLaneIds: source.additionalLaneIds,
      athleteSlots: source.athleteSlots ? [...source.athleteSlots.map(s => ({
        ...s,
        startHour: s.startHour - source.startHour + startHour,
      }))] : undefined,
      tentativeSourceId: source.id,
      tentativeForDate: nextWeekKey,
    }

    this.bookings.push(tentative)
    this.notify()
    return tentative
  }

  /**
   * Confirm a tentative booking (changes status from tentative to confirmed).
   */
  confirmTentative(bookingId: string): Booking | null {
    const booking = this.bookings.find(b => b.id === bookingId && b.status === 'tentative')
    if (!booking) return null
    booking.status = 'confirmed'
    booking.coachPrice = getCoachPrice(booking.duration)
    this.notify()
    return booking
  }

  /**
   * Cancel/remove a tentative booking.
   */
  cancelTentative(bookingId: string): boolean {
    const idx = this.bookings.findIndex(b => b.id === bookingId && b.status === 'tentative')
    if (idx === -1) return false
    this.bookings.splice(idx, 1)
    this.notify()
    return true
  }

  cancel(bookingId: string, userId?: string): Booking | null {
    const booking = this.bookings.find(b => b.id === bookingId)
    if (!booking || booking.status === 'cancelled') return null
    const cancelCheck = this.canCancel(bookingId)
    if (!cancelCheck.allowed) return null

    if (booking.isCoachBooking) {
      booking.status = 'cancelled'
      booking.cancelledAt = new Date().toISOString()
      booking.cancelledByUserId = userId
    } else {
      if (userId) {
        const lane = LANES.find(l => l.id === booking.laneId)
        if (lane) {
          const price = getCustomerPrice(lane, booking.variantId ?? null, booking.duration)
          const creditAmount = price - (booking.creditApplied ?? 0)
          if (creditAmount > 0) {
            const userStore = getUserStore()
            userStore.addCredit(userId, creditAmount)
          }
        }
      }
      booking.status = 'cancelled'
      booking.cancelledAt = new Date().toISOString()
      booking.cancelledByUserId = userId
    }

    this.notify()

    const lane = LANES.find(l => l.id === booking.laneId)
    if (lane) {
      const hours: number[] = []
      const endHour = booking.startHour + booking.duration / 60
      for (let h = booking.startHour; h < endHour; h += 0.5) hours.push(h)
      const waitlistStore = getWaitlistStore()
      waitlistStore.notifyWaitlistedUsers(booking.laneId, lane.name, booking.date, hours)
    }

    return booking
  }

  canCancel(bookingId: string): { allowed: boolean; reason?: string } {
    const booking = this.bookings.find(b => b.id === bookingId)
    if (!booking) return { allowed: false, reason: 'Booking not found.' }
    if (booking.status === 'cancelled') return { allowed: false, reason: 'Already cancelled.' }
    if (booking.status === 'tentative') return { allowed: true } // Tentative can always be cancelled
    const [year, month, day] = booking.date.split('-').map(Number)
    const whole = Math.floor(booking.startHour)
    const mins = Math.round((booking.startHour - whole) * 60)
    const bookingStart = new Date(year, month - 1, day, whole, mins, 0)
    const now = getAWSTNow()
    const hoursUntil = (bookingStart.getTime() - now.getTime()) / (1000 * 60 * 60)
    if (hoursUntil < 2) {
      return { allowed: false, reason: 'Bookings can only be cancelled or changed at least 2 hours before the session starts.' }
    }
    return { allowed: true }
  }

  canBookTime(date: string, startHour: number): { allowed: boolean; reason?: string } {
    const [year, month, day] = date.split('-').map(Number)
    const whole = Math.floor(startHour)
    const mins = Math.round((startHour - whole) * 60)
    const bookingStart = new Date(year, month - 1, day, whole, mins, 0)
    const now = getAWSTNow()
    const minutesUntil = (bookingStart.getTime() - now.getTime()) / (1000 * 60)
    if (minutesUntil < 10) {
      return { allowed: false, reason: 'Bookings must be made at least 10 minutes before the session starts.' }
    }
    return { allowed: true }
  }

  update(bookingId: string, updates: Partial<Booking>): Booking | null {
    const idx = this.bookings.findIndex(b => b.id === bookingId)
    if (idx === -1) return null
    this.bookings[idx] = { ...this.bookings[idx], ...updates }
    this.notify()
    return this.bookings[idx]
  }

  getCancelledCoachBookings(coachEmail: string): Booking[] {
    return this.bookings.filter(b =>
      b.isCoachBooking && b.status === 'cancelled' && b.customerEmail.toLowerCase() === coachEmail.toLowerCase()
    )
  }

  getRefilledAmount(_cancelledBooking: Booking): number {
    return 0
  }

  getCancelledCoachCharge(cancelledBooking: Booking): number {
    return cancelledBooking.coachPrice ?? getCoachPrice(cancelledBooking.duration)
  }

  /**
   * Get tentative bookings for a coach.
   */
  getTentativeBookings(userId: string): Booking[] {
    return this.bookings.filter(b => b.userId === userId && b.status === 'tentative')
  }

  subscribe(listener: BookingListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    const snapshot = this.getAll()
    this.listeners.forEach(fn => fn(snapshot))
  }
}

let storeInstance: BookingStore | null = null

export function getBookingStore(initialBookings?: Booking[]): BookingStore {
  if (!storeInstance) storeInstance = new BookingStore(initialBookings ?? [])
  return storeInstance
}

export { BookingStore }
