import { createFileRoute } from '@tanstack/react-router'
import BookingCalendar from '../components/BookingCalendar'
import AdminBookingCalendar from '../components/AdminBookingCalendar'
import { useAuth } from '../hooks/useAuth'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const { isAdmin, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400 text-sm">
        Loading…
      </div>
    )
  }

  if (isAdmin) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Booking Calendar</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">Admin view — full 12-month history and forward bookings</p>
        </div>
        <AdminBookingCalendar />
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Book a Training Net</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">Reserve your lane and start training</p>
      </div>
      <BookingCalendar />
    </div>
  )
}
