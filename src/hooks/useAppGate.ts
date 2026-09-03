// SPEC_MOBILE_APP_GATE_2026-06 — "should a wall show right now, and which one?"
//
// Evaluated ONLY at the trigger points (BookingModal confirm, /bookings while
// logged out, and the calendar when scope is 'blanket') — never mounted globally.
// Stages, in order: install (iOS always; Android only if the admin says so) →
// login → push. Every rule here mirrors the spec's locked decisions and the iOS
// platform constraints (push only inside the installed app; a denied permission
// has no re-prompt, so the push stage is ALWAYS skippable and a denial ends it).
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAuth } from './useAuth'
import { usePwaInstall } from './usePwaInstall'
import { usePush } from './usePush'
import { useSettings } from './useSettings'

export type GateStage = 'none' | 'install' | 'login' | 'push'
export type GateTrigger = 'booking' | 'my-bookings' | 'blanket'

const SNOOZE_KEY = 'krickora.gatePushSnoozeUntil'
const ROLE_BYPASS_KEY = 'krickora.gateRoleBypass' // 'coach' | 'admin' once seen logged in

// Routes that ARE the login/action step — walling them breaks the flow they exist
// for. Hardcoded on purpose (spec decision b): a correctness list, not a knob.
const EXEMPT_PATH = /^\/(join|add-mate|reset-password|verify-email|checkout)(\/|$)/
const EXEMPT_SEARCH = /[?&](offer|token)=/

let version = 0
const listeners = new Set<() => void>()
function bump() { version++; listeners.forEach((l) => l()) }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
function getVersion() { return version }

function readSnoozeUntil(): number {
  try { return Number(localStorage.getItem(SNOOZE_KEY) ?? '0') || 0 } catch { return 0 }
}
function readRoleBypass(): string | null {
  try { return localStorage.getItem(ROLE_BYPASS_KEY) } catch { return null }
}

export function useAppGate(trigger: GateTrigger): {
  stage: GateStage
  dismissable: boolean
  snoozePush: () => void
} {
  const { user, isCoach, isAdmin, customerRecord } = useAuth()
  const { isStandalone, isIos, isAndroid } = usePwaInstall()
  const { supported, permission, isSubscribed } = usePush()
  const { settings } = useSettings()
  useSyncExternalStore(subscribe, getVersion, getVersion)

  // Remember a logged-in coach/admin so a later cold visit skips the install and
  // push stages (spec decision c).
  const role = (customerRecord as any)?.role
  if (user && (role === 'coach' || role === 'admin' || isCoach || isAdmin)) {
    try { localStorage.setItem(ROLE_BYPASS_KEY, isAdmin ? 'admin' : 'coach') } catch { /* ignore */ }
  }

  const snoozePush = useCallback(() => {
    const days = Math.max(1, Number(settings.mobileGatePushSnoozeDays ?? 14))
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + days * 86400e3)) } catch { /* ignore */ }
    bump()
  }, [settings.mobileGatePushSnoozeDays])

  const stage = useMemo<GateStage>(() => {
    if (typeof window === 'undefined') return 'none'
    if (settings.mobileGateEnabled !== true) return 'none'
    const scope = settings.mobileGateScope ?? 'booking-action'
    if (scope === 'off') return 'none'
    if (trigger === 'blanket' && scope !== 'blanket') return 'none'
    if (EXEMPT_PATH.test(window.location.pathname) || EXEMPT_SEARCH.test(window.location.search)) return 'none'
    const mobile = isIos || isAndroid
    if (!mobile) return 'none' // desktop untouched

    const roleBypass = readRoleBypass()
    const isStaff = !!user && (role === 'coach' || role === 'admin' || isCoach || isAdmin)

    // Stage 1 — install. iOS always (push only works in the installed app);
    // Android only when the admin has chosen the hard wall.
    if (!isStandalone && !roleBypass && !isStaff) {
      if (isIos || (isAndroid && settings.mobileGateAndroidHardWall === true)) return 'install'
    }
    // Stage 2 — login.
    if (!user) return 'login'
    // Stage 3 — push. Skippable; a denial is terminal (no re-prompt on iOS).
    if (isStaff && settings.mobileGateExemptCoachesFromPush !== false) return 'none'
    if (!supported) return 'none'
    if (isSubscribed || permission === 'granted' || permission === 'denied') return 'none'
    if (readSnoozeUntil() > Date.now()) return 'none'
    return 'push'
  }, [settings.mobileGateEnabled, settings.mobileGateScope, settings.mobileGateAndroidHardWall, settings.mobileGateExemptCoachesFromPush,
      trigger, isIos, isAndroid, isStandalone, user, role, isCoach, isAdmin, supported, permission, isSubscribed, version])

  return { stage, dismissable: stage === 'push', snoozePush }
}
