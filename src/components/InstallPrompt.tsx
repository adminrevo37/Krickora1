import { useEffect, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { usePwaInstall } from '../hooks/usePwaInstall'
import { usePush } from '../hooks/usePush'

// SPEC_PWA_PUSH_NOTIFICATIONS §4.5 — gentle, platform-aware install nudge.
// Mounted once in __root. The nudge shows in the booking flow when not installed;
// dismiss is NOT permanent — it re-arms each time the user enters the booking
// flow. An "Install app" menu/footer item opens the same instructions modal via
// the `open-install-help` window event (so it works regardless of nudge state).

export const INSTALL_HELP_EVENT = 'open-install-help'
export function openInstallHelp() {
  window.dispatchEvent(new CustomEvent(INSTALL_HELP_EVENT))
}

export default function InstallPrompt() {
  const { isStandalone, canInstall, promptInstall, isIos, isIosSafari } = usePwaInstall()
  const { supported, permission, isSubscribed, enable } = usePush()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  const [dismissed, setDismissed] = useState(false)
  const [showModal, setShowModal] = useState(false)

  // Re-arm the nudge whenever the user enters the booking flow (the home/calendar).
  useEffect(() => {
    if (pathname === '/') setDismissed(false)
  }, [pathname])

  // Open the instructions modal from the menu/footer entry.
  useEffect(() => {
    const handler = () => setShowModal(true)
    window.addEventListener(INSTALL_HELP_EVENT, handler)
    return () => window.removeEventListener(INSTALL_HELP_EVENT, handler)
  }, [])

  const onBookingFlow = pathname === '/' || pathname === '/checkout/success'

  // Install nudge (not installed). On iOS show the "Add to Home Screen" route.
  const showInstallNudge = !isStandalone && (canInstall || isIos) && onBookingFlow && !dismissed
  // Once installed but push undecided: a one-time enable nudge.
  const showEnableNudge =
    isStandalone && supported && permission === 'default' && !isSubscribed && onBookingFlow && !dismissed

  const handleInstall = async () => {
    if (canInstall) {
      const ok = await promptInstall()
      if (!ok) setShowModal(true)
    } else {
      setShowModal(true)
    }
  }

  return (
    <>
      {(showInstallNudge || showEnableNudge) && (
        <div className="fixed bottom-3 inset-x-3 sm:left-auto sm:right-4 sm:w-96 z-[60]">
          <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-4 flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center shrink-0">
              <span className="text-white text-lg">🏏</span>
            </div>
            <div className="flex-1 min-w-0">
              {showEnableNudge ? (
                <>
                  <p className="text-sm font-bold text-gray-800">Turn on notifications</p>
                  <p className="text-xs text-gray-500 mt-0.5">Get your door code, reminders and changes pushed to this device.</p>
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => enable()} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white">Enable</button>
                    <button onClick={() => setDismissed(true)} className="px-3 py-1.5 text-xs font-medium rounded-lg text-gray-500 hover:bg-gray-100">Not now</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-bold text-gray-800">Add Cricket Revolution to your phone</p>
                  <p className="text-xs text-gray-500 mt-0.5">Book faster and get push alerts — install it like an app.</p>
                  <div className="mt-2 flex gap-2">
                    <button onClick={handleInstall} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white">
                      {canInstall ? 'Install' : 'How to install'}
                    </button>
                    <button onClick={() => setDismissed(true)} className="px-3 py-1.5 text-xs font-medium rounded-lg text-gray-500 hover:bg-gray-100">Not now</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <InstallHelpModal
          isIos={isIos}
          isIosSafari={isIosSafari}
          canInstall={canInstall}
          isStandalone={isStandalone}
          onInstall={async () => {
            const ok = await promptInstall()
            if (ok) setShowModal(false)
          }}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  )
}

function InstallHelpModal({
  isIos,
  isIosSafari,
  canInstall,
  isStandalone,
  onInstall,
  onClose,
}: {
  isIos: boolean
  isIosSafari: boolean
  canInstall: boolean
  isStandalone: boolean
  onInstall: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center">
            <span className="text-white text-lg">🏏</span>
          </div>
          <h3 className="text-lg font-bold text-gray-800">Install Cricket Revolution</h3>
        </div>

        {isStandalone ? (
          <p className="text-sm text-gray-600">The app is already installed on this device. 🎉</p>
        ) : isIos ? (
          <div className="space-y-3 text-sm text-gray-600">
            {!isIosSafari && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-amber-800">
                Open this page in <strong>Safari</strong> first — other iPhone browsers can't add a notifications-capable app.
              </div>
            )}
            <ol className="list-decimal list-inside space-y-2">
              <li>Tap the <strong>Share</strong> button (the square with an arrow).</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              <li>Tap <strong>Add</strong>, then open <strong>Revolution</strong> from your home screen.</li>
            </ol>
          </div>
        ) : canInstall ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">Install it as an app for one-tap booking and push notifications.</p>
            <button onClick={onInstall} className="w-full px-4 py-2.5 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white">
              Install now
            </button>
          </div>
        ) : (
          <div className="space-y-2 text-sm text-gray-600">
            <p>In your browser menu, choose <strong>Install app</strong> (or <strong>Add to Home screen</strong>).</p>
            <p className="text-xs text-gray-400">On desktop Chrome/Edge, look for the install icon in the address bar.</p>
          </div>
        )}

        <button onClick={onClose} className="mt-5 w-full px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">
          Close
        </button>
      </div>
    </div>
  )
}
