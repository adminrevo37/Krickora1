import { useState } from 'react'
import { signInWithEmail, signUpWithEmail, refreshSession, sendPasswordReset } from '../lib/auth-client'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import SnakeAlert from './SnakeAlert'
import PostcodeSuburbFields, { isLocationComplete } from './PostcodeSuburbFields'
import CoachMultiSelect from './CoachMultiSelect'
import { isValidAuMobile, normalizeAuMobile } from '../lib/phone'

const BLACKLIST_PHONES = ['0438952540', '+61438952540', '61438952540']
const BLACKLIST_EMAILS = ['jallenby@hotmail.com', 'jim.allenby@playerschoice.com.au', 'snake@test.com']

// SPEC_SIGNUP_UPDATES_2026-06 G5 — "How did you hear about us?" options. Shown as
// a FIXED RADIO LIST (Inspector: all options visible, not a dropdown). Required at
// signup; "Other" reveals a free-text box that must then be filled.
const REFERRAL_OPTIONS = [
  'Shenton Park Previous Customer',
  'Coached Athlete / Parent',
  'Online / Social Media',
  'Revo Cricket Shop Customer',
  'Other',
] as const

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

// A child-athlete row being entered on the signup form (G2).
interface ChildRow {
  firstName: string
  lastName: string
  coachIds: string[]
}

