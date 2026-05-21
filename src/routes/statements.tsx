import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useAuth } from '../hooks/useAuth'
import { api } from '../../convex/_generated/api'
import CoachStatementTable from '../components/CoachStatementTable'

export const Route = createFileRoute('/statements')({
  component: StatementsPage,
})

function StatementsPage() {
  const { user, isCoach, isAdmin, isLoading } = useAuth()

  // Needed only to resolve the Convex _id for the payments query inside CoachStatementTable
  const customer = useQuery(
    api.queries.getCustomerByEmail,
    user?.email ? { email: user.email } : 'skip'
  )

  if (isLoading) {
    return <div className="max-w-7xl mx-auto px-4 py-16 text-center text-gray-500">Loading…</div>
  }

  if (!isCoach && !isAdmin) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h2 className="text-2xl font-bold text-gray-800 dark:text-white mb-2">Coach Access Required</h2>
        <p className="text-gray-500">Only coaches can view statements.</p>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Statements</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-6">Bookings and payments reconciliation.</p>
      <CoachStatementTable
        coachId={(customer as any)?._id ?? ''}
        coachEmail={user?.email}
        coachName={user?.name ?? undefined}
      />
      <p className="mt-4 text-xs text-gray-400">
        Bookings are recorded automatically based on coach session prices. Payments are entered by admin. Contact admin for corrections.
      </p>
    </div>
  )
}
