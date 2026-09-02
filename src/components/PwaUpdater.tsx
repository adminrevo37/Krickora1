import { useEffect } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'
import { isAppBusy } from '../lib/appBusy'

/**
 * Registers the service worker, applies waiting updates at safe moments, and
 * surfaces a non-blocking "new version" toast for the rest
 * (SPEC_PWA_PUSH_NOTIFICATIONS §4.3). Mounted once in __root.
 *
 * SYNC-4 structural (2026-08-14): waiting for a human to tap Reload was the reason
 * stale bundles persisted indefinitely. See the tier comment above the constants
 * below for how updates are now applied, and why workbox `skipWaiting` is still
 * deliberately not used.
 *
 * SYNC-4 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13) — CORRECTION to the previous
 * comment here (and in vite.config.ts), which claimed "a cold start always serves
 * the newest shell". It does NOT: navigations are served the PRECACHED index.html
 * via `navigateFallback` (there is no NetworkFirst navigation route). The auto-apply
 * below now clears stale installs in practice, but it cannot guarantee every client
 * has updated, so both consequences still stand:
 *   1. The Convex deploy discipline (deploy backend first; keep every new arg
 *      additive; never remove or rename a function a shipped client may still
 *      call; keep legacy response shapes alive) is PERMANENT, not just a
 *      deploy-window concern.
 *   2. A stale shell will try to fetch chunk filenames that no longer exist —
 *      see the chunk-load recovery below.
 */

// SYNC-3 — one-shot guard so a genuinely broken deploy can never reload-loop.
const RELOAD_FLAG = 'krickora.chunkReloadAttempted'

// ── SYNC-4 structural: apply the update ourselves, at a moment nothing is lost ──
//
// Detecting the update was already solved (hourly + visibilitychange
// registration.update()). APPLYING it still required a human to tap Reload, so an
// install whose user dismisses the toast kept a stale bundle indefinitely.
//
// The naive fix — workbox `skipWaiting: true` — is deliberately NOT used: it
// activates the new worker under a running page with no reload, swapping assets
// beneath live code, which is worse than the current behaviour. Instead we drive
// activation explicitly (`updateServiceWorker(true)` = SKIP_WAITING + reload) at
// two moments that cannot cost the user anything, and keep the toast for the rest:
//
//   Tier 1  cold start — a waiting worker found within COLD_START_MS of app start
//           and nothing open. Nothing is in flight, so this is free. Directly
//           fixes the finding's title ("never serves a new shell on cold start").
//   Tier 2  the page goes hidden (backgrounded) with nothing open. The user comes
//           back to a fresh app and never sees a reload. This is the tier that
//           actually drains stale installs, because iOS PWAs are resumed from
//           frozen far more often than they are cold-started.
//   Tier 3  anything else — the existing toast, unchanged.
//
// Both auto tiers are gated on isAppBusy(): since U8 every modal surface (incl.
// the Stripe embedded checkout) marks the app busy via ModalShell, so the
// "switched apps mid-payment to fetch my card, came back" case can never reload.
// STALE-BUNDLE FIX (2026-09-02). Two things starved the auto-apply:
//   1. The budget was "2 per tab session". A phone PWA's tab session lives for
//      WEEKS, so after two deploys it fell back to the toast forever — and a
//      dismissed toast meant a stale bundle indefinitely. The guard exists only to
//      stop a reload LOOP on a broken deploy, and a loop is fast — so the budget is
//      now a sliding WINDOW (2 applies per 10 min), which still stops a loop and
//      never starves a long-lived install.
//   2. The cold-start window was 15 s from module evaluation, but the waiting
//      worker only appears once it has precached ~1 MB — on a slow mobile link
//      that is often later than 15 s, so Tier 1 missed and the user sat on the
//      stale shell until they backgrounded the app. Window is now 60 s, and a
//      new "idle" tier applies whenever the user hasn't touched the page for 30 s.
// (The navigation route is now NetworkFirst too — see vite.config.ts — so the
// shell itself is fresh on any refresh regardless of what happens here.)
const AUTO_APPLY_LOG = 'krickora.swAutoApplyLog' // JSON array of ms timestamps
const MAX_AUTO_APPLIES_PER_WINDOW = 2
const AUTO_APPLY_WINDOW_MS = 10 * 60 * 1000
const COLD_START_MS = 60_000
const IDLE_MS = 30_000
// Module evaluation ≈ app start; a ref would reset on remount.
const APP_STARTED_AT = Date.now()
let lastInteractionAt = Date.now()
if (typeof window !== 'undefined') {
  const bump = () => { lastInteractionAt = Date.now() }
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) {
    window.addEventListener(ev, bump, { passive: true, capture: true })
  }
}

