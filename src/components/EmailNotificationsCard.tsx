import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'

type Pref = { slug: string; enabled: boolean }

interface Props {
  customerRecord: any
  userEmail?: string
  userName?: string
  updateCustomerByEmail: any
}

export default function EmailNotificationsCard({ customerRecord, userEmail, userName, updateCustomerByEmail }: Props) {
  const templates = (useQuery(api.queries.listEmailTemplates, {}) as Array<{ slug: string; label: string; description?: string }> | undefined) ?? []

  const prefs: Pref[] = customerRecord?.emailPrefs ?? []
  const isEnabled = (slug: string) => {
    const found = prefs.find(p => p.slug === slug)
    return found ? found.enabled : true
  }

  const handleToggle = async (slug: string, enabled: boolean) => {
    if (!userEmail) return
    const others = prefs.filter(p => p.slug !== slug)
    const nextPrefs = [...others, { slug, enabled }]
    await updateCustomerByEmail({
      email: userEmail,
      name: userName,
      emailPrefs: nextPrefs,
      ...(slug.startsWith('booking-')
        ? { bookingEmailsEnabled: nextPrefs.filter(p => p.slug.startsWith('booking-')).every(p => p.enabled) }
        : {}),
    })
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden mb-6">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
        <h3 className="text-lg font-bold text-gray-800 dark:text-gray-200 flex items-center gap-2">
          ✉️ Email Notifications
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Choose which emails you want to receive
        </p>
      </div>
      <div className="p-6 space-y-3">
        {templates.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">No notification types available yet.</p>
        )}
        {templates.map(t => {
          const enabled = isEnabled(t.slug)
          return (
            <div key={t.slug} className="flex items-start justify-between gap-4 py-2">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-800 dark:text-gray-200">{t.label}</div>
                {t.description && (
                  <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t.description}</div>
                )}
              </div>
              <button
                onClick={() => handleToggle(t.slug, !enabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  enabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-700'
                }`}
                role="switch"
                aria-checked={enabled}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    enabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
