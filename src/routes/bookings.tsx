import { createFileRoute } from '@tanstack/react-router'
import MyBookings from '../components/MyBookings'

export const Route = createFileRoute('/bookings')({
  component: BookingsPage,
})

function BookingsPage() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <MyBookings />
    </div>
  )
}
