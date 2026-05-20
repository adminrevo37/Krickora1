import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/bookings')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/bookings"!</div>
}
