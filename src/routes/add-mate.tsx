import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery, useMutation, useConvex } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { useAuth } from '../hooks/useAuth'
import { LANES, formatTime } from '../lib/booking-data'
import { formatAccessCode } from '../lib/access-code'

export const Route = createFileRoute('/add-mate')({
  component: AddMatePage,
  validateSearch: (search: Record<string, unknown>) => ({
    bookingId: (search.bookingId as string | undefined) ?? '',
  }),
})

/**
 * Add a Mate (SPEC_ADD_A_MATE) — a dedicated PAGE (not a dismissible modal) so it
 * survives app-switching while the owner copies a phone number from contacts.
 * Lets a customer add friends (existing Krickora accounts) to their booking for
 * shared front-door access, manage the booking's mates, and SMS-invite people who
 * don't have an account yet.
 */
function AddMatePage() {
  const { bookingId } = Route.useSearch()
  const navigate = useNavigate()
  const { user } = useAuth()
  const convex = useConvex()

  const booking = useQuery(
    api.queries.getBooking,
    bookingId ? { id: bookingId as Id<'bookings'> } : 'skip'
  )
  const mates = useQuery(
    api.mates.listBookingMates,
    bookingId ? { bookingId: bookingId as Id<'bookings'> } : 'skip'
  ) ?? []
  const savedMates = useQuery(api.mates.listSavedMates, {}) ?? []

  const addMate = useMutation(api.mates.addMateToBooking)
  const removeMate = useMutation(api.mates.removeMateFromBooking)
  const removeSaved = useMutation(api.mates.removeSavedMate)
  const createInvite = useMutation(api.mates.createBookingInvite)

  const [phone, setPhone] = useState('')
  const [searching, setSearching] = useState(false)
  const [match, setMatch] = useState<{ _id: string; displayName: string; isSelf?: boolean } | null | 'none'>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [inviteLink, setInviteLink] = useState<string | null>(null)

  const flash = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 5000)
  }

  if (!user) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">👥</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Sign in to add a mate</h2>
      </div>
    )
  }

  if (!bookingId || booking === null) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">🔍</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Booking not found</h2>
        <button onClick={() => navigate({ to: '/bookings' })} className="mt-4 px-5 py-2 bg-emerald-600 text-white rounded-xl font-medium">
          Back to My Bookings
        </button>
      </div>
    )
  }

  const lane = booking ? LANES.find((l) => l.id === booking.laneId) : null
  const laneLabel = lane?.name ?? booking?.laneId ?? ''

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    setMatch(null)
    setInviteLink(null)
    setSearching(true)
    try {
      const res = await convex.query(api.mates.searchCustomerByMobile, { phone })
      setMatch(res ? (res as any) : 'none')
    } catch (err: any) {
      flash('error', err?.message ?? 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  const handleAdd = async (mateCustomerId: string) => {
    setBusy(true)
    try {
      await addMate({ bookingId: bookingId as Id<'bookings'>, mateCustomerId: mateCustomerId as Id<'customers'> })
      flash('success', 'Mate added — they have been emailed the door code.')
      setMatch(null)
      setPhone('')
    } catch (err: any) {
      flash('error', err?.message ?? 'Failed to add mate')
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (mateCustomerId: string, name: string) => {
    if (!confirm(`Remove ${name} from this booking?`)) return
    setBusy(true)
    try {
      await removeMate({ bookingId: bookingId as Id<'bookings'>, mateCustomerId: mateCustomerId as Id<'customers'> })
      flash('success', `Removed ${name}`)
    } catch (err: any) {
      flash('error', err?.message ?? 'Failed to remove mate')
    } finally {
      setBusy(false)
    }
  }

  const handleRemoveSaved = async (mateCustomerId: string) => {
    setBusy(true)
    try {
      await removeSaved({ mateCustomerId: mateCustomerId as Id<'customers'> })
    } catch (err: any) {
      flash('error', err?.message ?? 'Failed to remove saved mate')
    } finally {
      setBusy(false)
    }
  }

  // Build an SMS invite for an unregistered mate. Opens the native Messages app
  // (sms:) on mobile; on desktop sms: does nothing, so we surface a copy link.
  const handleSmsInvite = async () => {
    setBusy(true)
    try {
      const { link } = await createInvite({
        bookingId: bookingId as Id<'bookings'>,
        invitedPhone: phone.trim() || undefined,
      })
      setInviteLink(link)
      const ownerName = (user.name || 'A friend').split(' ')[0]
      const body = `Hey! ${ownerName} has added you to their cricket net booking at Cricket Revolution, Stirling. Tap to join and get your door access code: ${link}`
      const num = phone.replace(/[^\d+]/g, '')
      const smsHref = `sms:${num}?body=${encodeURIComponent(body)}`
      // Best-effort open of the native Messages app.
      window.location.href = smsHref
    } catch (err: any) {
      flash('error', err?.message ?? 'Failed to create invite')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 sm:px-6 py-8">
      <button onClick={() => navigate({ to: '/bookings' })} className="text-sm text-gray-500 hover:text-gray-700 mb-4">
        ← Back to My Bookings
      </button>
      <h1 className="text-2xl font-bold text-gray-800 mb-1">Add a Mate</h1>
      <p className="text-sm text-gray-500 mb-6">
        Add friends who have a Cricket Revolution account so they can use the same door code.
      </p>

      {/* Booking summary */}
      {booking && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-6">
          <div className="text-sm text-gray-800 font-semibold">{laneLabel}</div>
          <div className="text-sm text-gray-500 mt-0.5">
            {booking.date} · {formatTime(booking.startHour)} · {booking.duration} min
          </div>
          {booking.accessCode && (
            <div className="text-sm text-gray-500 mt-0.5">Door code: <span className="font-mono font-semibold text-gray-800">{formatAccessCode(booking.accessCode)}</span></div>
          )}
        </div>
      )}

      {message && (
        <div className={`px-4 py-2.5 rounded-xl text-sm mb-4 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
          {message.text}
        </div>
      )}

      {/* Current mates on this booking */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-6">
        <div className="text-sm font-bold text-gray-800 mb-3">On this booking ({mates.length})</div>
        {mates.length === 0 ? (
          <p className="text-sm text-gray-400">No mates added yet.</p>
        ) : (
          <div className="space-y-2">
            {mates.map((m: any) => (
              <div key={m.customerId} className="flex items-center justify-between">
                <span className="text-sm text-gray-800">{m.displayName}</span>
                <button
                  onClick={() => handleRemove(m.customerId, m.displayName)}
                  disabled={busy}
                  className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Search by mobile */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-6">
        <div className="text-sm font-bold text-gray-800 mb-3">Add by mobile number</div>
        <form onSubmit={handleSearch} className="flex items-center gap-2">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="04xx xxx xxx"
            inputMode="tel"
            className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <button
            type="submit"
            disabled={searching || phone.replace(/\D/g, '').length < 8}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium text-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>

        {/* Re-confirm step: show matched name + entered number before adding */}
        {match && match !== 'none' && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm text-gray-800">
              Add <span className="font-semibold">{match.displayName}</span> ({phone.trim()})?
            </p>
            {match.isSelf ? (
              <p className="text-xs text-gray-500 mt-1">That's you — you're already on this booking.</p>
            ) : (
              <button
                onClick={() => handleAdd(match._id)}
                disabled={busy}
                className="mt-2 px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium text-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                Confirm &amp; add
              </button>
            )}
          </div>
        )}

        {match === 'none' && (
          <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <p className="text-sm text-gray-700">No account found for that number.</p>
            <p className="text-xs text-gray-500 mt-1">Send them an SMS invite to join — they'll get the door code once they sign up.</p>
            <button
              onClick={handleSmsInvite}
              disabled={busy}
              className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              Send SMS invite
            </button>
            {inviteLink && (
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-1">No SMS app? Copy this invite link:</p>
                <input
                  readOnly
                  value={inviteLink}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Saved mates (ordered by shared-session count) */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
        <div className="text-sm font-bold text-gray-800 mb-3">Your mates</div>
        {savedMates.length === 0 ? (
          <p className="text-sm text-gray-400">No saved mates yet. Add someone above and they'll show here.</p>
        ) : (
          <div className="space-y-2">
            {savedMates.map((m: any) => {
              const alreadyOn = mates.some((x: any) => x.customerId === m.customerId)
              return (
                <div key={m.customerId} className="flex items-center justify-between">
                  <span className="text-sm text-gray-800">
                    {m.displayName} {m.sharedCount > 0 && <span className="text-gray-400">(x{m.sharedCount})</span>}
                  </span>
                  <div className="flex items-center gap-3">
                    {alreadyOn ? (
                      <span className="text-xs text-gray-400">Added</span>
                    ) : (
                      <button
                        onClick={() => handleAdd(m.customerId)}
                        disabled={busy}
                        className="text-xs text-emerald-600 hover:text-emerald-800 font-medium disabled:opacity-50"
                      >
                        Add
                      </button>
                    )}
                    <button
                      onClick={() => handleRemoveSaved(m.customerId)}
                      disabled={busy}
                      className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
