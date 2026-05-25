import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/checkout/success')({
  component: CheckoutSuccessPage,
})

function CheckoutSuccessPage() {
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
