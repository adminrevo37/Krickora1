import { useState } from 'react'
import { useAction, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { LANES, getLanePrice, type Booking } from '../lib/booking-data'

interface EditBookingModalProps {
  booking: Booking
  onClose: () => void
  onSuccess: () => void
}

const DURATION_OPTIONS = [60, 90, 120, 150, 180]

export default function EditBookingModal({ booking, onClose, onSuccess }: EditBookingModalProps) {
  const settings = useQuery(api.queries.getSiteSettings)
  const requestBookingEdit = useAction(api.bookingEdit.requestBookingEdit)
  const [newDuration, setNewDuration] = useState(booking.duration)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lane = LANES.find(l => l.id === booking.laneId)

  const getPrice = (duration: number) => {
    if (!lane) return 0
    return getLanePrice(lane, booking.variantId ?? null, duration)
  }

  const currentPrice = getPrice(booking.duration)
  const newPrice = getPrice(newDuration)
  const priceDiff = newPrice - currentPrice

  const closingHour = settings?.closingHour ?? 21
  const maxDuration = Math.floor((closingHour - booking.startHour) * 60)

  const validOptions = DURATION_OPTIONS.filter(d => d <= maxDuration && d >= 60)

  const handleSubmit = async () => {
    if (newDuration === booking.duration) {
      onClose()
      return
    }
    setError(null)
    setLoading(true)
    try {
      const result = await requestBookingEdit({
        bookingId: booking.id,
        newDuration,
        newPriceInCents: Math.round(newPrice * 100),
        oldPriceInCents: Math.round(currentPrice * 100),
      })

      if (result.requiresPayment && result.priceDifference > 0) {
        // Need to pay the difference — redirect to Stripe top-up checkout
        // Import createTopUpCheckoutSession action
        // We do this inline to avoid an extra import
        const laneObj = LANES.find(l => l.id === booking.laneId)
        const fmtH = (h: number) => {
          const w = Math.floor(h); const m = Math.round((h - w) * 60)
          const p = w >= 12 ? 'pm' : 'am'; const d = w > 12 ? w - 12 : w === 0 ? 12 : w
          return m > 0 ? `${d}:${m.toString().padStart(2, '0')}${p}` : `${d}${p}`
        }
        const endHour = booking.startHour + newDuration / 60
        const desc = `${laneObj?.name ?? booking.laneId} — ${booking.date} ${fmtH(booking.startHour)}-${fmtH(endHour)} (amendment, +${newDuration - booking.duration}min)`

        // Use fetch to call the Convex action for top-up session
        // We delegate to a function available on api.stripe.createTopUpCheckoutSession
        const { createTopUpCheckoutSession } = await import('../lib/stripe')
        const session = await createTopUpCheckoutSession({
          bookingId: booking.id,
          laneName: laneObj?.name ?? booking.laneId,
          date: booking.date,
          customerName: booking.customerEmail,
          customerEmail: booking.customerEmail,
          topUpAmountCents: result.priceDifference,
          description: desc,
        })
        if (session?.url) {
          window.location.href = session.url
        }
      } else {
        onSuccess()
        onClose()
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to update booking.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6 border border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">✏️ Edit Booking Duration</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">✕</button>
        </div>

        {/* Current booking info */}
        <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 mb-5 text-sm">
          <div className="font-semibold text-gray-700 dark:text-gray-300">{lane?.name ?? booking.laneId}</div>
          <div className="text-gray-500 dark:text-gray-400 mt-0.5">{booking.date} · Current: {booking.duration}min · ${currentPrice}</div>
        </div>

        {/* Duration selector */}
        <div className="mb-5">
          <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">New Duration</label>
          <div className="grid grid-cols-3 gap-2">
            {validOptions.map(d => (
              <button
                key={d}
                onClick={() => setNewDuration(d)}
                className={`py-2.5 rounded-xl text-sm font-semibold border transition-all ${
                  newDuration === d
                    ? 'bg-emerald-500 text-white border-emerald-500 shadow-sm'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-emerald-300'
                }`}
              >
                {d < 60 ? `${d}min` : d % 60 === 0 ? `${d / 60}hr` : `${Math.floor(d / 60)}hr ${d % 60}min`}
              </button>
            ))}
          </div>
        </div>

        {/* Price difference */}
        {newDuration !== booking.duration && (
          <div className={`rounded-xl p-3 mb-5 text-sm font-medium ${
            priceDiff > 0
              ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/50'
              : priceDiff < 0
                ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/50'
                : 'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700'
          }`}>
            {priceDiff > 0 && `+$${(priceDiff).toFixed(2)} — you'll be charged the difference`}
            {priceDiff < 0 && `-$${Math.abs(priceDiff).toFixed(2)} — refund issued automatically`}
            {priceDiff === 0 && 'No price change'}
            <div className="text-xs opacity-75 mt-0.5">New total: ${newPrice}</div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-xl p-3 mb-4 border border-red-200 dark:border-red-800/50">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || newDuration === booking.duration}
            className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            {loading
              ? 'Updating...'
              : priceDiff > 0
                ? `Pay +$${priceDiff.toFixed(2)}`
                : 'Confirm Change'}
          </button>
        </div>
      </div>
    </div>
  )
}
