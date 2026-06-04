import { useEffect } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'

/**
 * Registers the service worker and surfaces a non-blocking "new version" toast
 * (SPEC_PWA_PUSH_NOTIFICATIONS §4.3). Mounted once in __root. With registerType
 * 'prompt', the new SW waits until the user taps Reload — no surprise mid-session
 * reload — while a cold start always serves the newest shell so nobody is stranded.
 */
export default function PwaUpdater() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      // Check for a new deploy roughly hourly while the app stays open.
      if (registration) {
        setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000)
      }
    },
  })

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
