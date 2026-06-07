// SPEC_ANALYTICS_BUILD_2026-06 — Overview tab. The original booking-metrics
// dashboard (getAdminAnalytics) + the catchment reports, lifted intact from the
// previous single-file AdminAnalyticsDashboard so the tabbed shell can host it
// alongside the new tabs. Driven by the GLOBAL analytics range picker (8 presets)
// instead of a local months selector; supports the LOCKED comparison UX (overlaid
// time-series + KPI deltas, with distributions/tables on the current period only).
import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import {
  ComposedChart,
  Bar,
  BarChart,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import {
  type AnalyticsRange,
  DeltaKpi,
  PERIOD_COLORS,
  periodsOf,
  usePeriodResults,
  fmtMoney,
} from './shared'

const LANE_COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444']

export default function OverviewTab({ range }: { range: AnalyticsRange }) {
  const [peakMode, setPeakMode] = useState<'all' | 'weekday' | 'weekend'>('all')

  // One getAdminAnalytics query per comparison period (index 0 = current window).
  // In non-comparison mode `periods` has length 1, so only the current slot runs.
  const periods = periodsOf(range)
  const results = usePeriodResults<any>(
    api.analytics.getAdminAnalytics,
    periods,
    (p) => ({ from: p.from, to: p.to }),
  )
  const data = results[0]
  const compare = range.compare

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

  const { kpis, byMonth, lanes, timeSlots, byDayOfWeek, topCustomers } = data
  const prevKpis = compare ? results[1]?.kpis : undefined
  const timeSlotsWeekday = (data as any).timeSlotsWeekday ?? []
  const timeSlotsWeekend = (data as any).timeSlotsWeekend ?? []
  const peakData = peakMode === 'weekday' ? timeSlotsWeekday : peakMode === 'weekend' ? timeSlotsWeekend : timeSlots

  // Overlaid revenue/bookings series — aligned by BUCKET INDEX (position in each
  // period's byMonth array), one line per period coloured by PERIOD_COLORS[i].
  const overlayLen = Math.max(0, ...results.map((r) => r?.byMonth?.length ?? 0))
  const overlayRevenue = Array.from({ length: overlayLen }).map((_, i) => {
    const row: any = { idx: i + 1 }
    periods.forEach((p, pi) => {
      const b = results[pi]?.byMonth?.[i]
      row[p.label] = b ? b.revenue : null
    })
    return row
  })
  const overlayBookings = Array.from({ length: overlayLen }).map((_, i) => {
    const row: any = { idx: i + 1 }
    periods.forEach((p, pi) => {
      const b = results[pi]?.byMonth?.[i]
      row[p.label] = b ? b.bookings : null
    })
    return row
  })

  const pct = (cur: number, prev: number): string => {
    if (prev === 0) return cur > 0 ? '+100%' : '—'
    const c = ((cur - prev) / prev) * 100
    return (c >= 0 ? '+' : '') + c.toFixed(1) + '%'
  }
  const pctColor = (cur: number, prev: number) =>
    cur >= prev ? 'text-emerald-600' : 'text-red-500'

  const returnRate =
    kpis.totalUniqueCustomers > 0
      ? Math.round((kpis.returningCustomers / kpis.totalUniqueCustomers) * 100)
      : 0

  const totalBookingTypes = kpis.coachBookingsCount + kpis.customerBookingsCount
  const coachPct = totalBookingTypes > 0 ? Math.round((kpis.coachBookingsCount / totalBookingTypes) * 100) : 0
  const customerPct = 100 - coachPct

  const maxBookings = peakData.length > 0 ? Math.max(...peakData.map((s: any) => s.bookings)) : 0
  const maxDayBookings = byDayOfWeek.length > 0 ? Math.max(...byDayOfWeek.map((d) => d.bookings)) : 0

  const totalBookings = kpis.customerBookingsCount + kpis.coachBookingsCount
  const win = `(${range.from} → ${range.to})`

  return (
    <div className="space-y-6">
      {/* Header — window now comes from the global range picker above. */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Overview</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Booking and revenue insights · {range.from} → {range.to}
            {compare && <span className="text-violet-600 font-medium"> · comparing {periods.length} periods</span>}
          </p>
        </div>
      </div>

      {/* ── KPI Row 1: Period totals ───────────────────────────────────────── */}
      {compare ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <DeltaKpi icon="💰" label="Revenue (window)" value={kpis.periodRevenue} prev={prevKpis?.periodRevenue} format={fmtMoney} />
          <DeltaKpi icon="📅" label="Bookings (window)" value={totalBookings}
            prev={prevKpis ? prevKpis.customerBookingsCount + prevKpis.coachBookingsCount : undefined} format={(n) => String(Math.round(n))} />
          <DeltaKpi icon="⏱️" label="Hours Booked (window)" value={kpis.periodHours} prev={prevKpis?.periodHours} format={(n) => `${n.toFixed(0)} hrs`} />
          <DeltaKpi icon="🏏" label="Coach Charges (window)" value={kpis.periodCoachCharges} prev={prevKpis?.periodCoachCharges} format={fmtMoney} />
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <KpiCard
            icon="💰"
            label={`Revenue ${win}`}
            value={`$${kpis.periodRevenue.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
            sub={`Avg $${kpis.avgRevenuePerBooking.toFixed(0)} / booking`}
          />
          <KpiCard
            icon="📅"
            label={`Bookings ${win}`}
            value={String(totalBookings)}
            sub={`${kpis.coachBookingsCount} coach · ${kpis.customerBookingsCount} customer`}
          />
          <KpiCard
            icon="⏱️"
            label={`Hours Booked ${win}`}
            value={`${kpis.periodHours.toFixed(0)} hrs`}
            sub={`Avg ${totalBookingTypes > 0 ? ((kpis.periodHours / (totalBookingTypes)) * 60).toFixed(0) : 0} min / session`}
          />
          <KpiCard
            icon="🏏"
            label={`Coach Charges ${win}`}
            value={`$${kpis.periodCoachCharges.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
            sub="Accumulated on statements"
          />
        </div>
      )}

      {/* ── KPI Row 2: Month-over-month + window rates ─────────────────────── */}
      {compare ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <DeltaKpi icon="🚫" label="Cancellation Rate" value={kpis.cancellationRate} prev={prevKpis?.cancellationRate} format={(n) => `${Math.round(n)}%`} />
          <DeltaKpi icon="🔁" label="Returning Customers" value={kpis.returningCustomers} prev={prevKpis?.returningCustomers} format={(n) => String(Math.round(n))} />
          <DeltaKpi icon="✨" label="New Customers" value={kpis.newCustomers} prev={prevKpis?.newCustomers} format={(n) => String(Math.round(n))} />
          <DeltaKpi icon="👥" label="Unique Customers" value={kpis.totalUniqueCustomers} prev={prevKpis?.totalUniqueCustomers} format={(n) => String(Math.round(n))} />
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <KpiCard
            icon="📈"
            label="Revenue This Month"
            value={`$${kpis.currentMonthRevenue.toFixed(0)}`}
            change={pct(kpis.currentMonthRevenue, kpis.prevMonthRevenue)}
            changeColor={pctColor(kpis.currentMonthRevenue, kpis.prevMonthRevenue)}
            sub="vs last month"
          />
          <KpiCard
            icon="🗓️"
            label="Bookings This Month"
            value={String(kpis.currentMonthBookings)}
            change={pct(kpis.currentMonthBookings, kpis.prevMonthBookings)}
            changeColor={pctColor(kpis.currentMonthBookings, kpis.prevMonthBookings)}
            sub="vs last month"
          />
          <KpiCard
            icon="🚫"
            label="Cancellation Rate"
            value={`${kpis.cancellationRate}%`}
            sub="in selected window"
            valueColor={kpis.cancellationRate > 20 ? 'text-red-600' : kpis.cancellationRate > 10 ? 'text-amber-600' : 'text-gray-900'}
          />
          <KpiCard
            icon="🔁"
            label="Return Rate"
            value={`${returnRate}%`}
            sub={`${kpis.returningCustomers} of ${kpis.totalUniqueCustomers} customers`}
            valueColor={returnRate >= 50 ? 'text-emerald-600' : 'text-gray-900'}
          />
        </div>
      )}

      {/* ── Revenue & Bookings time-series ────────────────────────────────── */}
      {compare ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h3 className="text-base font-semibold text-gray-800 mb-1">Customer Revenue</h3>
            <p className="text-xs text-gray-400 mb-5">Overlaid periods, aligned by position within each window</p>
            {overlayLen === 0 ? (
              <div className="flex items-center justify-center h-48 text-gray-400 text-sm">No data for these periods</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={overlayRevenue} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="idx" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v: number) => `$${v}`} tick={{ fontSize: 11 }} width={56} />
                  <Tooltip formatter={(v: number, name: string) => [`$${(v ?? 0).toFixed(0)}`, name]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {periods.map((p, pi) => (
                    <Line key={p.label} type="monotone" dataKey={p.label} stroke={PERIOD_COLORS[pi]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h3 className="text-base font-semibold text-gray-800 mb-1">Bookings</h3>
            <p className="text-xs text-gray-400 mb-5">Overlaid periods, aligned by position within each window</p>
            {overlayLen === 0 ? (
              <div className="flex items-center justify-center h-48 text-gray-400 text-sm">No data for these periods</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={overlayBookings} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="idx" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={32} allowDecimals={false} />
                  <Tooltip formatter={(v: number, name: string) => [v ?? 0, name]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {periods.map((p, pi) => (
                    <Line key={p.label} type="monotone" dataKey={p.label} stroke={PERIOD_COLORS[pi]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      ) : (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-1">Revenue &amp; Bookings</h3>
        <p className="text-xs text-gray-400 mb-5">
          Green bars = customer revenue (left axis) · Blue line = bookings (right axis)
        </p>
        {byMonth.every((m: any) => m.revenue === 0 && m.bookings === 0) ? (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm">No data for this period</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
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
                formatter={(val: number, name: string) => {
                  if (name === 'Revenue') return [`$${val.toFixed(0)}`, name]
                  if (name === 'Coach Charges') return [`$${val.toFixed(0)}`, name]
                  return [val, name]
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="left" dataKey="revenue" name="Revenue" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="left" dataKey="coachCharges" name="Coach Charges" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="bookings"
                name="Bookings"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ r: 3, fill: '#3b82f6' }}
                activeDot={{ r: 5 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
      )}

      {/* ── Booking type split + Day of week ──────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Booking type split */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-base font-semibold text-gray-800 mb-4">Booking Type Split</h3>
          {totalBookingTypes === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-400 text-sm">No booking data</div>
          ) : (
            <div className="space-y-5">
              <div className="h-5 rounded-full overflow-hidden flex">
                <div className="bg-emerald-500 h-full transition-all" style={{ width: `${customerPct}%` }} />
                <div className="bg-violet-500 h-full transition-all" style={{ width: `${coachPct}%` }} />
              </div>
              <div className="flex gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-500" />
                  <span className="text-sm text-gray-600">Customer <span className="font-semibold text-gray-900">{customerPct}%</span></span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-violet-500" />
                  <span className="text-sm text-gray-600">Coach <span className="font-semibold text-gray-900">{coachPct}%</span></span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-emerald-50 rounded-xl p-4">
                  <div className="text-2xl font-bold text-emerald-700">{kpis.customerBookingsCount}</div>
                  <div className="text-xs text-emerald-600 font-medium mt-0.5">Customer Bookings</div>
                  <div className="text-xs text-emerald-500 mt-1">${kpis.periodRevenue.toFixed(0)} revenue</div>
                </div>
                <div className="bg-violet-50 rounded-xl p-4">
                  <div className="text-2xl font-bold text-violet-700">{kpis.coachBookingsCount}</div>
                  <div className="text-xs text-violet-600 font-medium mt-0.5">Coach Bookings</div>
                  <div className="text-xs text-violet-500 mt-1">${kpis.periodCoachCharges.toFixed(0)} charges</div>
                </div>
                <div className="bg-blue-50 rounded-xl p-4">
                  <div className="text-2xl font-bold text-blue-700">{kpis.newCustomers}</div>
                  <div className="text-xs text-blue-600 font-medium mt-0.5">New Customers</div>
                  <div className="text-xs text-blue-500 mt-1">first booking only</div>
                </div>
                <div className="bg-amber-50 rounded-xl p-4">
                  <div className="text-2xl font-bold text-amber-700">{kpis.returningCustomers}</div>
                  <div className="text-xs text-amber-600 font-medium mt-0.5">Returning Customers</div>
                  <div className="text-xs text-amber-500 mt-1">2+ bookings</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Day of week */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-base font-semibold text-gray-800 mb-4">Bookings by Day of Week</h3>
          {byDayOfWeek.every(d => d.bookings === 0) ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">No booking data</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={byDayOfWeek} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={28} />
                  <Tooltip
                    formatter={(v: number, _n: string, props: any) => [
                      `${v} bookings (${props.payload?.hours ?? 0} hrs)`,
                      props.payload?.day,
                    ]}
                  />
                  <Bar dataKey="bookings" radius={[4, 4, 0, 0]}>
                    {byDayOfWeek.map((d, i) => (
                      <Cell key={i} fill={d.bookings === maxDayBookings && maxDayBookings > 0 ? '#10b981' : '#d1fae5'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {maxDayBookings > 0 && (
                <p className="text-xs text-gray-400 mt-2 text-center">
                  Busiest day: <span className="font-semibold text-gray-600">
                    {byDayOfWeek.find(d => d.bookings === maxDayBookings)?.day}
                  </span> ({maxDayBookings} bookings)
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Lane popularity + Peak hours ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-base font-semibold text-gray-800 mb-4">Lane Utilisation</h3>
          {lanes.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">No booking data</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart layout="vertical" data={lanes} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
                <Tooltip
                  formatter={(v: number, _n: string, props: any) => [
                    `${v} bookings · ${props.payload?.hours ?? 0} hrs`,
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

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <h3 className="text-base font-semibold text-gray-800">Peak Booking Times</h3>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              {(['all', 'weekday', 'weekend'] as const).map((m) => (
                <button key={m} onClick={() => setPeakMode(m)}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold capitalize ${peakMode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{m}</button>
              ))}
            </div>
          </div>
          {peakData.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">No {peakMode === 'all' ? '' : peakMode + ' '}booking data</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={peakData} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={28} />
                  <Tooltip formatter={(v: number) => [v, 'Bookings']} />
                  <Bar dataKey="bookings" radius={[4, 4, 0, 0]}>
                    {peakData.map((slot: any, i: number) => (
                      <Cell
                        key={i}
                        fill={slot.bookings === maxBookings && maxBookings > 0 ? (peakMode === 'weekend' ? '#7c3aed' : '#d97706') : (peakMode === 'weekend' ? '#ddd6fe' : '#fde68a')}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <p className="text-xs text-gray-400 mt-2 text-center">
                Peak ({peakMode}): <span className="font-semibold text-gray-600">
                  {peakData.find((s: any) => s.bookings === maxBookings)?.label}
                </span> ({maxBookings} bookings)
              </p>
            </>
          )}
        </div>
      </div>

      {/* ── Top customers table ────────────────────────────────────────────── */}
      {topCustomers.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-base font-semibold text-gray-800">Top Customers</h3>
            <p className="text-xs text-gray-400 mt-0.5">Most active customers in the selected period</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-8">#</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Bookings</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {topCustomers.map((c, i) => (
                  <tr key={c.email} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-gray-400 font-medium">{i + 1}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                    <td className="px-4 py-3 text-gray-500">{c.email}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center justify-center bg-emerald-100 text-emerald-700 text-xs font-bold rounded-full w-8 h-8">
                        {c.bookings}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600 font-medium">{c.hours} hrs</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Catchment: sessions by suburb (customer + athlete, side-by-side) ── */}
      <CatchmentReports />
    </div>
  )
}

// ── Catchment sub-components (unchanged from the original dashboard) ──────────
type CatchmentData = {
  bySuburb: { suburb: string; postcode: string; bookings: number; customers?: number }[]
  unknown: number
  total: number
  uniqueCustomers?: number
} | null | undefined

function CatchmentReports() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const customerData = useQuery(api.analytics.getCatchmentReport, {
    from: from || undefined,
    to: to || undefined,
  })
  const athleteData = useQuery(api.analytics.getAthleteCatchmentReport, {
    from: from || undefined,
    to: to || undefined,
  })

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-gray-800">Catchment — Sessions by Suburb</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            Where people travel from. Confirmed bookings only (excludes cancelled). Customers (lane hire) vs athletes coached.
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <label className="text-xs text-gray-500">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="block mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm" />
          </label>
          <label className="text-xs text-gray-500">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="block mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm" />
          </label>
          {(from || to) && (
            <button onClick={() => { setFrom(''); setTo('') }}
              className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-800 underline">Clear</button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-100">
        <CatchmentTable
          title="Customers — unique customers by suburb"
          subtitle="Distinct lane-hire customers per suburb (unique-user bookings; excludes coach bookings)."
          data={customerData}
          accent="emerald"
          showCustomers
          csvName={`catchment-customers${from ? `_${from}` : ''}${to ? `_${to}` : ''}.csv`}
          csvHeader="customerSessions"
        />
        <CatchmentTable
          title="Athletes coached — sessions by suburb"
          subtitle="Athletes allocated to coach bookings, by their home suburb."
          data={athleteData}
          accent="indigo"
          csvName={`catchment-athletes${from ? `_${from}` : ''}${to ? `_${to}` : ''}.csv`}
          csvHeader="athleteSessions"
        />
      </div>
    </div>
  )
}

function CatchmentTable({
  title,
  subtitle,
  data,
  accent,
  csvName,
  csvHeader,
  showCustomers = false,
}: {
  title: string
  subtitle: string
  data: CatchmentData
  accent: 'emerald' | 'indigo'
  csvName: string
  csvHeader: string
  showCustomers?: boolean
}) {
  const rows = data?.bySuburb ?? []
  const counted = (data?.total ?? 0) - (data?.unknown ?? 0)
  const badge = accent === 'indigo'
    ? 'bg-indigo-100 text-indigo-700'
    : 'bg-emerald-100 text-emerald-700'

  const exportCsv = () => {
    if (!data) return
    const lines = showCustomers
      ? [['Suburb', 'Postcode', 'uniqueCustomers', csvHeader]]
      : [['Suburb', 'Postcode', csvHeader]]
    for (const r of rows) lines.push(showCustomers
      ? [r.suburb, r.postcode, String(r.customers ?? 0), String(r.bookings)]
      : [r.suburb, r.postcode, String(r.bookings)])
    if (data.unknown > 0) lines.push(showCustomers ? ['Unknown', '', '', String(data.unknown)] : ['Unknown', '', String(data.unknown)])
    const csv = lines
      .map((cols) => cols.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = csvName
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-w-0">
      <div className="px-5 py-3 flex items-start justify-between gap-3 border-b border-gray-100">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-gray-700">{title}</h4>
          <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>
        </div>
        <button onClick={exportCsv} disabled={!data || rows.length === 0}
          className="shrink-0 px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          CSV
        </button>
      </div>
      {!data ? (
        <div className="p-6 text-sm text-gray-400">Loading…</div>
      ) : rows.length === 0 && (data.unknown ?? 0) === 0 ? (
        <div className="p-6 text-sm text-gray-400 italic">No confirmed sessions in this range.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-8">#</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Suburb</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Postcode</th>
                {showCustomers && <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Customers</th>}
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Sessions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, i) => (
                <tr key={`${r.suburb}|${r.postcode}`} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-gray-400 font-medium">{i + 1}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{r.suburb}</td>
                  <td className="px-4 py-3 text-gray-500">{r.postcode || '—'}</td>
                  {showCustomers && (
                    <td className="px-4 py-3 text-right">
                      <span className={`inline-flex items-center justify-center ${badge} text-xs font-bold rounded-full min-w-8 h-8 px-2`}>
                        {r.customers ?? 0}
                      </span>
                    </td>
                  )}
                  <td className="px-4 py-3 text-right text-gray-600 font-medium">{r.bookings}</td>
                </tr>
              ))}
              {data.unknown > 0 && (
                <tr className="bg-amber-50/50">
                  <td className="px-4 py-3 text-gray-400 font-medium">—</td>
                  <td className="px-4 py-3 font-medium text-amber-700" colSpan={2}>
                    Unknown <span className="text-xs font-normal text-amber-600">(no postcode captured yet)</span>
                  </td>
                  {showCustomers && <td className="px-4 py-3 text-right text-amber-700">—</td>}
                  <td className="px-4 py-3 text-right text-amber-700 font-bold">{data.unknown}</td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-gray-50 border-t border-gray-200">
              <tr>
                <td className="px-4 py-3" />
                <td className="px-4 py-3 font-semibold text-gray-700" colSpan={2}>{showCustomers ? 'Totals' : 'Total confirmed sessions'}</td>
                {showCustomers && <td className="px-4 py-3 text-right font-bold text-gray-900">{data.uniqueCustomers ?? counted}</td>}
                <td className="px-4 py-3 text-right font-bold text-gray-900">{data.total}{data.unknown > 0 ? ` (${counted} mapped)` : ''}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

function KpiCard({
  icon,
  label,
  value,
  change,
  changeColor,
  sub,
  valueColor = 'text-gray-900',
}: {
  icon: string
  label: string
  value: string
  change?: string
  changeColor?: string
  sub?: string
  valueColor?: string
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div className="text-xl mb-2">{icon}</div>
      <div className={`text-2xl font-bold leading-none ${valueColor}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-1.5 font-medium">{label}</div>
      {change && change !== '—' && (
        <div className={`text-xs font-semibold mt-1 ${changeColor}`}>{change} {sub}</div>
      )}
      {(!change || change === '—') && sub && (
        <div className="text-xs text-gray-400 mt-1">{sub}</div>
      )}
    </div>
  )
}
