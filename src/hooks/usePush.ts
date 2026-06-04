import { useCallback, useEffect, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'

// SPEC_PWA_PUSH_NOTIFICATIONS §5.3 (frontend). VAPID PUBLIC key is NOT secret —
// it is the browser-facing application server key. Baked in with an env override
// so push works on prod without extra Vercel env config. The PRIVATE key lives
// only on Convex.
const VAPID_PUBLIC_KEY =
  (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ??
  'BBtVH_FpEdF6c8rcXMr4qzs1wpyXTC3mOY1JpgWRIL2XMFqqIfFIBuqV77WkxQBaYMaOMYtIqayUGvrX1WzxEAE'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

function deviceLabel(): string {
  const ua = navigator.userAgent
  let os = 'Device'
  if (/iphone/i.test(ua)) os = 'iPhone'
  else if (/ipad/i.test(ua)) os = 'iPad'
  else if (/android/i.test(ua)) os = 'Android'
  else if (/macintosh/i.test(ua)) os = (navigator.maxTouchPoints ?? 0) > 1 ? 'iPad' : 'Mac'
  else if (/windows/i.test(ua)) os = 'Windows'
  let browser = 'Browser'
  if (/edg/i.test(ua)) browser = 'Edge'
  else if (/crios|chrome/i.test(ua)) browser = 'Chrome'
  else if (/fxios|firefox/i.test(ua)) browser = 'Firefox'
  else if (/safari/i.test(ua)) browser = 'Safari'
  return `${os} · ${browser}`
}

type PermissionState = NotificationPermission | 'unsupported'

export function usePush() {
  const subscribePush = useMutation(api.pushNotifications.subscribePush)
  const unsubscribePushMut = useMutation(api.pushNotifications.unsubscribePush)

  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window

  const [permission, setPermission] = useState<PermissionState>(
    supported ? Notification.permission : 'unsupported'
  )
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)

  // Reflect the current subscription state on mount.
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    ;(async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        if (!cancelled) setIsSubscribed(!!sub)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [supported])

  // Subscribe this device: OS permission → pushManager.subscribe → store in Convex.
  const enable = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    if (!supported) return { ok: false, reason: 'This browser does not support notifications.' }
    setBusy(true)
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') {
        return { ok: false, reason: perm === 'denied' ? 'Notifications are blocked in your browser settings.' : 'Permission was not granted.' }
      }
      const reg = await navigator.serviceWorker.ready
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        })
      }
      const json = sub.toJSON()
      const keys = json.keys ?? {}
      if (!json.endpoint || !keys.p256dh || !keys.auth) {
        return { ok: false, reason: 'Could not create a push subscription.' }
      }
      await subscribePush({
        endpoint: json.endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        deviceLabel: deviceLabel(),
      })
      setIsSubscribed(true)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, reason: err?.message ?? 'Could not enable notifications.' }
    } finally {
      setBusy(false)
    }
  }, [supported, subscribePush])

  // Unsubscribe this device.
  const disable = useCallback(async (): Promise<boolean> => {
    if (!supported) return false
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const endpoint = sub.endpoint
        await sub.unsubscribe()
        await unsubscribePushMut({ endpoint })
      }
      setIsSubscribed(false)
      return true
    } catch {
      return false
    } finally {
      setBusy(false)
    }
  }, [supported, unsubscribePushMut])

  return { supported, permission, isSubscribed, busy, enable, disable }
}
