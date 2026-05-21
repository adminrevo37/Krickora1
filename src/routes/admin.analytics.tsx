import { createFileRoute, Link } from '@tanstack/react-router'
import { useAuth } from '../hooks/useAuth'
import AdminAnalyticsDashboard from '../components/AdminAnalyticsDashboard'

export const Route = createFileRoute('/admin/analytics')({
  component: AnalyticsPage,
})

function AnalyticsPage() {
  const { isAdmin, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400 text-sm">
        Loading…
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Admin Access Required</h2>
        <p className="text-gray-500">You don&apos;t have permission to view this page.</p>
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Link
            to="/admin"
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-emerald-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Admin
          </Link>
          <span className="text-gray-300">/</span>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        </div>

        <AdminAnalyticsDashboard />
      </div>
    </div>
  )
}
