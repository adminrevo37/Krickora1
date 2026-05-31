import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getSettingsStore, type SiteSettings, type DayKey, type DailyHours, DAY_KEYS } from '../lib/settings-store'

const store = getSettingsStore()

// Every scalar/boolean setting that lives in Convex (siteSettings singleton) and
// must propagate to every device. dailyHours is synced separately (array ↔ Record).
const REMOTE_SCALAR_KEYS = [
  'customerPricePerHour', 'customerPrice90Min',
  'trumanPricePerHour', 'trumanPrice90Min',
  'coachPerHour', 'coachPer30Min',
  'cancellationHoursBefore', 'openingHour', 'closingHour',
  'minBookingNoticeMinutes', 'coachBookingWindowDays',
  'customerOpenDay', 'customerOpenHour',
  'l1CoachOpenDay', 'l1CoachOpenHour',
  'l2CoachOpenDay', 'l2CoachOpenHour',
  'customerMaxLanesPerBooking',
  'customerMaxDurationMinutes', 'coachMaxDurationMinutes',
  'minAthleteDurationMinutes', 'coachRescheduleFreezeHours',
  'extensionNoticeMinutes', 'customerCancellationHours',
  'coachLateCancellationHours', 'abandonedCheckoutMinutes',
  'registrationLocked', 'adminGateEnabled', 'adminUnlockMinutes',
] as const

const REMOTE_KEYS = new Set<string>([...REMOTE_SCALAR_KEYS, 'dailyHours'])

// Convex stores dailyHours as an array; the frontend uses a Record keyed by day.
function remoteHoursToRecord(arr: any): Partial<Record<DayKey, DailyHours>> | null {
  if (!Array.isArray(arr)) return null
  const out: Partial<Record<DayKey, DailyHours>> = {}
  for (const row of arr) {
    if (row && typeof row.day === 'string') {
      out[row.day as DayKey] = { open: row.open, close: row.close, closed: row.closed }
    }
  }
  return out
}

function recordToRemoteHours(rec: Record<DayKey, DailyHours>) {
  return DAY_KEYS.map((day) => ({
    day,
    open: rec[day].open,
    close: rec[day].close,
    closed: rec[day].closed,
  }))
}

export function useSettings() {
  const [localSettings, setLocalSettings] = useState<SiteSettings>(() => store.get())

  const currentUser = useQuery(api.auth.getCurrentUser)
  const remoteSettings = useQuery(api.queries.getSiteSettings, {})
  const updateSiteSettingsMutation = useMutation(api.mutations.updateSiteSettings)

  const isAdmin = currentUser?.role === 'admin'
  const isLoading = currentUser === undefined

  useEffect(() => {
    return store.subscribe((updated) => setLocalSettings(updated))
  }, [])

  // Sync remote settings into local store so the whole site reacts to admin changes live
  useEffect(() => {
    if (!remoteSettings) return
    const merged: Partial<SiteSettings> = {}
    for (const k of REMOTE_SCALAR_KEYS) {
      const v = (remoteSettings as any)[k]
      if (v !== undefined && v !== null) (merged as any)[k] = v
    }
    const hours = remoteHoursToRecord((remoteSettings as any).dailyHours)
    if (hours) (merged as any).dailyHours = hours
    if (Object.keys(merged).length > 0) {
      store.update(merged)
    }
  }, [remoteSettings])

  // Merged settings: remote overrides local defaults when available
  const settings: SiteSettings = useMemo(() => {
    if (!remoteSettings) return localSettings
    const merged: SiteSettings = { ...localSettings }
    for (const k of REMOTE_SCALAR_KEYS) {
      const v = (remoteSettings as any)[k]
      if (v !== undefined && v !== null) (merged as any)[k] = v
    }
    const hours = remoteHoursToRecord((remoteSettings as any).dailyHours)
    if (hours) merged.dailyHours = { ...localSettings.dailyHours, ...hours }
    return merged
  }, [remoteSettings, localSettings])

  const updateSettings = (updates: Partial<SiteSettings>) => {
    if (!isAdmin) return
    // Update local store immediately (optimistic)
    store.update(updates)
    // Push remote-synced fields to Convex so every device updates
    const remoteUpdates: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(updates)) {
      if (REMOTE_KEYS.has(k) && v !== undefined) remoteUpdates[k] = v
    }
    if (Object.keys(remoteUpdates).length > 0) {
      updateSiteSettingsMutation(remoteUpdates as any).catch((e) => {
        console.error('Failed to persist site settings:', e)
      })
    }
  }

  const updateDayHours = (day: DayKey, hours: Partial<DailyHours>) => {
    if (!isAdmin) return
    store.updateDayHours(day, hours)
    // Persist the full per-day hours array to Convex (single source of truth)
    updateSiteSettingsMutation({ dailyHours: recordToRemoteHours(store.get().dailyHours) } as any).catch((e) => {
      console.error('Failed to persist daily hours:', e)
    })
  }

  const resetSettings = () => {
    if (!isAdmin) return
    store.reset()
  }

  return { settings, updateSettings, updateDayHours, resetSettings, isAdmin, isLoading }
}

export default useSettings
