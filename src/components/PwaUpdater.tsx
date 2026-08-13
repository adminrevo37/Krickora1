import { useEffect } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'

/**
 * Registers the service worker and surfaces a non-blocking "new version" toast
 * (SPEC_PWA_PUSH_NOTIFICATIONS §4.3). Mounted once in __root. With registerType
 * 'prompt', the new SW waits until the user taps Reload — no surprise mid-session
 * reload.
 *
 * SYNC-4 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13) — CORRECTION to the previous
 * comment here (and in vite.config.ts), which claimed "a cold start always serves
 * the newest shell". It does NOT: navigations are served the PRECACHED index.html
 * via `navigateFallback` (there is no NetworkFirst navigation route), so an install
 * whose user never taps Reload can hold a stale bundle indefinitely. Two
 * consequences worth remembering:
 *   1. The Convex deploy discipline (deploy backend first; keep every new arg
 *      additive; never remove or rename a function a shipped client may still
 *      call; keep legacy response shapes alive) is PERMANENT, not just a
 *      deploy-window concern.
 *   2. A stale shell will try to fetch chunk filenames that no longer exist —
 *      see the chunk-load recovery below.
 */

// SYNC-3 — one-shot guard so a genuinely broken deploy can never reload-loop.
const RELOAD_FLAG = 'krickora.chunkReloadAttempted'

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
    toast('A new version of Cricket Revolution is available', {
      description: 'Reload to get the latest.',
      duration: Infinity,
      action: {
        label: 'Reload',
        onClick: () => updateServiceWorker(true),
      },
      onDismiss: () => setNeedRefresh(false),
    })
  }, [needRefresh, updateServiceWorker, setNeedRefresh])

  return null
}
