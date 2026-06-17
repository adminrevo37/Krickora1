// SIGNUP-VERIFY-LOCKDOWN (2026-06) — hard-block gate for signed-in accounts whose
// email is not yet verified. Non-dismissible (no ✕, no backdrop close). Rendered by
// __root only when the signed-in, non-admin, non-impersonated user has
// emailVerified === false. It polls the session so that the moment the user clicks
// the verification link in their email (in any tab), the reactive useAuth user
// flips emailVerified=true, __root's condition goes false and this modal unmounts
// automatically — no manual refresh needed. The user can still sign out.
//
// MISTYPED-EMAIL FIX (2026-06): a user who entered the wrong email at signup can
// correct it here and get a fresh link, instead of signing out + re-registering.
// users.correctUnverifiedEmail updates the Better Auth user + customers row (only
// while unverified); we then re-send verification to the new address.
import { useEffect, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { authClient, refreshSession, signOutUser } from '../lib/auth-client'
import { getErrorMessage } from '../lib/errors'

export default function EmailVerificationGate({ email }: { email: string }) {
  const correctEmail = useMutation(api.users.correctUnverifiedEmail)
  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  // Mistyped-email correction
  const [editing, setEditing] = useState(false)
  const [newEmail, setNewEmail] = useState(email)
  const [saving, setSaving] = useState(false)

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

  const openEdit = () => { setEditing(true); setNewEmail(email); setError(null); setResent(false) }
  const cancelEdit = () => { setEditing(false); setNewEmail(email); setError(null) }

  const updateEmail = async () => {
    setSaving(true); setError(null); setResent(false)
    try {
      const r: any = await correctEmail({ newEmail })
      const finalEmail: string = r?.email ?? newEmail.trim().toLowerCase()
      // Refresh the session so the gate shows the corrected address, then send a
      // fresh verification link to it.
      await refreshSession()
      await (authClient as any).sendVerificationEmail({
        email: finalEmail,
        callbackURL: window.location.origin,
      })
      setEditing(false)
      setResent(true)
    } catch (e: any) {
      setError(getErrorMessage(e) ?? e?.message ?? 'Could not update your email. Please try again.')
    } finally {
      setSaving(false)
    }
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
            Check your <strong>spam</strong> folder too. It can take a few minutes to arrive with some providers (iiNet, Bigpond). <strong>Mistyped your email?</strong> Fix it below and we'll send a fresh link.
          </p>
          <div className="flex items-center justify-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            This page unlocks automatically once you verify — you can close that tab and come back.
          </div>

          {resent && <div className="text-xs text-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg py-2 px-3">Verification email sent to <strong>{email}</strong> — check your inbox (and spam).</div>}
          {error && <div className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg py-2 px-3">{error}</div>}

          {editing ? (
            <div className="space-y-2 text-left bg-gray-50 dark:bg-gray-800/60 rounded-xl p-3 border border-gray-200 dark:border-gray-700">
              <label className="text-xs font-semibold text-gray-600 dark:text-gray-300 block">Correct your email address</label>
              <input
                type="email"
                inputMode="email"
                autoFocus
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <div className="flex gap-2 pt-1">
                <button onClick={cancelEdit} disabled={saving}
                  className="flex-1 py-2 text-sm rounded-xl bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-60">
                  Cancel
                </button>
                <button onClick={updateEmail} disabled={saving || !newEmail.trim() || newEmail.trim().toLowerCase() === email.toLowerCase()}
                  className="flex-1 py-2 text-sm rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold transition-colors disabled:opacity-60">
                  {saving ? 'Saving…' : 'Update & send link'}
                </button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 pt-1">
            <button onClick={checkNow} disabled={checking}
              className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white font-semibold rounded-xl transition-colors">
              {checking ? 'Checking…' : "I've verified — check now"}
            </button>
            <button onClick={resend} disabled={resending}
              className="w-full py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 font-medium rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-60">
              {resending ? 'Sending…' : 'Resend verification email'}
            </button>
            {!editing && (
              <button onClick={openEdit}
                className="w-full py-2 text-sm text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 font-medium transition-colors">
                Typed the wrong email? Fix it
              </button>
            )}
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
