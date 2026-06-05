import { useState } from 'react'
import { useAction } from 'convex/react'
import { toast } from 'sonner'
import { api } from '../../convex/_generated/api'
import { useAuth } from '../hooks/useAuth'
import { usePush } from '../hooks/usePush'
import { usePwaInstall } from '../hooks/usePwaInstall'

/**
 * Two red, top-of-page reminders that push people onto the installed PWA + push
 * notifications (so we can stop leaning on email). Inspector spec 2026-06-05.
 *
 *  - In a normal WEB BROWSER (not the installed app): a PERMANENT, non-dismissable
 *    install nag with an expandable "Click for Instructions".
 *  - In the INSTALLED APP (standalone display-mode): a DISMISSABLE push-test helper
 *    with Test / Turn-off / Enable buttons, so a new user can confirm push works.
 *
 * Mounted once in __root for every authenticated user, on every page.
 */

const DISMISS_KEY = 'krickora.pushHelperDismissed'

export default function PushReminderBanners() {
  const { isAuthenticated } = useAuth()
  const { isStandalone, isIos, isAndroid } = usePwaInstall()
  // MOBILE ONLY — install/push prompts are for phone setup; desktop sees nothing
  // (Inspector 2026-06-05: keep the start-of-use experience clean on desktop).
  const isMobile = isIos || isAndroid
  if (!isMobile) return null
  // Installed app (standalone): the push-test helper — only useful once signed in.
  if (isStandalone) return isAuthenticated ? <PushTestHelperBanner /> : null
  // Mobile web browser: the install nag shows on EVERY page, logged in or out.
  return <InstallNagBanner />
}

// ── Browser: permanent install nag (not dismissable) ──────────────────────────
function InstallNagBanner() {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-red-600 text-white text-sm shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5">
        <div className="flex items-start sm:items-center justify-between gap-3 flex-wrap">
          <p className="font-medium leading-snug">
            📲 <strong>Install App &amp; Turn on Push Notifications</strong> to remove this reminder.{' '}
            <span className="text-red-100">We hate emails as much as you!</span>
          </p>
          <button
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 underline underline-offset-2 font-semibold hover:text-red-100"
            aria-expanded={open}
          >
            {open ? 'Hide instructions' : 'Click for Instructions'}
          </button>
        </div>

        {open && (
          <div className="mt-2 pt-2 border-t border-red-400/50 space-y-1.5 leading-relaxed">
            <p>
              <strong>iPhone</strong> → Use <u>Safari</u> → Share → Add to Home Screen → Save!
            </p>
            <p>
              <strong>Android</strong> → Use Chrome → Share → Add to Home Screen → Save!
            </p>
            <p>Exit web browser and click on the App saved on your home screen.</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Installed app: dismissable push-test helper ───────────────────────────────
function PushTestHelperBanner() {
  const { supported, permission, isSubscribed, busy, enable, disable } = usePush()
  const sendTest = useAction(api.push.sendTestPush)
  const [testing, setTesting] = useState(false)
  const [dismissed, setDismissed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1',
  )

  if (dismissed || !supported || permission === 'denied') return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ }
    setDismissed(true)
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const res = await sendTest({})
      if (res.success) toast.success('Test sent — check your notifications')
      else toast.error(res.reason ?? 'Could not send a test notification')
    } catch {
      toast.error('Could not send a test notification')
    } finally {
      setTesting(false)
    }
  }

  const handleEnable = async () => {
    const res = await enable()
    if (res.ok) toast.success('Notifications enabled on this device')
    else toast.error(res.reason ?? 'Could not enable notifications')
  }

  return (
    <div className="bg-red-600 text-white text-sm shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 leading-relaxed min-w-0">
            <p className="font-medium">🔔 Test push notification, you are done!</p>
            <p className="text-red-100">
              If the first push notification doesn't arrive? Turn off → Enable notifications on this
              device → Send test → Success! :)
            </p>
            <p className="text-red-100">Turn off email notifications in "My Profile".</p>
            <p className="font-semibold">Book your Nets!</p>

            {/* All three buttons so the troubleshoot sequence (Turn off → Enable →
                Send test) can be followed literally. */}
            <div className="flex flex-wrap items-center gap-2 pt-1.5">
              <button
                onClick={handleTest}
                disabled={testing}
                className="px-3 py-1.5 rounded-lg bg-white text-red-700 font-semibold hover:bg-red-50 disabled:opacity-50"
              >
                {testing ? 'Sending…' : 'Test Push Notifications'}
              </button>
              <button
                onClick={disable}
                disabled={busy || !isSubscribed}
                className="px-3 py-1.5 rounded-lg bg-red-700 text-white font-medium hover:bg-red-800 disabled:opacity-50"
              >
                Turn off
              </button>
              <button
                onClick={handleEnable}
                disabled={busy || isSubscribed}
                className="px-3 py-1.5 rounded-lg bg-red-700 text-white font-medium hover:bg-red-800 disabled:opacity-50"
              >
                {busy ? 'Enabling…' : 'Enable notifications on this device'}
              </button>
            </div>
          </div>

          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 text-red-100 hover:text-white text-lg leading-none font-bold"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  )
}
