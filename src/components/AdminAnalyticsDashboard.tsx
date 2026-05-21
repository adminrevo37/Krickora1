import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import {
  ComposedChart,
  Bar,
  BarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from 'recharts'

const LANE_COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444']

export default function AdminAnalyticsDashboard() {
  const [months, setMonths] = useState<3 | 6 | 12>(12)
  const data = useQuery(api.analytics.getAdminAnalytics, { months })

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center text-gray-400">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-sm">Loading analytics…</div>
        </div>
      </div>
    )
  }

  const { kpis, byMonth, lanes, timeSlots } = data

  const pctChange = (cur: number, prev: number): string => {
    if (prev === 0) return cur > 0 ? '+100%' : '—'
    const change = ((cur - prev) / prev) * 100
    return (change >= 0 ? '+' : '') + change.toFixed(1) + '%'
  }
  const pctColor = (cur: number, prev: number): string =>
    cur >= prev ? 'text-emerald-600' : 'text-red-500'

  const returnRate =
    kpis.totalUniqueCustomers > 0
      ? Math.round((kpis.returningCustomers / kpis.totalUniqueCustomers) * 100)
      : 0

  const maxBookings = timeSlots.length > 0 ? Math.max(...timeSlots.map((s) => s.bookings)) : 0

  return (
    <div className="space-y-6">
      {/* Header + period selector */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Analytics</h2>
          <p className="text-sm text-gray-500 mt-0.5">Business performance overview</p>
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {([3, 6, 12] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMonths(m)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                months === m
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {m}M
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon="💰"
          label="Revenue This Month"
          value={`$${kpis.currentMonthRevenue.toFixed(0)}`}
          change={pctChange(kpis.currentMonthRevenue, kpis.prevMonthRevenue)}
          changeColor={pctColor(kpis.currentMonthRevenue, kpis.prevMonthRevenue)}
          sub="vs last month"
        />
        <KpiCard
          icon="📅"
          label="Bookings This Month"
          value={String(kpis.currentMonthBookings)}
          change={pctChange(kpis.currentMonthBookings, kpis.prevMonthBookings)}
          changeColor={pctColor(kpis.currentMonthBookings, kpis.prevMonthBookings)}
          sub="vs last month"
        />
        <KpiCard
          icon="🚫"
          label="Cancellation Rate"
          value={`${kpis.cancellationRate}%`}
          sub={`last ${months} months`}
        />
        <KpiCard
          icon="🔁"
          label="Return Rate"
          value={`${returnRate}%`}
          sub={`${kpis.returningCustomers} of ${kpis.totalUniqueCustomers} customers`}
        />
      </div>

      {/* Revenue & Bookings combo chart */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-1">Revenue &amp; Bookings by Month</h3>
        <p className="text-xs text-gray-400 mb-5">
          Green bars = revenue (left axis) · Blue bars = bookings (right axis)
        </p>
        {byMonth.every((m) => m.revenue === 0 && m.bookings === 0) ? (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
            No data for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={byMonth} margin={{ top: 4, right: 48, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis
                yAxisId="left"
                tickFormatter={(v: number) => `$${v}`}
                tick={{ fontSize: 11 }}
                width={58}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11 }}
                width={32}
                allowDecimals={false}
              />
              <Tooltip
                formatter={(val: number, name: string) =>
                  name === 'Revenue' ? [`$${val.toFixed(0)}`, name] : [val, name]
                }
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                yAxisId="left"
                dataKey="revenue"
                name="Revenue"
                fill="#10b981"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                yAxisId="right"
                dataKey="bookings"
                name="Bookings"
                fill="#3b82f6"
                radius={[4, 4, 0, 0]}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Lane popularity + Peak hours side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Lane Popularity */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-base font-semibold text-gray-800 mb-4">Most Popular Lanes</h3>
          {lanes.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
              No booking data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                layout="vertical"
                data={lanes}
                margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11 }}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11 }}
                  width={112}
                />
                <Tooltip
                  formatter={(v: number, _name: string, props: any) => [
                    `${v} bookings (${props.payload?.hours?.toFixed(1) ?? 0} hrs)`,
                    'Lane',
                  ]}
                />
                <Bar dataKey="bookings" radius={[0, 4, 4, 0]}>
                  {lanes.map((_, i) => (
                    <Cell key={i} fill={LANE_COLORS[i % LANE_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Peak Hours */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-base font-semibold text-gray-800 mb-4">Peak Booking Times</h3>
          {timeSlots.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
              No booking data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={timeSlots}
                margin={{ top: 0, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip formatter={(v: number) => [v, 'Bookings']} />
                <Bar dataKey="bookings" radius={[4, 4, 0, 0]}>
                  {timeSlots.map((slot, i) => (
                    <Cell
                      key={i}
                      fill={slot.bookings === maxBookings && maxBookings > 0 ? '#d97706' : '#fbbf24'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          {timeSlots.length > 0 && (
            <p className="text-xs text-gray-400 mt-2 text-center">
              Peak: {timeSlots.find((s) => s.bookings === maxBookings)?.label ?? '—'} ({maxBookings} bookings)
            </p>
          )}
        </div>
      </div>

      {/* Customer Breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <CustomerCard
          icon="👥"
          label="Total Unique Customers"
          value={kpis.totalUniqueCustomers}
          accentClass="bg-blue-50 text-blue-600"
        />
        <CustomerCard
          icon="🆕"
          label="New Customers"
          value={kpis.newCustomers}
          sub="first booking only"
          accentClass="bg-violet-50 text-violet-600"
        />
        <CustomerCard
          icon="🔁"
          label="Returning Customers"
          value={kpis.returningCustomers}
          sub="2 or more bookings"
          accentClass="bg-emerald-50 text-emerald-600"
        />
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function KpiCard({
  icon,
  label,
  value,
  change,
  changeColor,
  sub,
}: {
  icon: string
  label: string
  value: string
  change?: string
  changeColor?: string
  sub?: string
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div className="text-2xl mb-3">{icon}</div>
      <div className="text-2xl font-bold text-gray-900 leading-none">{value}</div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
      {change && change !== '—' && (
        <div className={`text-xs font-semibold mt-1.5 ${changeColor}`}>{change} {sub}</div>
      )}
      {(!change || change === '—') && sub && (
        <div className="text-xs text-gray-400 mt-1.5">{sub}</div>
      )}
    </div>
  )
}

function CustomerCard({
  icon,
  label,
  value,
  sub,
  accentClass,
}: {
  icon: string
  label: string
  value: number
  sub?: string
  accentClass: string
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl shrink-0 ${accentClass}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-bold text-gray-900">{value}</div>
        <div className="text-sm font-medium text-gray-700 truncate">{label}</div>
        {sub && <div className="text-xs text-gray-400">{sub}</div>}
      </div>
    </div>
  )
}
