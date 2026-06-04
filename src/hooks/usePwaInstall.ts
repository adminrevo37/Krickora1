import { useCallback, useEffect, useState } from 'react'

// SPEC_PWA_PUSH_NOTIFICATIONS §4.5 — platform-aware install detection.
//
// The browser fires `beforeinstallprompt` once, early, possibly before React
// mounts. We capture it at module load into a module-level slot + notify any
// subscribed hooks, so the custom "Install app" button always has the saved
// event to call .prompt() on.

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notify()
  })
}

function getIsStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (window.navigator as any).standalone === true
  )
}

function detectPlatform() {
  if (typeof navigator === 'undefined') {
    return { isIos: false, isIosSafari: false, isAndroid: false }
  }
  const ua = navigator.userAgent
  // iPadOS 13+ presents as "Macintosh" but is touch-capable.
  const isIos =
    /iphone|ipad|ipod/i.test(ua) ||
    (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)
  // All iOS browsers are WebKit; only genuine Safari reliably makes a
  // standalone, push-capable home-screen app. Exclude the in-app/third-party
  // iOS browser UAs.
  const isIosSafari =
    isIos && /Safari/.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA|Brave)/.test(ua)
  const isAndroid = /android/i.test(ua)
  return { isIos, isIosSafari, isAndroid }
}

export function usePwaInstall() {
  const [isStandalone, setIsStandalone] = useState(getIsStandalone)
  const [canInstall, setCanInstall] = useState(deferredPrompt !== null)
  const platform = detectPlatform()

  useEffect(() => {
    const update = () => {
      setCanInstall(deferredPrompt !== null)
      setIsStandalone(getIsStandalone())
    }
    listeners.add(update)
    const mq = window.matchMedia?.('(display-mode: standalone)')
    mq?.addEventListener?.('change', update)
    update()
    return () => {
      listeners.delete(update)
      mq?.removeEventListener?.('change', update)
    }
  }, [])

  // Trigger the native Android/desktop install prompt. Returns true if accepted.
  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferredPrompt) return false
    const evt = deferredPrompt
    await evt.prompt()
    const choice = await evt.userChoice
    if (choice.outcome === 'accepted') {
      deferredPrompt = null
      notify()
      return true
    }
    return false
  }, [])

  return {
    isStandalone,
    canInstall,
    promptInstall,
    isIos: platform.isIos,
    isIosSafari: platform.isIosSafari,
    isAndroid: platform.isAndroid,
  }
}
