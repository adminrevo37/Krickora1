// SPEC_ANALYTICS_BUILD_2026-06 — tabbed analytics shell. Hosts the original
// booking-metrics dashboard (Overview) alongside the new tabs: a filterable
// bookings explorer, navigable time-series revenue + credit, app usage + door-code
// access lead time, the booking funnel, push delivery/CTR + waitlist responses,
// lane occupancy, and customer retention/LTV/referral/discount analytics.
// A global date-range picker (8 presets + compare) drives every range-aware tab,
// including Overview. Admin-gating is enforced by the /admin/analytics route.
import { useState, lazy, Suspense } from 'react'
import { type AnalyticsRange, AnalyticsRangePicker, defaultAnalyticsRange, clampRange } from './analytics/shared'

const OverviewTab = lazy(() => import('./analytics/OverviewTab'))
const LiveFeedTab = lazy(() => import('./analytics/LiveFeedTab'))
const BookingsTab = lazy(() => import('./analytics/BookingsTab'))
const RevenueTab = lazy(() => import('./analytics/RevenueTab'))
const CompareTab = lazy(() => import('./analytics/CompareTab'))
const UsageTab = lazy(() => import('./analytics/UsageTab'))
const FunnelTab = lazy(() => import('./analytics/FunnelTab'))
const PushTab = lazy(() => import('./analytics/PushTab'))
const OccupancyTab = lazy(() => import('./analytics/OccupancyTab'))
const CustomersTab = lazy(() => import('./analytics/CustomersTab'))
const MapTab = lazy(() => import('./analytics/MapTab'))

// `subDay`: whether 1h/4h presets are offered (event-time panels only). Date-based
// panels (bookings/revenue/occupancy/customers/map) bucket by session date, so
// sub-day windows are hidden + clamped to "Day" (see clampRange).
const TABS = [
  { id: 'overview', label: 'Overview', icon: '📊', range: true, subDay: false },
  { id: 'livefeed', label: 'Live Feed', icon: '🔴', range: false, subDay: false },
  { id: 'bookings', label: 'Bookings', icon: '📋', range: true, subDay: false },
  { id: 'revenue', label: 'Revenue', icon: '💰', range: true, subDay: false },
  { id: 'compare', label: 'Compare', icon: '📈', range: false, subDay: false },
  { id: 'usage', label: 'Usage', icon: '👥', range: true, subDay: true },
  { id: 'funnel', label: 'Funnel', icon: '🛒', range: true, subDay: true },
  { id: 'push', label: 'Push & Waitlist', icon: '🔔', range: true, subDay: true },
  { id: 'occupancy', label: 'Occupancy', icon: '🏟️', range: true, subDay: false },
  { id: 'customers', label: 'Customers', icon: '💎', range: true, subDay: false },
  { id: 'map', label: 'Map', icon: '🗺️', range: true, subDay: false },
] as const

type TabId = (typeof TABS)[number]['id']

export default function AdminAnalyticsDashboard() {
  const [tab, setTab] = useState<TabId>('overview')
  const [range, setRange] = useState<AnalyticsRange>(() => defaultAnalyticsRange(Date.now()))

  const activeTab = TABS.find((t) => t.id === tab)!
  const tabRange = clampRange(range, activeTab.subDay)

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
          <AnalyticsRangePicker value={range} onChange={setRange} allowSubDay={activeTab.subDay} />
        </div>
      )}

      <Suspense fallback={<div className="p-12 text-center text-sm text-gray-400">Loading…</div>}>
        {tab === 'overview' && <OverviewTab range={tabRange} />}
        {tab === 'livefeed' && <LiveFeedTab />}
        {tab === 'bookings' && <BookingsTab range={tabRange} />}
        {tab === 'revenue' && <RevenueTab range={tabRange} />}
        {tab === 'compare' && <CompareTab />}
        {tab === 'usage' && <UsageTab range={tabRange} />}
        {tab === 'funnel' && <FunnelTab range={tabRange} />}
        {tab === 'push' && <PushTab range={tabRange} />}
        {tab === 'occupancy' && <OccupancyTab range={tabRange} />}
        {tab === 'customers' && <CustomersTab range={tabRange} />}
        {tab === 'map' && <MapTab range={tabRange} />}
      </Suspense>
    </div>
  )
}
