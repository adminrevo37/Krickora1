import { useEffect, useState } from 'react'
import { createFileRoute, Link, useSearch } from '@tanstack/react-router'
import { cancelUnpaidCheckout } from '../../lib/stripe'
import { clearBookingFlow } from '../../lib/tracker'

// SPEC_CHECKOUT_ABANDONMENT (layer 2) — Stripe's cancel_url lands here when a
// customer backs out of the payment page. Release the unpaid booking's slot
// immediately (expire the session + free the slot) instead of leaving an
// "Awaiting payment" slot stuck until the timer/cron.
export const Route = createFileRoute('/checkout/cancel')({
  validateSearch: (search: Record<string, unknown>): { b?: string } => ({
    b: typeof search.b === 'string' ? search.b : undefined,
  }),
  component: CheckoutCancelPage,
})

function CheckoutCancelPage() {
  const { b: bookingId } = useSearch({ from: '/checkout/cancel' })
  const [state, setState] = useState<'releasing' | 'done' | 'error'>('releasing')

  useEffect(() => {
    try { clearBookingFlow() } catch { /* ignore */ }
    if (!bookingId) { setState('done'); return }
    let cancelled = false
    cancelUnpaidCheckout(bookingId)
      .then(() => { if (!cancelled) setState('done') })
      // The 10-min auto-cancel + cron are the backstop if this fails, so still
      // show a calm message rather than an error wall.
      .catch(() => { if (!cancelled) setState('done') })
    return () => { cancelled = true }
  }, [bookingId])

  return (
    <div className="max-w-lg mx-auto px-4 py-16 text-center">
      <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center text-4xl mx-auto mb-6">🛒</div>
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Payment cancelled</h1>
      <p className="text-gray-500 mb-6">
        {state === 'releasing'
          ? 'Releasing your slot…'
          : 'No payment was taken and the slot has been released. You can book again whenever you like.'}
      </p>
      <div className="flex flex-col items-center gap-3">
        <Link to="/" className="inline-block px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-medium shadow-md transition-all">
          Back to Booking
        </Link>
        <Link to="/bookings" className="text-sm text-gray-500 hover:text-gray-700 font-medium">
          View My Bookings →
        </Link>
      </div>
    </div>
  )
}
