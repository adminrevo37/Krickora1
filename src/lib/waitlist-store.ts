// Waitlist system — time-slot based
// Users waitlist a TIME SLOT (date + hour). If ANY lane opens at that time, they're notified.
// laneId is kept for backward-compat but new entries use '*' (any lane).

export interface WaitlistEntry {
  id: string
  userId: string
  userName: string
  userEmail: string
  laneId: string // '*' = any lane (new), or specific lane id (legacy)
  date: string // YYYY-MM-DD
  hour: number
  createdAt: string
  notified: boolean
}

export interface WaitlistNotification {
  id: string
  userId: string
  userEmail: string
  userName: string
  laneId: string
  laneName: string
  date: string
  hour: number
  sentAt: string
  bookingUrl: string
}

type WaitlistListener = (entries: WaitlistEntry[]) => void
type NotificationListener = (notifications: WaitlistNotification[]) => void

const ANY_LANE = '*'

class WaitlistStore {
  private entries: WaitlistEntry[] = []
  private notifications: WaitlistNotification[] = []
  private listeners: Set<WaitlistListener> = new Set()
  private notifListeners: Set<NotificationListener> = new Set()

  constructor() {
    try {
      const saved = localStorage.getItem('rst_waitlist')
      if (saved) this.entries = JSON.parse(saved)
      const notifs = localStorage.getItem('rst_waitlist_notifs')
      if (notifs) this.notifications = JSON.parse(notifs)
    } catch {}
  }

  private persist() {
    localStorage.setItem('rst_waitlist', JSON.stringify(this.entries))
    localStorage.setItem('rst_waitlist_notifs', JSON.stringify(this.notifications))
  }

  private notify() {
    const snapshot = [...this.entries]
    this.listeners.forEach(fn => fn(snapshot))
  }

  private notifyNotifications() {
    const snapshot = [...this.notifications]
    this.notifListeners.forEach(fn => fn(snapshot))
  }

  getAll(): WaitlistEntry[] {
    return [...this.entries]
  }

  getByUser(userId: string): WaitlistEntry[] {
    return this.entries.filter(e => e.userId === userId)
  }

  // Returns entries for a specific slot (specific laneId OR wildcard '*')
  getForSlot(laneId: string, date: string, hour: number): WaitlistEntry[] {
    return this.entries.filter(e =>
      e.date === date &&
      e.hour === hour &&
      (e.laneId === laneId || e.laneId === ANY_LANE)
    )
  }

  // Returns entries specifically for this time slot (any lane)
  getForTimeSlot(date: string, hour: number): WaitlistEntry[] {
    return this.entries.filter(e => e.date === date && e.hour === hour)
  }

  getNotifications(userId: string): WaitlistNotification[] {
    return this.notifications.filter(n => n.userId === userId)
  }

  // Checks if user is on waitlist for this time slot (any lane)
  isOnWaitlist(userId: string, _laneId: string, date: string, hour: number): boolean {
    return this.entries.some(e =>
      e.userId === userId && e.date === date && e.hour === hour
    )
  }

  addToWaitlist(entries: Omit<WaitlistEntry, 'id' | 'createdAt' | 'notified'>[]): WaitlistEntry[] {
    const newEntries: WaitlistEntry[] = []
    for (const entry of entries) {
      // Normalize all new entries to wildcard (time-slot based)
      const laneId = ANY_LANE
      if (this.isOnWaitlist(entry.userId, laneId, entry.date, entry.hour)) continue

      const newEntry: WaitlistEntry = {
        ...entry,
        laneId,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        notified: false,
      }
      this.entries.push(newEntry)
      newEntries.push(newEntry)
    }
    this.persist()
    this.notify()
    return newEntries
  }

  removeFromWaitlist(entryId: string): boolean {
    const idx = this.entries.findIndex(e => e.id === entryId)
    if (idx === -1) return false
    this.entries.splice(idx, 1)
    this.persist()
    this.notify()
    return true
  }

  removeUserFromSlot(userId: string, _laneId: string, date: string, hour: number): boolean {
    const idx = this.entries.findIndex(e =>
      e.userId === userId && e.date === date && e.hour === hour
    )
    if (idx === -1) return false
    this.entries.splice(idx, 1)
    this.persist()
    this.notify()
    return true
  }

  // Called when a booking is cancelled — notify all users waitlisted for that time slot
  // (any lane in that time window is a match)
  notifyWaitlistedUsers(
    laneId: string,
    laneName: string,
    date: string,
    hours: number[]
  ): WaitlistNotification[] {
    const sentNotifications: WaitlistNotification[] = []
    const notifiedEntryIds = new Set<string>()

    for (const hour of hours) {
      const waitlisted = this.getForSlot(laneId, date, hour)
      for (const entry of waitlisted) {
        entry.notified = true
        notifiedEntryIds.add(entry.id)

        const notification: WaitlistNotification = {
          id: crypto.randomUUID(),
          userId: entry.userId,
          userEmail: entry.userEmail,
          userName: entry.userName,
          laneId,
          laneName,
          date,
          hour,
          sentAt: new Date().toISOString(),
          bookingUrl: `/?book=${laneId}&date=${date}&hour=${hour}`,
          dismissed: false as unknown as never,
        } as WaitlistNotification
        this.notifications.push(notification)
        sentNotifications.push(notification)
      }
    }

    // Remove entries that were notified
    this.entries = this.entries.filter(e => !notifiedEntryIds.has(e.id))

    this.persist()
    this.notify()
    this.notifyNotifications()
    return sentNotifications
  }

  dismissNotification(notifId: string) {
    this.notifications = this.notifications.filter(n => n.id !== notifId)
    this.persist()
    this.notifyNotifications()
  }

  subscribe(listener: WaitlistListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscribeNotifications(listener: NotificationListener): () => void {
    this.notifListeners.add(listener)
    return () => { this.notifListeners.delete(listener) }
  }
}

let instance: WaitlistStore | null = null
export function getWaitlistStore(): WaitlistStore {
  if (!instance) instance = new WaitlistStore()
  return instance
}
