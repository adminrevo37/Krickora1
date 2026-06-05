// SPEC_ANALYTICS_BUILD_2026-06 — tabbed analytics shell. Hosts the original
// booking-metrics dashboard (Overview) alongside the new tabs: a filterable
// bookings explorer, navigable time-series revenue + credit, app usage + door-code
// access lead time, the booking funnel, push delivery/CTR + waitlist responses,
// lane occupancy, and customer retention/LTV/referral/discount analytics.
// A global date-range picker drives every tab except Overview (which keeps its own
// trailing-N-months selector). Admin-gating is enforced by the /admin/analytics route.
import { useState, lazy, Suspense } from 'react'
import { type DateRange, DateRangePicker, daysAgoKey, todayKey } from './analytics/shared'

const OverviewTab = lazy(() => import('./analytics/OverviewTab'))
const BookingsTab = lazy(() => import('./analytics/BookingsTab'))
const RevenueTab = lazy(() => import('./analytics/RevenueTab'))
const CompareTab = lazy(() => import('./analytics/CompareTab'))
const UsageTab = lazy(() => import('./analytics/UsageTab'))
const FunnelTab = lazy(() => import('./analytics/FunnelTab'))
const PushTab = lazy(() => import('./analytics/PushTab'))
const OccupancyTab = lazy(() => import('./analytics/OccupancyTab'))
const CustomersTab = lazy(() => import('./analytics/CustomersTab'))
const MapTab = lazy(() => import('./analytics/MapTab'))

const TABS = [
  { id: 'overview', label: 'Overview', icon: '📊', range: false },
  { id: 'bookings', label: 'Bookings', icon: '📋', range: true },
  { id: 'revenue', label: 'Revenue', icon: '💰', range: true },
  { id: 'compare', label: 'Compare', icon: '📈', range: false },
  { id: 'usage', label: 'Usage', icon: '👥', range: true },
  { id: 'funnel', label: 'Funnel', icon: '🛒', range: true },
  { id: 'push', label: 'Push & Waitlist', icon: '🔔', range: true },
  { id: 'occupancy', label: 'Occupancy', icon: '🏟️', range: true },
  { id: 'customers', label: 'Customers', icon: '💎', range: true },
  { id: 'map', label: 'Map', icon: '🗺️', range: true },
] as const

type TabId = (typeof TABS)[number]['id']

export default function AdminAnalyticsDashboard() {
  const [tab, setTab] = useState<TabId>('overview')
  const [range, setRange] = useState<DateRange>(() => ({ from: daysAgoKey(90), to: todayKey() }))

  const activeTab = TABS.find((t) => t.id === tab)!

  return (
    <div className="space-y-5">
      {/* Tab nav */}
      <div className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold whitespace-nowrap transition-colors ${
              tab === t.id ? 'bg-gray-900 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <span>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Global date-range (range-driven tabs only) */}
      {activeTab.range && (
        <div className="flex items-center justify-end">
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      )}

      <Suspense fallback={<div className="p-12 text-center text-sm text-gray-400">Loading…</div>}>
        {tab === 'overview' && <OverviewTab />}
        {tab === 'bookings' && <BookingsTab range={range} />}
        {tab === 'revenue' && <RevenueTab range={range} />}
        {tab === 'compare' && <CompareTab />}
        {tab === 'usage' && <UsageTab range={range} />}
        {tab === 'funnel' && <FunnelTab range={range} />}
        {tab === 'push' && <PushTab range={range} />}
        {tab === 'occupancy' && <OccupancyTab range={range} />}
        {tab === 'customers' && <CustomersTab range={range} />}
        {tab === 'map' && <MapTab range={range} />}
      </Suspense>
    </div>
  )
}
