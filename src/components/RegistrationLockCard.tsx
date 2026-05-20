import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useState } from 'react'

export default function RegistrationLockCard() {
  const locked = useQuery(api.registrationLock.isRegistrationLocked)
  const setLocked = useMutation(api.registrationLock.setRegistrationLocked)
  const [saving, setSaving] = useState(false)

  const toggle = async () => {
    setSaving(true)
    try {
      await setLocked({ locked: !locked })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">{locked ? '🔒' : '🔓'}</span>
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Registration Lock</h3>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {locked
              ? 'Public sign-ups are DISABLED. Only admins can create new user accounts manually.'
              : 'Public sign-ups are ENABLED. Anyone can register an account from the website.'}
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={saving || locked === undefined}
          className={`relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
            locked ? 'bg-red-500' : 'bg-emerald-500'
          }`}
          aria-pressed={!!locked}
        >
          <span
            className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition ${
              locked ? 'translate-x-7' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
      {locked && (
        <div className="mt-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 text-sm text-amber-800 dark:text-amber-300">
          ⚠️ While locked, the signup form will reject new registrations with a message directing users to contact admin.
        </div>
      )}
    </div>
  )
}
