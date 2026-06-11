import { useEffect, useState } from 'react'
import { usePwaInstall } from '../hooks/usePwaInstall'

// SPEC_PWA_PUSH_NOTIFICATIONS §4.5 — "How to install" modal host.
// The bottom install/enable NUDGE was removed 2026-06-08 (Inspector): install
// instructions now live in the top InstallNagBanner (PushReminderBanners) and the
// push-enable prompt lives in the top PushTestHelperBanner. This component now ONLY
// hosts the instructions modal, opened from the "Install app" menu/footer item via
// the `open-install-help` window event (still needed on desktop, where the top
// mobile banner is hidden).

export const INSTALL_HELP_EVENT = 'open-install-help'
export function openInstallHelp() {
  window.dispatchEvent(new CustomEvent(INSTALL_HELP_EVENT))
}

export default function InstallPrompt() {
  const { isStandalone, canInstall, promptInstall, isIos, isIosSafari } = usePwaInstall()
  const [showModal, setShowModal] = useState(false)

  // Open the instructions modal from the "Install app" menu/footer entry.
  useEffect(() => {
    const handler = () => setShowModal(true)
    window.addEventListener(INSTALL_HELP_EVENT, handler)
    return () => window.removeEventListener(INSTALL_HELP_EVENT, handler)
  }, [])

  return (
    <>
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
