import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useAction } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/checkout/success')({
  component: CheckoutSuccessPage,
})

function CheckoutSuccessPage() {
  const navigate = useNavigate()
  const verifySession = useAction(api.stripe.verifySession)
  const applyPendingEditFromSession = useAction(api.bookingEdit.applyPendingEditFromSession)

  const [status, setStatus] = useState<'loading' | 'booking' | 'edit' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const sessionId = params.get('session_id')
    if (!sessionId) {
      setStatus('booking')
      return
    }

    async function verify() {
      try {
        const result = await verifySession({ sessionId: sessionId! })
        if (!result.paid) {
          setErrorMsg('Payment not confirmed. Please contact support.')
          setStatus('error')
          return
        }

        // Check if this was a booking-edit top-up
        if ((result.metadata as any)?.sessionType === 'booking_edit_topup') {
          await applyPendingEditFromSession({ stripeSessionId: sessionId! })
          setStatus('edit')
        } else {
          setStatus('booking')
        }
      } catch (err: any) {
        setErrorMsg(err?.message || 'Something went wrong. Please contact support.')
        setStatus('error')
      }
    }

    verify()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (status === 'loading') {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center text-4xl mx-auto mb-6 animate-pulse">⏳</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Confirming payment…</h1>
        <p className="text-gray-500">Please wait a moment.</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center text-4xl mx-auto mb-6">❌</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h1>
        <p className="text-gray-500 mb-6">{errorMsg}</p>
        <Link to="/bookings" className="inline-block px-6 py-2.5 bg-gray-800 hover:bg-gray-900 text-white rounded-xl font-medium shadow-md transition-all">
          View My Bookings
        </Link>
      </div>
    )
  }

  if (status === 'edit') {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="w-20 h-20 bg-violet-100 rounded-full flex items-center justify-center text-4xl mx-auto mb-6">✅</div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Booking Updated!</h1>
        <p className="text-gray-500 mb-6">Your booking has been updated and your payment processed. Check your email for a confirmation.</p>
        <Link to="/bookings" className="inline-block px-6 py-2.5 bg-violet-500 hover:bg-violet-600 text-white rounded-xl font-medium shadow-md transition-all">
          View My Bookings
        </Link>
      </div>
    )
  }

  // status === 'booking' (standard new booking)
  return (
    <div className="max-w-lg mx-auto px-4 py-16 text-center">
      <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center text-4xl mx-auto mb-6">✅</div>
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Payment Successful!</h1>
      <p className="text-gray-500 mb-6">Your booking has been confirmed. A confirmation email is on its way.</p>
      <Link to="/bookings" className="inline-block px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-medium shadow-md transition-all">
        View My Bookings
      </Link>
    </div>
  )
}
