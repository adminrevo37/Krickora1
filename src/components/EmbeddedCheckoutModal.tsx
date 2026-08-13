// SPEC_EMBEDDED_CHECKOUT — Stripe Embedded Checkout rendered in-app inside our
// own modal, replacing the full-page redirect to checkout.stripe.com.
//
// Props:
//  - clientSecret: from createCheckoutSession (embedded mode).
//  - onComplete: fires when Stripe reports the payment complete (in-iframe). The
//    checkout.session.completed webhook remains the source of truth — this is just
//    the UX hand-off back to the app.
//  - onClose: the customer backed out (× or backdrop). The caller should release
//    the unpaid booking (cancelUnpaidCheckout) and return to its confirm step.
import { useEffect, useMemo, useRef } from 'react'
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js'
import { getStripePromise } from '../lib/stripe'

interface EmbeddedCheckoutModalProps {
  clientSecret: string
  onComplete: () => void
  onClose: () => void
}

export default function EmbeddedCheckoutModal({ clientSecret, onComplete, onClose }: EmbeddedCheckoutModalProps) {
  const stripePromise = getStripePromise()
  // SYNC-7 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13): every caller passes an INLINE
  // onComplete, so its identity changed on each parent re-render (MyBookings alone
  // re-renders every 30s via its tick). react-stripe-js refuses to change onComplete
  // after init — it logs "Unsupported prop change" and keeps the FIRST render's
  // closure — so the options object was rebuilt endlessly for nothing, and any
  // future onComplete that read component state would silently act on first-render
  // values. Build options ONCE per clientSecret and route the callback through a ref
  // so Stripe always invokes the latest one.
  const onCompleteRef = useRef(onComplete)
  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])
  const options = useMemo(
    () => ({ clientSecret, onComplete: () => onCompleteRef.current() }),
    [clientSecret]
  )

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-md overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 className="text-base font-bold text-gray-900 dark:text-gray-100">Secure Payment</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">Powered by Stripe</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cancel payment"
            className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300 transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-3">
          {stripePromise ? (
            <EmbeddedCheckoutProvider stripe={stripePromise} options={options}>
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          ) : (
            <div className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
              Payment could not be loaded. Please try again or contact support.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