function recentApplies(): number[] {
  try {
    const arr = JSON.parse(sessionStorage.getItem(AUTO_APPLY_LOG) ?? '[]')
    const cutoff = Date.now() - AUTO_APPLY_WINDOW_MS
    return Array.isArray(arr) ? arr.filter((t: unknown) => typeof t === 'number' && t > cutoff) : []
  } catch {
    return []
  }
}
function autoApplyBudgetLeft(): boolean {
  try {
    if (typeof sessionStorage === 'undefined') return false // can't guard a loop
    return recentApplies().length < MAX_AUTO_APPLIES_PER_WINDOW
  } catch {
    return false
  }
}
function noteAutoApply() {
  try {
    sessionStorage.setItem(AUTO_APPLY_LOG, JSON.stringify([...recentApplies(), Date.now()]))
  } catch { /* ignore */ }
}

export default function PwaUpdater() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      // Check for a new deploy roughly hourly while the app stays open.
      setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000)
      // SYNC-4: an hourly timer never fires while a PWA is frozen in the
      // background (iOS), so resume is the moment that actually matters for
      // picking up a new deploy.
      const onVisible = () => {
        if (!document.hidden) registration.update().catch(() => {})
      }
      document.addEventListener('visibilitychange', onVisible)
    },
  })

  // SYNC-3 — stale-shell chunk-load recovery.
  //
  // C2 removed the admin chunks (rev-ops-7k2p, analytics *Tab-*, AdminBookingCalendar)
  // from the precache to keep them out of every customer's PWA install. Combined
  // with the stale-shell behaviour above that opened a hole: a pre-deploy shell
  // dynamic-imports a hashed chunk that no longer exists; because the admin route is
  // reached by CLIENT-side navigation, the navigateFallbackDenylist never applies;
  // the SPA rewrite then answers the missing .js with index.html and a 200, so the
  // browser reports "Failed to load module script (MIME text/html)" and the route
  // dies. Customer chunks are still precached, which is why this only ever bit the
  // admin machine (2026-08-12: needed a manual SW unregister + hard refresh).
  //
  // Recovering is safe and standard for hashed-chunk SPAs: activate the waiting SW
  // and reload once, which fetches the current shell and its current chunk names.
  useEffect(() => {
    const recover = (e: Event) => {
      // Vite fires this for a failed dynamic import / modulepreload.
      e.preventDefault?.()
      if (sessionStorage.getItem(RELOAD_FLAG)) return // already tried this session
      sessionStorage.setItem(RELOAD_FLAG, '1')
      updateServiceWorker(true)
    }
    window.addEventListener('vite:preloadError', recover)
    return () => window.removeEventListener('vite:preloadError', recover)
  }, [updateServiceWorker])

  // Clear the guard once the app has run cleanly for a moment, so a LATER deploy
  // in the same tab session can still self-recover.
  useEffect(() => {
    const t = setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 10_000)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!needRefresh) return

    const apply = () => {
      if (!autoApplyBudgetLeft()) return false
      if (isAppBusy()) return false
      noteAutoApply()
      updateServiceWorker(true) // SKIP_WAITING + reload
      return true
    }

    // Tier 1 — cold start. Nothing is in flight this early, so just take it.
    if (Date.now() - APP_STARTED_AT < COLD_START_MS && apply()) return
    // Tier 1b — already hidden when the update landed: nobody is looking.
    if (document.hidden && apply()) return

    // Tier 2 — apply when the app is backgrounded and nothing is open. Re-checked
    // on each transition: a user who backgrounds mid-checkout is busy and skipped,
    // and will be picked up on a later, idle backgrounding instead.
    const onHidden = () => { if (document.hidden) apply() }
    document.addEventListener('visibilitychange', onHidden)

    // Tier 2b — idle: the page is visible but untouched for IDLE_MS and nothing is
    // open. A reload here costs nothing the user is doing. Polled, cheap.
    const idleTimer = setInterval(() => {
      if (!document.hidden && Date.now() - lastInteractionAt >= IDLE_MS && apply()) {
        clearInterval(idleTimer)
      }
    }, 5_000)

    // Tier 3 — the visible, in-use case keeps the non-blocking toast it always had.
    toast('A new version of Cricket Revolution is available', {
      description: 'Reload to get the latest.',
      duration: Infinity,
      action: {
        label: 'Reload',
        onClick: () => updateServiceWorker(true),
      },
      onDismiss: () => setNeedRefresh(false),
    })

    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      clearInterval(idleTimer)
    }
  }, [needRefresh, updateServiceWorker, setNeedRefresh])

  return null
}
