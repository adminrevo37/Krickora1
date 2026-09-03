import { createFileRoute } from '@tanstack/react-router'
import { useAuth } from '../hooks/useAuth'
import { useAppGate } from '../hooks/useAppGate'
import AppGateWall from '../components/AppGateWall'
import MyBookings from '../components/MyBookings'
import { useImpersonation } from '../hooks/useImpersonation'

export const Route = createFileRoute('/bookings')({
  component: GatedBookingsPage,
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

// SPEC_MOBILE_APP_GATE_2026-06 Trigger 2 — /bookings while logged out on mobile web.
function GatedBookingsPage() {
  const { user } = useAuth()
  const gate = useAppGate('my-bookings')
  if (!user && gate.stage !== 'none') {
    return (
      <div className="min-h-[60vh]">
        <AppGateWall stage={gate.stage} trigger="my-bookings" onSnooze={gate.snoozePush} />
      </div>
    )
  }
  return <BookingsPage />
}
