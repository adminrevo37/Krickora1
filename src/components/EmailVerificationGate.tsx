// SIGNUP-VERIFY-LOCKDOWN (2026-06) — hard-block gate for signed-in accounts whose
// email is not yet verified. Non-dismissible (no ✕, no backdrop close). Rendered by
// __root only when the signed-in, non-admin, non-impersonated user has
// emailVerified === false. It polls the session so that the moment the user clicks
// the verification link in their email (in any tab), the reactive useAuth user
// flips emailVerified=true, __root's condition goes false and this modal unmounts
// automatically — no manual refresh needed. The user can still sign out.
import { useEffect, useState } from 'react'
import { authClient, refreshSession, signOutUser } from '../lib/auth-client'

export default function EmailVerificationGate({ email }: { email: string }) {
  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  // Poll the session every 4s so verification (clicked in the email) auto-clears
  // the gate. refreshSession re-fetches the Better Auth session; the reactive
  // getCurrentUser query then re-runs with emailVerified=true and __root unmounts us.
  useEffect(() => {
    const id = setInterval(() => { void refreshSession() }, 4000)
    return () => clearInterval(id)
  }, [])

  const resend = async () => {
    setResending(true); setError(null)
    try {
      await (authClient as any).sendVerificationEmail({
        email,
        callbackURL: window.location.origin,
      })
      setResent(true)
    } catch (e: any) {
      setError(e?.message ?? 'Could not resend the email. Please try again shortly.')
    } finally {
      setResending(false)
    }
  }

  const checkNow = async () => {
    setChecking(true)
    await refreshSession()
    // Give the reactive query a moment; if still unverified the gate stays.
    setTimeout(() => setChecking(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-md overflow-hidden">
        <div className="p-5 bg-gradient-to-r from-emerald-500 to-green-500 text-white text-center">
          <div className="text-4xl mb-1">📧</div>
          <h3 className="text-lg font-bold">Verify your email</h3>
        </div>
        <div className="p-6 space-y-4 text-center">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Open the email from Cricket Revolution and tap the <strong>&ldquo;Verify email&rdquo;</strong> button to activate your account.
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            We sent it to<br />
            <span className="font-semibold text-gray-700 dark:text-gray-200">{email}</span>
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Check your <strong>spam</strong> folder too. It can take a few minutes to arrive with some providers (iiNet, Bigpond). If it never comes, the address may be mistyped — sign out and sign up again with the correct email.
          </p>
          <div className="flex items-center justify-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            This page unlocks automatically once you verify — you can close that tab and come back.
          </div>

          {resent && <div className="text-xs text-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg py-2 px-3">Verification email re-sent — check your inbox (and spam).</div>}
          {error && <div className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg py-2 px-3">{error}</div>}

          <div className="flex flex-col gap-2 pt-1">
            <button onClick={checkNow} disabled={checking}
              className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white font-semibold rounded-xl transition-colors">
              {checking ? 'Checking…' : "I've verified — check now"}
            </button>
            <button onClick={resend} disabled={resending}
              className="w-full py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 font-medium rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-60">
              {resending ? 'Sending…' : 'Resend verification email'}
            </button>
            <button onClick={() => signOutUser()}
              className="w-full py-2 text-sm text-gray-400 hover:text-red-500 transition-colors">
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
