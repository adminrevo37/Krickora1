import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getSettingsStore, type SiteSettings, type DayKey, type DailyHours } from '../lib/settings-store'

const store = getSettingsStore()

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
    const keys: (keyof SiteSettings)[] = [
      'customerPricePerHour', 'customerPrice90Min',
      'trumanPricePerHour', 'trumanPrice90Min',
      'coachPerHour', 'coachPer30Min',
      'cancellationHoursBefore', 'openingHour', 'closingHour',
      'minBookingNoticeMinutes', 'coachBookingWindowDays',
      'customerOpenDay', 'customerOpenHour',
      'l1CoachOpenDay', 'l1CoachOpenHour',
      'l2CoachOpenDay', 'l2CoachOpenHour',
      'coachRescheduleFreezeHours', 'extensionNoticeMinutes',
      'customerMaxDurationMinutes', 'coachMaxDurationMinutes',
      'minAthleteDurationMinutes',
      'customerCancellationHours', 'coachLateCancellationHours',
    ]
    for (const k of keys) {
      const v = (remoteSettings as any)[k]
      if (v !== undefined && v !== null) (merged as any)[k] = v
    }
    if (Object.keys(merged).length > 0) {
      store.update(merged)
    }
  }, [remoteSettings])

  // Merged settings: remote overrides local defaults when available
  const settings: SiteSettings = useMemo(() => {
    if (!remoteSettings) return localSettings
    return {
      ...localSettings,
      customerPricePerHour: remoteSettings.customerPricePerHour ?? localSettings.customerPricePerHour,
      customerPrice90Min: remoteSettings.customerPrice90Min ?? localSettings.customerPrice90Min,
      trumanPricePerHour: remoteSettings.trumanPricePerHour ?? localSettings.trumanPricePerHour,
      trumanPrice90Min: remoteSettings.trumanPrice90Min ?? localSettings.trumanPrice90Min,
      coachPerHour: remoteSettings.coachPerHour ?? localSettings.coachPerHour,
      coachPer30Min: (remoteSettings as any).coachPer30Min ?? localSettings.coachPer30Min,
      cancellationHoursBefore: remoteSettings.cancellationHoursBefore ?? localSettings.cancellationHoursBefore,
      openingHour: remoteSettings.openingHour ?? localSettings.openingHour,
      closingHour: remoteSettings.closingHour ?? localSettings.closingHour,
      minBookingNoticeMinutes: remoteSettings.minBookingNoticeMinutes ?? localSettings.minBookingNoticeMinutes,
      coachBookingWindowDays: remoteSettings.coachBookingWindowDays ?? localSettings.coachBookingWindowDays,
      customerOpenDay: remoteSettings.customerOpenDay ?? localSettings.customerOpenDay,
      customerOpenHour: remoteSettings.customerOpenHour ?? localSettings.customerOpenHour,
      l1CoachOpenDay: (remoteSettings as any).l1CoachOpenDay ?? localSettings.l1CoachOpenDay,
      l1CoachOpenHour: (remoteSettings as any).l1CoachOpenHour ?? localSettings.l1CoachOpenHour,
      l2CoachOpenDay: (remoteSettings as any).l2CoachOpenDay ?? localSettings.l2CoachOpenDay,
      l2CoachOpenHour: (remoteSettings as any).l2CoachOpenHour ?? localSettings.l2CoachOpenHour,
      coachRescheduleFreezeHours: (remoteSettings as any).coachRescheduleFreezeHours ?? localSettings.coachRescheduleFreezeHours,
      extensionNoticeMinutes: (remoteSettings as any).extensionNoticeMinutes ?? localSettings.extensionNoticeMinutes,
      customerMaxDurationMinutes: (remoteSettings as any).customerMaxDurationMinutes ?? localSettings.customerMaxDurationMinutes,
      coachMaxDurationMinutes: (remoteSettings as any).coachMaxDurationMinutes ?? localSettings.coachMaxDurationMinutes,
      minAthleteDurationMinutes: (remoteSettings as any).minAthleteDurationMinutes ?? localSettings.minAthleteDurationMinutes,
      customerCancellationHours: (remoteSettings as any).customerCancellationHours ?? localSettings.customerCancellationHours,
      coachLateCancellationHours: (remoteSettings as any).coachLateCancellationHours ?? localSettings.coachLateCancellationHours,
    }
  }, [remoteSettings, localSettings])

  const REMOTE_KEYS = new Set([
    'customerPricePerHour', 'customerPrice90Min',
    'trumanPricePerHour', 'trumanPrice90Min',
    'coachPerHour', 'coachPer30Min',
    'cancellationHoursBefore', 'openingHour', 'closingHour',
    'minBookingNoticeMinutes', 'coachBookingWindowDays',
    'customerOpenDay', 'customerOpenHour',
    'l1CoachOpenDay', 'l1CoachOpenHour',
    'l2CoachOpenDay', 'l2CoachOpenHour',
    'coachRescheduleFreezeHours', 'extensionNoticeMinutes',
    'customerMaxDurationMinutes', 'coachMaxDurationMinutes',
    'minAthleteDurationMinutes',
    'customerCancellationHours', 'coachLateCancellationHours',
  ])

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
  }

  const resetSettings = () => {
    if (!isAdmin) return
    store.reset()
  }

  return { settings, updateSettings, updateDayHours, resetSettings, isAdmin, isLoading }
}

export default useSettings
