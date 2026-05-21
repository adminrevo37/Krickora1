import { createFileRoute } from '@tanstack/react-router'
import { useMutation } from 'convex/react'
import { useState, useEffect } from 'react'
import { api } from '../../convex/_generated/api'
import { useAuth } from '../hooks/useAuth'
import EmailNotificationsCard from '../components/EmailNotificationsCard'

const SESSION_DURATION_OPTIONS = [30, 45, 60, 75, 90, 120]

export const Route = createFileRoute('/profile')({
  component: ProfilePage,
})

function ProfilePage() {
  const { user, isAuthenticated, isCoach, customerRecord } = useAuth()
  const updateCustomerByEmail = useMutation(api.mutations.updateCustomerByEmail)

  const [isEditing, setIsEditing] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Coach settings
  const [defaultSessionDuration, setDefaultSessionDuration] = useState<number>(60)
  const [savingCoachSettings, setSavingCoachSettings] = useState(false)
  const [coachSettingsMessage, setCoachSettingsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (user) {
      setName(user.name || '')
      setPhone(user.phone || '')
    }
  }, [user])

  useEffect(() => {
    if (customerRecord) {
      const dur = (customerRecord as any).defaultSessionDuration
      if (dur) setDefaultSessionDuration(dur)
    }
  }, [customerRecord])

  if (!isAuthenticated || !user) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">👤</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Sign in to view your profile</h2>
      </div>
    )
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setMessage(null)
    const trimmedName = name.trim()
    if (!trimmedName) {
      setMessage({ type: 'error', text: 'Name cannot be empty' })
      return
    }
    setSaving(true)
    try {
      await updateCustomerByEmail({
        email: user.email,
        name: trimmedName,
        phone: phone.trim() || undefined,
      })
      setMessage({ type: 'success', text: 'Profile updated successfully' })
      setIsEditing(false)
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Failed to update profile' })
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setName(user.name || '')
    setPhone(user.phone || '')
    setIsEditing(false)
    setMessage(null)
  }

  const handleSaveCoachSettings = async (e: React.FormEvent) => {
    e.preventDefault()
    setCoachSettingsMessage(null)
    setSavingCoachSettings(true)
    try {
      await updateCustomerByEmail({
        email: user.email,
        defaultSessionDuration,
      })
      setCoachSettingsMessage({ type: 'success', text: 'Coach settings saved' })
    } catch (err: any) {
      setCoachSettingsMessage({ type: 'error', text: err?.message || 'Failed to save' })
    } finally {
      setSavingCoachSettings(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">My Profile</h1>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-500 to-green-600 px-6 py-8">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 bg-white/20 backdrop-blur-sm rounded-2xl flex items-center justify-center text-white text-2xl font-bold border border-white/30">
              {user.name.trim().split(/\s+/).map(p => p.charAt(0).toUpperCase()).slice(0, 2).join('')}
            </div>
            <div className="text-white">
              <h2 className="text-xl font-bold">{user.name}</h2>
              <p className="text-emerald-100 text-sm">{user.email}</p>
              <span className="text-xs px-2 py-0.5 rounded-full bg-white/20 backdrop-blur-sm font-medium capitalize mt-1 inline-block">
                {user.role}
              </span>
            </div>
          </div>
        </div>

        {message && (
          <div className={`px-6 py-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 text-emerald-800 border-b border-emerald-100' : 'bg-red-50 text-red-800 border-b border-red-100'}`}>
            {message.text}
          </div>
        )}

        {!isEditing ? (
          <div className="p-6">
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Name</span><span className="font-medium text-gray-800">{user.name}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Email</span><span className="font-medium text-gray-800">{user.email}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Phone</span><span className="font-medium text-gray-800">{user.phone || '—'}</span></div>
            </div>
            <button
              onClick={() => setIsEditing(true)}
              className="mt-6 px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium text-sm hover:bg-emerald-700 transition-colors"
            >
              Edit Profile
            </button>
          </div>
        ) : (
          <form onSubmit={handleSave} className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={user.email}
                disabled
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
              />
              <p className="text-xs text-gray-500 mt-1">Email cannot be changed</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Optional"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-medium text-sm hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
      <div className="mt-6">
        <EmailNotificationsCard
          customerRecord={customerRecord}
          userEmail={user.email}
          userName={user.name}
          updateCustomerByEmail={updateCustomerByEmail}
        />
      </div>

      {isCoach && (
        <div className="mt-6 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-orange-500 to-amber-500 px-6 py-4">
            <h2 className="text-base font-bold text-white">🏅 Coach Settings</h2>
            <p className="text-orange-100 text-xs mt-0.5">Defaults used when creating athlete allocations</p>
          </div>

          {coachSettingsMessage && (
            <div className={`px-6 py-3 text-sm ${coachSettingsMessage.type === 'success' ? 'bg-emerald-50 text-emerald-800 border-b border-emerald-100' : 'bg-red-50 text-red-800 border-b border-red-100'}`}>
              {coachSettingsMessage.text}
            </div>
          )}

          <form onSubmit={handleSaveCoachSettings} className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Default session duration
              </label>
              <p className="text-xs text-gray-500 mb-2">
                Pre-fills the athlete slot length when you open the athlete allocator on a booking.
              </p>
              <select
                value={defaultSessionDuration}
                onChange={e => setDefaultSessionDuration(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
              >
                {SESSION_DURATION_OPTIONS.map(d => (
                  <option key={d} value={d}>{d} min</option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={savingCoachSettings}
              className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
            >
              {savingCoachSettings ? 'Saving...' : 'Save Coach Settings'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
