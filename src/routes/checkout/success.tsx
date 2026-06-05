import { useEffect } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { trackFunnelStep, clearBookingFlow } from '../../lib/tracker'

export const Route = createFileRoute('/checkout/success')({
  component: CheckoutSuccessPage,
})

function CheckoutSuccessPage() {
  // SPEC_ANALYTICS_BUILD_2026-06 C2.5 — the Stripe round-trip lands here on
  // success; close the booking funnel (the flowId was preserved across the
  // redirect in sessionStorage) then clear it. Guarded so a refresh of this
  // page doesn't double-count (the flow is cleared after the first emit).
  useEffect(() => {
    try {
      if (sessionStorage.getItem('kr_flow')) {
        trackFunnelStep('booking_confirmed', { kind: 'paid' })
        clearBookingFlow()
      }
    } catch { /* ignore */ }
  }, [])

  return (
    <div className="max-w-lg mx-auto px-4 py-16 text-center">
      <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center text-4xl mx-auto mb-6">✅</div>
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Payment Successful!</h1>
      <p className="text-gray-500 mb-6">Your booking has been confirmed. A confirmation email is on its way.</p>
      <div className="flex flex-col items-center gap-3">
        <Link to="/bookings" className="inline-block px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-medium shadow-md transition-all">
          View My Bookings
        </Link>
        {/* SPEC_ADD_A_MATE: nudge to invite friends from the confirmation screen. */}
        <Link to="/bookings" className="text-sm text-emerald-600 hover:text-emerald-700 font-medium">
          Bringing mates? Add them from My Bookings →
        </Link>
      </div>
    </div>
  )
}
