import { useState } from 'react'
import { useQuery, useMutation, useAction } from 'convex/react'
import { toast } from 'sonner'
import { api } from '../../convex/_generated/api'
import { useAuth } from '../hooks/useAuth'
import { usePush } from '../hooks/usePush'
import { usePwaInstall } from '../hooks/usePwaInstall'
import { categoriesForRole } from '../lib/pushCategories'

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-700'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
      role="switch"
      aria-checked={checked}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

export default function PushNotificationsCard() {
  const { user } = useAuth()
  const { supported, permission, isSubscribed, busy, enable, disable } = usePush()
  const { isStandalone, isIos } = usePwaInstall()

  const prefs = (useQuery(api.pushNotifications.getMyPushPreferences, {}) as Record<string, boolean> | undefined) ?? {}
  const devices = (useQuery(api.pushNotifications.listMyPushDevices, {}) as Array<{ endpoint: string; deviceLabel: string; lastSeenAt: number }> | undefined) ?? []
  const setPref = useMutation(api.pushNotifications.setMyPushPreference)
  const unsubscribe = useMutation(api.pushNotifications.unsubscribePush)
  const sendTest = useAction(api.push.sendTestPush)

  const [testing, setTesting] = useState(false)

  const role = user?.role ?? 'customer'
  const cats = categoriesForRole(role)
  const isOn = (key: string) => prefs[key] !== false

  const handleEnable = async () => {
    const res = await enable()
    if (res.ok) toast.success('Notifications enabled on this device')
    else toast.error(res.reason ?? 'Could not enable notifications')
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const res = await sendTest({})
      if (res.success) toast.success('Test sent — check your notifications')
      else toast.error(res.reason ?? 'Could not send a test notification')
    } catch {
      toast.error('Could not send a test notification')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden mb-6">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
        <h3 className="text-lg font-bold text-gray-800 dark:text-gray-200 flex items-center gap-2">🔔 Push Notifications</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Get instant alerts on this device. Email always sends regardless — push is an extra.
        </p>
      </div>

      <div className="p-6 space-y-5">
        {/* Master per-device state */}
        {!supported ? (
          isIos && !isStandalone ? (
            <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-4 text-sm text-amber-800 dark:text-amber-200">
              <p className="font-semibold mb-1">Add to your Home Screen first</p>
              <p>On iPhone/iPad, open this site in <strong>Safari</strong>, tap <strong>Share</strong> → <strong>Add to Home Screen</strong>, then open the app from your home screen to turn on notifications.</p>
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">This browser doesn't support push notifications.</p>
          )
        ) : permission === 'denied' ? (
          <div className="rounded-xl bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-4 text-sm text-gray-600 dark:text-gray-300">
            Notifications are blocked. Enable them for this site in your browser settings, then reload.
          </div>
        ) : isSubscribed ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> Enabled on this device
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleTest} disabled={testing} className="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-50">
                {testing ? 'Sending…' : 'Send test'}
              </button>
              <button onClick={disable} disabled={busy} className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 disabled:opacity-50">
                Turn off
              </button>
            </div>
          </div>
        ) : (
          <button onClick={handleEnable} disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-50">
            {busy ? 'Enabling…' : 'Enable notifications on this device'}
          </button>
        )}

        {/* Per-category toggles (saved server-side; apply to all your devices) */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">What to notify me about</p>
          <div className="space-y-3">
            {cats.map((c) => (
              <div key={c.key} className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-800 dark:text-gray-200 text-sm">{c.label}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{c.description}</div>
                </div>
                <Toggle checked={isOn(c.key)} onChange={(v) => setPref({ key: c.key, enabled: v })} />
              </div>
            ))}
          </div>
        </div>

        {/* Subscribed devices */}
        {devices.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Your devices</p>
            <div className="space-y-2">
              {devices.map((d) => (
                <div key={d.endpoint} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-gray-700 dark:text-gray-300">{d.deviceLabel}</span>
                  <button
                    onClick={async () => {
                      await unsubscribe({ endpoint: d.endpoint })
                      toast.success('Device removed')
                    }}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
