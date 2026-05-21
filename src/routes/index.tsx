import { createFileRoute } from '@tanstack/react-router'
import BookingCalendar from '../components/BookingCalendar'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Book a Training Net</h1>
        <p className="text-gray-500 mt-1">Reserve your lane and start training</p>
      </div>
      <BookingCalendar />
    </div>
  )
}
