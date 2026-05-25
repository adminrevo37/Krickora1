import { createFileRoute } from '@tanstack/react-router'
import MyBookings from '../components/MyBookings'
import { useImpersonation } from '../hooks/useImpersonation'

export const Route = createFileRoute('/bookings')({
  component: BookingsPage,
})

function BookingsPage() {
  const { isImpersonating, impersonatedUser } = useImpersonation()
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {isImpersonating && impersonatedUser && (
        <div className="mb-4 px-4 py-2 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          Showing bookings for <strong>{impersonatedUser.name}</strong> ({impersonatedUser.email})
        </div>
      )}
      <MyBookings impersonatedEmail={isImpersonating ? impersonatedUser?.email : undefined} />
    </div>
  )
}