export default function AuthModal({ onClose, onSuccess, initialMode = 'signup', prefillEmail }: AuthModalProps) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const registrationLocked = useQuery(api.registrationLock.isRegistrationLocked)
  const ensureCustomer = useMutation(api.auth.ensureCustomerExists)
  const setupAthletes = useMutation(api.athletes.setupAthletesAtSignup)
  // Public coach list (works while logged out — see queries.listCoachesPublic).
  const coaches = useQuery(api.queries.listCoachesPublic, mode === 'signup' ? {} : 'skip') ?? []
  // SPEC_NAME_SPLIT: capture first + last separately for clean surname data.
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  // SPEC_PROFILE_POSTCODE_SUBURB: required at signup.
  const [location, setLocation] = useState({ postcode: '', suburb: '' })
  const [email, setEmail] = useState(prefillEmail ?? '')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  // SPEC_SIGNUP_UPDATES_2026-06 G2 — coaching capture.
  const [coachingYes, setCoachingYes] = useState(false)
  const [selfCoached, setSelfCoached] = useState(false)
  const [selfCoachIds, setSelfCoachIds] = useState<string[]>([])
  const [children, setChildren] = useState<ChildRow[]>([])
  // SPEC_SIGNUP_UPDATES_2026-06 G5 — referral.
  const [referralSource, setReferralSource] = useState('')
  const [referralOther, setReferralOther] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [showSnake, setShowSnake] = useState(false)

  const clearError = () => setError(null)

  const addChild = () => setChildren((prev) => [...prev, { firstName: '', lastName: '', coachIds: [] }])
  const removeChild = (idx: number) => setChildren((prev) => prev.filter((_, i) => i !== idx))
  const updateChild = (idx: number, patch: Partial<ChildRow>) =>
    setChildren((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)))

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

      // Computed coaching payload — used for both validation and the follow-up write.
      const completeChildren = children
        .map((c) => ({ firstName: c.firstName.trim(), lastName: c.lastName.trim(), coachIds: c.coachIds }))
        .filter((c) => c.firstName && c.lastName && c.coachIds.length > 0)
      const partialChildren = children.filter((c) => {
        const f = c.firstName.trim(), l = c.lastName.trim()
        const started = f || l || c.coachIds.length > 0
        const complete = f && l && c.coachIds.length > 0
        return started && !complete
      })
      const selfValid = selfCoached && selfCoachIds.length > 0

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
        const trimmedFirst = firstName.trim()
        const trimmedLast = lastName.trim()
        if (!trimmedFirst) {
          setError('Please enter your first name.')
          setIsLoading(false)
          return
        }
        // G7: last name now required for the account holder.
        if (!trimmedLast) {
          setError('Please enter your last name.')
          setIsLoading(false)
          return
        }
        if (!isValidAuMobile(phone)) {
          setError('Please enter a valid Australian mobile (e.g. 0412 345 678).')
          setIsLoading(false)
          return
        }
        if (!isLocationComplete(location)) {
          setError('Please enter a valid WA postcode and select your suburb.')
          setIsLoading(false)
          return
        }
        // G2 / Q6 — if "Yes" to coaching, the section must be meaningfully filled.
        if (coachingYes) {
          if (selfCoached && selfCoachIds.length === 0) {
            setError("Choose at least one coach for yourself, or untick 'I am being coached'.")
            setIsLoading(false)
            return
          }
          if (partialChildren.length > 0) {
            setError('Please complete each athlete (first name, last name and at least one coach) or remove the row.')
            setIsLoading(false)
            return
          }
          if (!selfValid && completeChildren.length === 0) {
            setError('Add who is being coached (you and/or an athlete), or choose “No”.')
            setIsLoading(false)
            return
          }
        }
        // G5 / Q3b — referral required; "Other" needs the free-text filled.
        if (!referralSource) {
          setError('Please tell us how you heard about us.')
          setIsLoading(false)
          return
        }
        if (referralSource === 'Other' && !referralOther.trim()) {
          setError('Please tell us how you heard about us (the “Other” box).')
          setIsLoading(false)
          return
        }
        const fullName = [trimmedFirst, trimmedLast].filter(Boolean).join(' ')
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

      // SPEC_NAME_SPLIT: the signup databaseHook created the row from the composed
      // name (best-effort split). Now persist the PRECISE first/last the user
      // typed (correct for multi-word surnames). Non-fatal — the row already
      // exists and the user can edit it in their profile.
      if (mode === 'signup') {
        // The Convex client's auth token can lag a beat behind the established
        // session, so this mutation (which requires the caller's identity) may be
        // rejected on the first try. Retry until it lands — this is what persists
        // the PRECISE first/last AND the required postcode/suburb/referral (the
        // databaseHook row has none). Non-fatal: the postcode login gate backstops
        // a total miss.
        let synced = false
        for (let attempt = 0; attempt < 8 && !synced; attempt++) {
          try {
            await ensureCustomer({
              email: email.trim().toLowerCase(),
              name: [firstName.trim(), lastName.trim()].filter(Boolean).join(' '),
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              postcode: location.postcode.trim(),
              suburb: location.suburb.trim(),
              phone: normalizeAuMobile(phone) ?? phone.trim(),
              referralSource,
              referralSourceOther: referralSource === 'Other' ? referralOther.trim() : undefined,
            })
            synced = true
          } catch (nameErr) {
            await new Promise(resolve => setTimeout(resolve, 700))
            if (attempt === 7) console.warn('[Auth] profile sync after signup failed (non-fatal):', nameErr)
          }
        }

        // G2 — persist the coaching capture AFTER the customer + self-athlete row
        // exist (ensureCustomer creates the self-athlete). Same retry-until-token
        // pattern; Convex mutations are transactional so retries can't duplicate.
        // Non-fatal: My Profile is the always-available fallback editor.
        const hasCoachingData = coachingYes && (selfValid || completeChildren.length > 0)
        if (hasCoachingData) {
          let athletesSynced = false
          for (let attempt = 0; attempt < 8 && !athletesSynced; attempt++) {
            try {
              await setupAthletes({
                selfCoachIds: selfValid ? selfCoachIds : [],
                athletes: completeChildren,
              })
              athletesSynced = true
            } catch (athErr) {
              await new Promise(resolve => setTimeout(resolve, 700))
              if (attempt === 7) console.warn('[Auth] athlete setup after signup failed (non-fatal):', athErr)
            }
          }
        }
      }

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

  const labelCls = 'text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5 block'
  const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-sm overflow-hidden max-h-[90vh] flex flex-col">
        <div className="bg-gradient-to-r from-emerald-500 to-green-500 p-5 text-white shrink-0">
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

        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto">
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
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>First Name</label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => { setFirstName(e.target.value); clearError() }}
                  placeholder="John"
                  required
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Last Name</label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => { setLastName(e.target.value); clearError() }}
                  placeholder="Smith"
                  required
                  className={inputCls}
                />
              </div>
            </div>
          )}

          <div>
            <label className={labelCls}>Email Address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); clearError() }}
              placeholder="your@email.com"
              required
              className={inputCls}
            />
          </div>

          {mode === 'signup' && (
            <div>
              <label className={labelCls}>Mobile</label>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => { setPhone(e.target.value); clearError() }}
                placeholder="0412 345 678"
                required
                className={inputCls}
              />
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Australian mobile — spaces are fine (e.g. 0412 345 678 or +61 412 345 678).</p>
            </div>
          )}

          {/* G2 — coaching capture (sits directly below Mobile) */}
          {mode === 'signup' && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-3">
              <div>
                <span className={labelCls}>Are you or any children being coached?</span>
                <div className="flex gap-2">
                  {[{ label: 'No', val: false }, { label: 'Yes', val: true }].map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => { setCoachingYes(opt.val); clearError() }}
                      className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                        coachingYes === opt.val
                          ? 'bg-emerald-500 text-white border-emerald-500'
                          : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-emerald-400'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {coachingYes && (
                <div className="space-y-3">
                  {/* Adult self-athlete */}
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={selfCoached}
                      onChange={(e) => { setSelfCoached(e.target.checked); clearError() }}
                      className="w-4 h-4 rounded accent-emerald-500"
                    />
                    I am being coached
                  </label>
                  {selfCoached && (
                    <div className="pl-6">
                      <CoachMultiSelect
                        dark
                        coaches={coaches}
                        value={selfCoachIds}
                        onChange={(ids) => { setSelfCoachIds(ids); clearError() }}
                        placeholder="Search your coach(es)…"
                      />
                    </div>
                  )}

                  {/* Children */}
                  {children.map((child, idx) => (
                    <div key={idx} className="rounded-lg border border-gray-200 dark:border-gray-700 p-2.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Athlete {idx + 1}</span>
                        <button type="button" onClick={() => removeChild(idx)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={child.firstName}
                          onChange={(e) => { updateChild(idx, { firstName: e.target.value }); clearError() }}
                          placeholder="First name"
                          className={inputCls}
                        />
                        <input
                          type="text"
                          value={child.lastName}
                          onChange={(e) => { updateChild(idx, { lastName: e.target.value }); clearError() }}
                          placeholder="Last name"
                          className={inputCls}
                        />
                      </div>
                      <CoachMultiSelect
                        dark
                        coaches={coaches}
                        value={child.coachIds}
                        onChange={(ids) => { updateChild(idx, { coachIds: ids }); clearError() }}
                        placeholder="Search this athlete's coach(es)…"
                      />
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={addChild}
                    className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 hover:underline"
                  >
                    + Athlete / Child
                  </button>

                  <p className="text-xs text-gray-400 dark:text-gray-500">You can update this anytime in My Profile.</p>
                </div>
              )}
            </div>
          )}

          {mode === 'signup' && (
            <PostcodeSuburbFields value={location} onChange={setLocation} idPrefix="signup" />
          )}

          {/* G5 — referral, fixed radio list near the end */}
          {mode === 'signup' && (
            <div>
              <span className={labelCls}>How did you hear about us?</span>
              <div className="space-y-1.5">
                {REFERRAL_OPTIONS.map((opt) => (
                  <label
                    key={opt}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${
                      referralSource === opt
                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-gray-900 dark:text-gray-100'
                        : 'border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-emerald-400'
                    }`}
                  >
                    <input
                      type="radio"
                      name="referralSource"
                      value={opt}
                      checked={referralSource === opt}
                      onChange={() => { setReferralSource(opt); clearError() }}
                      className="w-4 h-4 accent-emerald-500"
                    />
                    {opt}
                  </label>
                ))}
              </div>
              {referralSource === 'Other' && (
                <input
                  type="text"
                  value={referralOther}
                  onChange={(e) => { setReferralOther(e.target.value); clearError() }}
                  placeholder="Please tell us…"
                  className={`${inputCls} mt-2`}
                />
              )}
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
                onChange={(e) => { setPassword(e.target.value); clearError() }}
                placeholder={mode === 'signup' ? 'Min 10 characters' : 'Enter your password'}
                required
                minLength={mode === 'signup' ? 10 : undefined}
                className={inputCls}
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
