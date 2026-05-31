import { useState } from 'react'
import { signInWithEmail, signUpWithEmail, refreshSession, sendPasswordReset } from '../lib/auth-client'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import SnakeAlert from './SnakeAlert'

const BLACKLIST_PHONES = ['0438952540', '+61438952540', '61438952540']
const BLACKLIST_EMAILS = ['jallenby@hotmail.com', 'jim.allenby@playerschoice.com.au', 'snake@test.com']

function isBlacklisted(email: string, phone: string): boolean {
  const e = email.trim().toLowerCase()
  const p = phone.replace(/\s|-/g, '')
  if (BLACKLIST_EMAILS.includes(e)) return true
  if (p && BLACKLIST_PHONES.includes(p)) return true
  return false
}

interface AuthModalProps {
  onClose: () => void
  onSuccess: () => void
  initialMode?: 'signin' | 'signup'
  prefillEmail?: string
}

type Mode = 'signin' | 'signup' | 'forgot'

export default function AuthModal({ onClose, onSuccess, initialMode = 'signup', prefillEmail }: AuthModalProps) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const registrationLocked = useQuery(api.registrationLock.isRegistrationLocked)
  const [name, setName] = useState('')
  const [email, setEmail] = useState(prefillEmail ?? '')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [showSnake, setShowSnake] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setIsLoading(true)

    try {
      if (mode === 'forgot') {
        const result = await sendPasswordReset(email)
        setIsLoading(false)
        if (!result.success) {
          setError((result.error as any)?.message ?? 'Failed to send reset email')
          return
        }
        setInfo('If an account exists for that email, a password reset link has been sent. Check your inbox.')
        return
      }

      let result: { success: boolean; error?: { message?: string }; data?: any }

      if (mode === 'signup') {
        if (isBlacklisted(email, phone)) {
          setIsLoading(false)
          setShowSnake(true)
          return
        }
        if (registrationLocked) {
          setError('Registration is currently disabled. Please contact the administrator to create an account.')
          setIsLoading(false)
          return
        }
        const fullName = name.trim()
        if (!fullName) {
          setError('Please enter your full name.')
          setIsLoading(false)
          return
        }
        result = await signUpWithEmail(email, password, fullName)
      } else {
        result = await signInWithEmail(email, password)
      }

      if (!result.success) {
        setError(result.error?.message ?? 'Something went wrong')
        setIsLoading(false)
        return
      }

      // Verify session actually established (critical for mobile Safari ITP / third-party cookie blocking)
      let sessionEstablished = false
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const refreshed = await Promise.race([
            refreshSession(),
            new Promise<{ success: false }>(resolve => setTimeout(() => resolve({ success: false }), 2000)),
          ])
          if ((refreshed as any)?.success && (refreshed as any)?.data) {
            sessionEstablished = true
            break
          }
        } catch (refreshErr) {
          console.warn('[Auth] refreshSession attempt failed:', refreshErr)
        }
        await new Promise(resolve => setTimeout(resolve, 400))
      }

      if (!sessionEstablished) {
        setError('Sign-in succeeded but your browser is blocking the session cookie. Please enable cookies for this site (especially third-party cookies on mobile Safari) and try again.')
        setIsLoading(false)
        return
      }

      await new Promise(resolve => setTimeout(resolve, 200))

      onSuccess()
      onClose()
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong')
      setIsLoading(false)
    }
  }

  const headerTitle = mode === 'signup' ? 'Create Account' : mode === 'forgot' ? 'Reset Password' : 'Welcome Back'
  const headerSub = mode === 'signup'
    ? 'Sign up to book and manage sessions'
    : mode === 'forgot'
      ? "Enter your email and we'll send you a reset link"
      : 'Sign in to your account'

  if (showSnake) {
    return <SnakeAlert onClose={() => { setShowSnake(false); onClose() }} />
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-sm overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-500 to-green-500 p-5 text-white">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">{headerTitle}</h3>
              <p className="text-white/80 text-sm mt-0.5">{headerSub}</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
              <span>⚠️</span>
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          )}

          {info && (
            <div className="flex items-start gap-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-3 border border-emerald-200 dark:border-emerald-800/50">
              <span>✅</span>
              <p className="text-sm text-emerald-700 dark:text-emerald-400">{info}</p>
            </div>
          )}

          {mode === 'signup' && (
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5 block">Full Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(null) }}
                placeholder="John Smith"
                required
                className="w-full px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
              />
            </div>
          )}

          <div>
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5 block">Email Address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null) }}
              placeholder="your@email.com"
              required
              className="w-full px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
            />
          </div>

          {mode === 'signup' && (
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5 block">
                Phone <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="04XX XXX XXX"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
              />
            </div>
          )}

          {mode !== 'forgot' && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-semibold text-gray-700 dark:text-gray-300">Password</label>
                {mode === 'signin' && (
                  <button
                    type="button"
                    onClick={() => { setMode('forgot'); setError(null); setInfo(null) }}
                    className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null) }}
                placeholder={mode === 'signup' ? 'Min 10 characters' : 'Enter your password'}
                required
                minLength={mode === 'signup' ? 10 : undefined}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3 bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600 text-white font-semibold rounded-xl shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/40 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {mode === 'signup' ? 'Creating account...' : mode === 'forgot' ? 'Sending...' : 'Signing in...'}
              </>
            ) : mode === 'signup' ? (
              'Create Account'
            ) : mode === 'forgot' ? (
              'Send Reset Link'
            ) : (
              'Sign In'
            )}
          </button>

          <div className="text-center space-y-1">
            {mode === 'forgot' ? (
              <button
                type="button"
                onClick={() => { setMode('signin'); setError(null); setInfo(null) }}
                className="text-sm text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                ← Back to sign in
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(null); setInfo(null) }}
                className="text-sm text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                {mode === 'signup' ? 'Already have an account? Sign in' : "Don't have an account? Create one"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
