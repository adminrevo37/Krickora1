import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import { signOutUser } from '../lib/auth-client'
import PostcodeSuburbFields, { isLocationComplete } from './PostcodeSuburbFields'

// SPEC_PROFILE_POSTCODE_SUBURB — hard-block gate for existing accounts with no postcode.
// Non-dismissible (no backdrop close, no ✕). Rendered by __root only when the signed-in,
// non-admin, non-impersonated user is missing postcode/suburb. Once saved, the reactive
// useAuth user updates and __root stops rendering this. The user can still sign out.

export default function PostcodeRequiredModal({ email }: { email: string }) {
  const updateCustomerByEmail = useMutation(api.mutations.updateCustomerByEmail)
  const [location, setLocation] = useState({ postcode: '', suburb: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!isLocationComplete(location)) {
      setError('Please enter a valid WA postcode and select your suburb.')
      return
    }
    setSaving(true)
    try {
      await updateCustomerByEmail({
        email,
        postcode: location.postcode.trim(),
        suburb: location.suburb.trim(),
      })
      // No explicit close — the customer record now has a postcode, so the reactive
      // gate condition in __root flips false and this modal unmounts.
    } catch (err: any) {
      setError(getErrorMessage(err) || 'Could not save. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-sm overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-500 to-green-500 p-5 text-white">
          <h3 className="text-lg font-bold">One more thing</h3>
          <p className="text-white/80 text-sm mt-0.5">Please tell us where you live to continue.</p>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          )}
          <PostcodeSuburbFields value={location} onChange={setLocation} idPrefix="gate" />
          <button
            type="submit"
            disabled={saving}
            className="w-full py-3 bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600 text-white font-semibold rounded-xl shadow-lg shadow-emerald-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              'Save & Continue'
            )}
          </button>
          <button
            type="button"
            onClick={() => signOutUser()}
            className="w-full text-center text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  )
}
