import { createFileRoute } from '@tanstack/react-router'
import { useMutation } from 'convex/react'
import { useState, useEffect } from 'react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import { useAuth } from '../hooks/useAuth'
import EmailNotificationsCard from '../components/EmailNotificationsCard'
import PushNotificationsCard from '../components/PushNotificationsCard'
import MyAthletesCard from '../components/MyAthletesCard'
import MyMatesCard from '../components/MyMatesCard'
import PostcodeSuburbFields, { isLocationComplete } from '../components/PostcodeSuburbFields'

export const Route = createFileRoute('/profile')({
  component: ProfilePage,
})

function ProfilePage() {
  const { user, isAuthenticated, customerRecord } = useAuth()
  const updateCustomerByEmail = useMutation(api.mutations.updateCustomerByEmail)

  const [isEditing, setIsEditing] = useState(false)
  // SPEC_NAME_SPLIT: edit first/last as the source fields; `name` is derived.
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  // SPEC_PROFILE_POSTCODE_SUBURB: editable location (all roles).
  const [location, setLocation] = useState({ postcode: '', suburb: '' })
  // SPEC_COACH_SESSION_LENGTH §2.2: a coach's default athlete session length
  // (self-editable; athleteCapacity stays admin-managed).
  const isCoach = user?.role === 'coach'
  const [sessionLength, setSessionLength] = useState(60)
  // Coach allocation mode: false (default/unticked) = sequential — auto-advance the
  // next athlete's start + smart-order the picker; true (ticked) = coaches multiple
  // athletes at once (current independent behaviour).
  const [coachesSimultaneously, setCoachesSimultaneously] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Seed from stored first/last; fall back to splitting the display name on the
  // last space for accounts created before the name-split migration.
  const seedNames = () => {
    const cr = customerRecord as any
    const storedFirst = (cr?.firstName ?? '').trim()
    const storedLast = (cr?.lastName ?? '').trim()
    if (storedFirst || storedLast) {
      setFirstName(storedFirst)
      setLastName(storedLast)
      return
    }
    const full = (user?.name ?? '').trim().replace(/\s+/g, ' ')
    const idx = full.lastIndexOf(' ')
    setFirstName(idx === -1 ? full : full.slice(0, idx))
    setLastName(idx === -1 ? '' : full.slice(idx + 1))
  }

  useEffect(() => {
    if (user) {
      seedNames()
      setPhone(user.phone || '')
      const cr = customerRecord as any
      setLocation({ postcode: (cr?.postcode ?? '').trim(), suburb: (cr?.suburb ?? '').trim() })
      setSessionLength(Math.min(cr?.defaultSessionDuration ?? 60, 90))
      setCoachesSimultaneously(cr?.coachesSimultaneously ?? false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, customerRecord])

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
    const trimmedFirst = firstName.trim()
    const trimmedLast = lastName.trim()
    if (!trimmedFirst) {
      setMessage({ type: 'error', text: 'First name cannot be empty' })
      return
    }
    // Bug 5: coaches have no postcode requirement — gating the WHOLE save on a
    // complete location silently blocked a coach from saving their session length
    // (the "doom loop"). Only enforce the location for non-coaches.
    if (!isCoach && !isLocationComplete(location)) {
      setMessage({ type: 'error', text: 'Please enter a valid WA postcode and select your suburb.' })
      return
    }
    setSaving(true)
    try {
      await updateCustomerByEmail({
        email: user.email,
        firstName: trimmedFirst,
        lastName: trimmedLast,
        phone: phone.trim() || undefined,
        postcode: location.postcode.trim(),
        suburb: location.suburb.trim(),
        // §2.2: coaches save their own default session length + allocation mode.
        ...(isCoach ? { defaultSessionDuration: sessionLength, coachesSimultaneously } : {}),
      })
      setMessage({ type: 'success', text: 'Profile updated successfully' })
      setIsEditing(false)
    } catch (err: any) {
      setMessage({ type: 'error', text: getErrorMessage(err) || 'Failed to update profile' })
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    seedNames()
    setPhone(user.phone || '')
    const cr = customerRecord as any
    setLocation({ postcode: (cr?.postcode ?? '').trim(), suburb: (cr?.suburb ?? '').trim() })
    setSessionLength(Math.min(cr?.defaultSessionDuration ?? 60, 90))
    setCoachesSimultaneously(cr?.coachesSimultaneously ?? false)
    setIsEditing(false)
    setMessage(null)
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
              <div className="flex justify-between"><span className="text-gray-500">Suburb</span><span className="font-medium text-gray-800">{location.suburb || '—'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Postcode</span><span className="font-medium text-gray-800">{location.postcode || '—'}</span></div>
              {isCoach && (
                <div className="flex justify-between"><span className="text-gray-500">Default session length</span><span className="font-medium text-gray-800">{sessionLength} min</span></div>
              )}
              {isCoach && (
                <div className="flex justify-between"><span className="text-gray-500">Coaches multiple at once</span><span className="font-medium text-gray-800">{coachesSimultaneously ? 'Yes' : 'No'}</span></div>
              )}
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
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
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
            <PostcodeSuburbFields value={location} onChange={setLocation} idPrefix="profile" />
            {/* §2.2: coach default session length ({30,45,60,75,90}). */}
            {isCoach && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Default session length</label>
                <select
                  value={sessionLength}
                  onChange={(e) => setSessionLength(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  {[30, 45, 60, 75, 90].map(d => (
                    <option key={d} value={d}>{d} min</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Pre-fills each athlete slot when you allocate a session. You can still change any slot.</p>
              </div>
            )}
            {isCoach && (
              <div>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={coachesSimultaneously}
                    onChange={(e) => setCoachesSimultaneously(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-sm text-gray-700">
                    <span className="font-medium">Do you coach multiple athletes at the same time? (bowling)</span>
                    <span className="block text-xs text-gray-500 mt-0.5">Leave unticked if you coach athletes one after another — when you allocate a session we'll auto-advance each athlete's start time and show your most-frequent athletes for that time first.</span>
                  </span>
                </label>
              </div>
            )}
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
      {user.role === 'customer' && (
        <div className="mt-6">
          <MyAthletesCard />
        </div>
      )}
      {user.role === 'customer' && (
        <div className="mt-6">
          <MyMatesCard />
        </div>
      )}
      {/* Bug 6: email notifications sit ABOVE push notifications. */}
      <div className="mt-6">
        <EmailNotificationsCard
          customerRecord={customerRecord}
          userEmail={user.email}
          userName={user.name}
          updateCustomerByEmail={updateCustomerByEmail}
        />
      </div>
      <div className="mt-6">
        <PushNotificationsCard />
      </div>
    </div>
  )
}
