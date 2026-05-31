import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { LANES, formatTime } from '../lib/booking-data'
import { formatAccessCode } from '../lib/access-code'

/**
 * Read-only "shared with you" bookings (SPEC_ADD_A_MATE). Rendered inside My
 * Bookings for any user who is a MATE (not the owner) on an upcoming booking.
 * Shows lane/date/time/duration + the shared door code + a Leave button. No
 * pricing, no other PII (the backend query already scopes this).
 */
export default function MateBookingsSection() {
  const mateBookings = useQuery(api.mates.listMateBookings, {}) ?? []
  const leaveBooking = useMutation(api.mates.leaveBooking)

  if (mateBookings.length === 0) return null

  const laneName = (id: string) => LANES.find((l) => l.id === id)?.name ?? id

  const handleLeave = async (id: string) => {
    if (!confirm('Leave this booking? You will lose access to the door code.')) return
    try {
      await leaveBooking({ bookingId: id as Id<'bookings'> })
    } catch (err: any) {
      alert(err?.message ?? 'Failed to leave booking')
    }
  }

  return (
    <div className="mb-2">
      <h2 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">👥 Shared with you</h2>
      <div className="space-y-2">
        {mateBookings.map((b: any) => (
          <div key={b.id} className="bg-white dark:bg-gray-900 rounded-xl border border-blue-100 dark:border-blue-900/40 shadow-sm p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">{laneName(b.laneId)}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {b.date} · {formatTime(b.startHour)} · {b.duration} min
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Booked by {b.ownerName}</div>
                {b.otherMates.length > 0 && (
                  <div className="text-xs text-gray-400 mt-0.5">Also attending: {b.otherMates.join(', ')}</div>
                )}
                {b.accessCode && (
                  <div className="text-sm mt-2 text-gray-700 dark:text-gray-300">
                    Door code: <span className="font-mono font-semibold text-blue-700 dark:text-blue-300">{formatAccessCode(b.accessCode)}</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => handleLeave(b.id)}
                className="text-xs text-red-500 hover:text-red-700 shrink-0"
              >
                Leave
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
