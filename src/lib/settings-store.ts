// Site settings store - editable from admin panel

export type DayKey = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

export const DAY_KEYS: DayKey[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

export const DAY_LABELS: Record<DayKey, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
}

export interface DailyHours {
  open: number
  close: number
  closed: boolean
}

export interface SiteSettings {
  customerPricePerHour: number
  customerPrice90Min: number
  trumanPricePerHour: number
  trumanPrice90Min: number
  coachPerHour: number
  coachPer30Min?: number
  cancellationHoursBefore: number
  openingHour: number
  closingHour: number
  dailyHours: Record<DayKey, DailyHours>
  minBookingNoticeMinutes: number
  coachBookingWindowDays: number
  customerOpenDay: string
  customerOpenHour: number
  l1CoachOpenDay: string
  l1CoachOpenHour: number
  l2CoachOpenDay: string
  l2CoachOpenHour: number
  customerMaxDurationMinutes?: number
  coachMaxDurationMinutes?: number
  minAthleteDurationMinutes?: number
  coachRescheduleFreezeHours?: number
  extensionNoticeMinutes?: number
  coachLateCancellationHours?: number
  customerCancellationHours?: number
  abandonedCheckoutMinutes?: number
  registrationLocked?: boolean
  adminGateEnabled?: boolean
  adminUnlockMinutes?: number
}

const DEFAULT_DAILY_HOURS: Record<DayKey, DailyHours> = {
  monday: { open: 7, close: 21, closed: false },
  tuesday: { open: 7, close: 21, closed: false },
  wednesday: { open: 7, close: 21, closed: false },
  thursday: { open: 7, close: 21, closed: false },
  friday: { open: 7, close: 21, closed: false },
  saturday: { open: 7, close: 21, closed: false },
  sunday: { open: 7, close: 21, closed: false },
}

const DEFAULT_SETTINGS: SiteSettings = {
  customerPricePerHour: 40,
  customerPrice90Min: 55,
  trumanPricePerHour: 50,
  trumanPrice90Min: 70,
  coachPerHour: 25,
  coachPer30Min: 15,
  cancellationHoursBefore: 2,
  openingHour: 7,
  closingHour: 21,
  dailyHours: DEFAULT_DAILY_HOURS,
  minBookingNoticeMinutes: 10,
  coachBookingWindowDays: 8,
  customerOpenDay: 'sunday',
  customerOpenHour: 19,
  l1CoachOpenDay: 'always',
  l1CoachOpenHour: 0,
  l2CoachOpenDay: 'sunday',
  l2CoachOpenHour: 17,
  customerMaxDurationMinutes: 180,
  coachMaxDurationMinutes: 600,
  minAthleteDurationMinutes: 15,
  coachRescheduleFreezeHours: 24,
  extensionNoticeMinutes: 20,
  customerCancellationHours: 2,
  coachLateCancellationHours: 24,
  abandonedCheckoutMinutes: 10,
  registrationLocked: false,
  adminGateEnabled: false,
  adminUnlockMinutes: 45,
}

const JS_DAY_TO_KEY: DayKey[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function getDayKeyFromDate(date: Date | string): DayKey {
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00') : date
  return JS_DAY_TO_KEY[d.getDay()]
}

export function getHoursForDate(settings: SiteSettings, date: Date | string): DailyHours {
  const key = getDayKeyFromDate(date)
  return settings.dailyHours?.[key] ?? { open: settings.openingHour, close: settings.closingHour, closed: false }
}

type SettingsListener = (settings: SiteSettings) => void

class SettingsStore {
  private settings: SiteSettings
  private listeners: Set<SettingsListener> = new Set()

  constructor() {
    const saved = localStorage.getItem('rst_settings')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        this.settings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          dailyHours: { ...DEFAULT_DAILY_HOURS, ...(parsed.dailyHours ?? {}) },
        }
      } catch {
        this.settings = { ...DEFAULT_SETTINGS }
      }
    } else {
      this.settings = { ...DEFAULT_SETTINGS }
    }
  }

  get(): SiteSettings {
    return { ...this.settings, dailyHours: { ...this.settings.dailyHours } }
  }

  update(updates: Partial<SiteSettings>): void {
    this.settings = {
      ...this.settings,
      ...updates,
      dailyHours: updates.dailyHours
        ? { ...this.settings.dailyHours, ...updates.dailyHours }
        : this.settings.dailyHours,
    }
    localStorage.setItem('rst_settings', JSON.stringify(this.settings))
    this.notify()
  }

  updateDayHours(day: DayKey, hours: Partial<DailyHours>): void {
    this.settings = {
      ...this.settings,
      dailyHours: {
        ...this.settings.dailyHours,
        [day]: { ...this.settings.dailyHours[day], ...hours },
      },
    }
    localStorage.setItem('rst_settings', JSON.stringify(this.settings))
    this.notify()
  }

  reset(): void {
    this.settings = { ...DEFAULT_SETTINGS, dailyHours: { ...DEFAULT_DAILY_HOURS } }
    localStorage.removeItem('rst_settings')
    this.notify()
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    const snapshot = this.get()
    this.listeners.forEach(fn => fn(snapshot))
  }
}

let instance: SettingsStore | null = null

export function getSettingsStore(): SettingsStore {
  if (!instance) instance = new SettingsStore()
  return instance
}
