// SPEC_MOBILE_APP_GATE_2026-06 — the wall screens. Same full-screen,
// non-dismissable pattern as EmailVerificationGate for install + login; the push
// step is always escapable (spec decision d).
import { useEffect, useRef, useState } from 'react'
import AuthModal from './AuthModal'
import { usePwaInstall } from '../hooks/usePwaInstall'
import { usePush } from '../hooks/usePush'
import { trackEvent } from '../lib/tracker'
import type { GateStage, GateTrigger } from '../hooks/useAppGate'

export default function AppGateWall({ stage, trigger, onSnooze }: { stage: GateStage; trigger: GateTrigger; onSnooze: () => void }) {
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (stage === 'none' || shown.current === stage) return
    shown.current = stage
    trackEvent('gate_shown', { stage, trigger })
  }, [stage, trigger])

  if (stage === 'install') return <InstallGateScreen trigger={trigger} />
  if (stage === 'login') {
    return (
      <AuthModal
        onClose={() => { /* non-dismissable: the wall clears when auth succeeds */ }}
        onSuccess={() => trackEvent('gate_passed', { stage: 'login', trigger })}
      />
    )
  }
  if (stage === 'push') return <PushGateScreen trigger={trigger} onSnooze={onSnooze} />
  return null
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6 max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center shrink-0"><span className="text-white text-lg">🏏</span></div>
          {children}
        </div>
      </div>
    </div>
  )
}

function InstallGateScreen({ trigger }: { trigger: GateTrigger }) {
  const { isIos, isIosSafari, canInstall, promptInstall } = usePwaInstall()
  const [busy, setBusy] = useState(false)
  const url = typeof window !== 'undefined' ? window.location.origin : 'https://cricketrevolution.com.au'
  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6 max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center shrink-0"><span className="text-white text-lg">🏏</span></div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">Install the app to book</h3>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          Booking, your door code and session reminders all work best from the installed app — it takes about 20 seconds and there's nothing to download from a store.
        </p>
        {isIos ? (
          <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
            {!isIosSafari && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-amber-800 dark:text-amber-300">
                <p className="font-semibold">Open this page in Safari first.</p>
                <p className="text-xs mt-1">Other iPhone browsers can't add an app that receives notifications. Copy the address and paste it into Safari:</p>
                <p className="mt-1.5 font-mono text-xs break-all select-all">{url}</p>
              </div>
            )}
            <ol className="list-decimal list-inside space-y-2">
              <li>Tap the <strong>Share</strong> button (the square with an arrow).</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              <li>Tap <strong>Add</strong>, then open <strong>Revolution</strong> from your home screen and finish your booking there.</li>
            </ol>
          </div>
        ) : canInstall ? (
          <button
            disabled={busy}
            onClick={async () => { setBusy(true); try { const ok = await promptInstall(); if (ok) trackEvent('gate_passed', { stage: 'install', trigger }) } finally { setBusy(false) } }}
            className="w-full px-4 py-2.5 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
          >
            Install now
          </button>
        ) : (
          <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
            <p>In your browser menu (⋮), choose <strong>Install app</strong> or <strong>Add to Home screen</strong>, then open <strong>Revolution</strong> from your home screen.</p>
          </div>
        )}
        <p className="text-[11px] text-gray-400 mt-4">Already installed? Open the app from your home screen — this page stays open in the browser.</p>
      </div>
    </div>
  )
}

function PushGateScreen({ trigger, onSnooze }: { trigger: GateTrigger; onSnooze: () => void }) {
  const { enable, busy } = usePush()
  const [error, setError] = useState<string | null>(null)
  return (
    <Frame>
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-bold text-gray-900 dark:text-white">Turn on notifications?</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
          Your door code, session reminders and waitlist offers arrive instantly on this phone — fewer emails, nothing missed.
        </p>
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => { trackEvent('gate_snoozed', { stage: 'push', trigger }); onSnooze() }}
            className="flex-1 px-3 py-2.5 text-sm font-semibold rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
          >
            Not now
          </button>
          <button
            disabled={busy}
            onClick={async () => {
              setError(null)
              const r = await enable()
              if (r.ok) trackEvent('gate_passed', { stage: 'push', trigger })
              else { setError(r.reason ?? 'Could not enable notifications.'); onSnooze() }
            }}
            className="flex-[2] px-3 py-2.5 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
          >
            {busy ? 'Turning on…' : 'Turn on'}
          </button>
        </div>
      </div>
    </Frame>
  )
}
