import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { resetPassword } from '../lib/auth-client'

export const Route = createFileRoute('/reset-password')({
  component: ResetPasswordPage,
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
})

function ResetPasswordPage() {
  const { token } = Route.useSearch()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (password.length < 10) {
      setError('Password must be at least 10 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    const res = await resetPassword(token, password)
    setLoading(false)
    if (!res.success) {
      setError(res.error?.message || 'Could not reset your password. The link may have expired — request a new one.')
      return
    }
    setDone(true)
    setTimeout(() => navigate({ to: '/' }), 2500)
  }

  const inputCls =
    'w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-400'

  return (
    <div className="max-w-md mx-auto px-4 py-12">
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-6">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-1">Set your password</h1>

        {!token ? (
          <div className="mt-3 text-sm text-gray-600 dark:text-gray-400">
            <p>This link is missing its reset token. Please open the link from your email again, or request a new one.</p>
            <Link to="/" className="inline-block mt-4 text-emerald-600 dark:text-emerald-400 font-semibold hover:underline">
              Back to Cricket Revolution
            </Link>
          </div>
        ) : done ? (
          <div className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
            <p className="font-semibold">Password set. ✅</p>
            <p className="text-gray-600 dark:text-gray-400 mt-1">You can now log in. Taking you to the site…</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-3 space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-400">Choose a new password for your account (at least 10 characters).</p>
            <div>
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError('') }}
                className={inputCls}
                autoComplete="new-password"
                placeholder="At least 10 characters"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setError('') }}
                className={inputCls}
                autoComplete="new-password"
                placeholder="Re-enter your password"
              />
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-semibold transition-colors disabled:opacity-60"
            >
              {loading ? 'Setting password…' : 'Set password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
