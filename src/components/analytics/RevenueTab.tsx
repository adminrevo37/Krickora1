// SPEC_ANALYTICS_BUILD_2026-06 C2.7 (time-series revenue/bookings, navigable
// hour/day/week/month incl. future), C2.2 (persisted snapshots), C2.9 (credit).
import { useState, useEffect } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { type DateRange, KpiCard, Section, Loading, Empty, downloadCsv, fmtMoney, fmtMins, BarRow } from './shared'

type Gran = 'hour' | 'day' | 'week' | 'month'

const addDaysKey = (key: string, days: number): string => {
  const [y, m, d] = key.split('-').map(Number)
  const ms = Date.UTC(y, (m || 1) - 1, d || 1) + days * 86400000
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}
const todayKey = () => addDaysKey(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), 0)

// Default window span (days) per granularity — biased to include some future.
const SPAN: Record<Gran, { back: number; fwd: number }> = {
  hour: { back: 30, fwd: 0 },
  day: { back: 23, fwd: 7 },
  week: { back: 77, fwd: 14 },
  month: { back: 300, fwd: 60 },
}

export default function RevenueTab({ range }: { range: DateRange }) {
  const [gran, setGran] = useState<Gran>('day')
  const [win, setWin] = useState(() => {
    const t = todayKey()
    return { from: addDaysKey(t, -SPAN.day.back), to: addDaysKey(t, SPAN.day.fwd) }
  })

  // Reset the window to a sensible default whenever granularity changes.
  useEffect(() => {
    const t = todayKey()
    setWin({ from: addDaysKey(t, -SPAN[gran].back), to: addDaysKey(t, SPAN[gran].fwd) })
  }, [gran])

  const bounds = useQuery(api.analyticsAdmin.getBookingDateBounds, {})
  const series = useQuery(api.analyticsAdmin.getBookingRevenueSeries, {
    granularity: gran, from: win.from, to: win.to,
  })
  const credit = useQuery(api.analyticsAdmin.getCreditAnalytics, {
    from: range.from || undefined, to: range.to || undefined,
  })
  const period = useQuery(api.analyticsAdmin.getPeriodSummary, {})
  const lead = useQuery(api.analyticsAdmin.getBookingLeadTime, {
    from: range.from || undefined, to: range.to || undefined,
  })

  const shift = (dir: -1 | 1) => {
    // For 'hour' the window aggregates a date range; nudge by the span too.
    const [y1, m1, d1] = win.from.split('-').map(Number)
    const [y2, m2, d2] = win.to.split('-').map(Number)
    const span = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1
    setWin({ from: addDaysKey(win.from, dir * span), to: addDaysKey(win.to, dir * span) })
  }

  const rows = series?.series ?? []
  const totalCust = rows.reduce((s: number, r: any) => s + r.custRevenue, 0)
  const totalCoach = rows.reduce((s: number, r: any) => s + r.coachCharges, 0)
  const totalBookings = rows.reduce((s: number, r: any) => s + r.bookings, 0)

  const exportCsv = () => {
    const header = ['Bucket', 'CustomerRevenue', 'CoachCharges', 'Bookings', 'CustomerBookings', 'CoachBookings', 'Hours']
    downloadCsv(`revenue_${gran}_${win.from}_${win.to}.csv`,
      [header, ...rows.map((r: any) => [r.label, r.custRevenue, r.coachCharges, r.bookings, r.customerBookings, r.coachBookings, r.hours])])
  }

  return (
    <div className="space-y-5">
      {/* Today / this week / next week snapshot */}
      <PeriodSummary period={period} />

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {(['hour', 'day', 'week', 'month'] as Gran[]).map((g) => (
            <button key={g} onClick={() => setGran(g)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold capitalize transition-colors ${gran === g ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
              {g === 'hour' ? 'By hour' : g + 'ly'}
            </button>
          ))}
        </div>
        {gran !== 'hour' && (
          <div className="flex items-center gap-2 text-sm">
            <button onClick={() => shift(-1)} className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">‹ Earlier</button>
            <span className="text-gray-500 tabular-nums">{win.from} → {win.to}</span>
            <button onClick={() => shift(1)} className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">Later ›</button>
          </div>
        )}
      </div>
      {bounds && (bounds.min || bounds.max) && (
        <p className="text-[11px] text-gray-400 -mt-2">
          Bookings on record span {bounds.min} → {bounds.max} (future bookings included — scroll “Later ›”).
        </p>
      )}

      {/* KPI row for the window */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard icon="💰" label={`Customer revenue (window)`} value={fmtMoney(totalCust)} tone="emerald" />
        <KpiCard icon="🏏" label="Coach charges (window)" value={fmtMoney(totalCoach)} tone="violet" />
        <KpiCard icon="📅" label="Bookings (window)" value={String(totalBookings)} tone="blue" />
        <KpiCard icon="📊" label="Buckets" value={String(rows.length)} sub={gran === 'hour' ? 'by hour of day' : `${gran} buckets`} />
      </div>

      {/* Chart */}
      <Section title="Revenue & bookings" subtitle={gran === 'hour' ? 'Aggregated by hour of day (scheduled)' : `Per ${gran}, by session date`}
        action={<button onClick={exportCsv} disabled={rows.length === 0}
          className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">CSV</button>}>
        <div className="p-5">
          {!series ? <Loading /> : rows.length === 0 ? <Empty /> : (
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={rows} margin={{ top: 4, right: 40, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" tickFormatter={(v: number) => `$${v}`} tick={{ fontSize: 11 }} width={56} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} width={32} allowDecimals={false} />
                <Tooltip formatter={(val: number, name: string) => (name === 'Bookings' ? [val, name] : [`$${val.toFixed(0)}`, name])} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="left" dataKey="custRevenue" name="Customer $" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar yAxisId="left" dataKey="coachCharges" name="Coach $" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="bookings" name="Bookings" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </Section>

      {/* Booking lead time — how far ahead people book */}
      <LeadTimePanel lead={lead} />

      {/* Credit analytics (C2.9) */}
      <CreditPanel credit={credit} />
    </div>
  )
}

function PeriodSummary({ period }: { period: any }) {
  if (period === undefined) return <Loading label="Loading today…" />
  if (period === null) return null
  const Card = ({ title, b, tone, extra }: { title: string; b: any; tone: any; extra?: string }) => (
    <div className={`rounded-2xl border border-gray-200 shadow-sm p-5 ${tone}`}>
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{fmtMoney(b.custRevenue)}</div>
      <div className="text-xs text-gray-500 mt-0.5">customer revenue</div>
      <div className="mt-2 text-sm text-gray-700">{b.bookings} booking{b.bookings !== 1 ? 's' : ''} · {b.hours} hrs</div>
      {b.coachCharges > 0 && <div className="text-xs text-violet-600 mt-0.5">+ {fmtMoney(b.coachCharges)} coach charges</div>}
      {extra && <div className="text-[11px] text-gray-400 mt-1">{extra}</div>}
    </div>
  )
  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
      <Card title="Today" b={period.today} tone="bg-emerald-50" extra={`${period.createdToday.count} booking${period.createdToday.count !== 1 ? 's' : ''} created today (${fmtMoney(period.createdToday.custRevenue)})`} />
      <Card title="This week" b={period.thisWeek} tone="bg-blue-50" extra={`${period.ranges.thisMon} → ${period.ranges.thisSun}`} />
      <Card title="Next week" b={period.nextWeek} tone="bg-violet-50" extra={`${period.ranges.nextMon} → ${period.ranges.nextSun}`} />
      <div className="rounded-2xl border border-gray-200 shadow-sm p-5 bg-amber-50">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Created today</div>
        <div className="text-2xl font-bold text-gray-900 mt-1">{period.createdToday.count}</div>
        <div className="text-xs text-gray-500 mt-0.5">new bookings made today</div>
        <div className="mt-2 text-sm text-gray-700">{fmtMoney(period.createdToday.custRevenue)} value</div>
      </div>
    </div>
  )
}

function LeadTimePanel({ lead }: { lead: any }) {
  const rows = lead ? [
    { label: '> 2 weeks', value: lead.buckets.gt14, color: 'bg-emerald-600' },
    { label: '1–2 weeks', value: lead.buckets.d7_14, color: 'bg-emerald-500' },
    { label: '3–7 days', value: lead.buckets.d3_7, color: 'bg-blue-500' },
    { label: '1–3 days', value: lead.buckets.d1_3, color: 'bg-blue-400' },
    { label: '2–24 hours', value: lead.buckets.h2_24, color: 'bg-amber-500' },
    { label: '< 2 hours', value: lead.buckets.lt2h, color: 'bg-red-500' },
    { label: 'walk-in / after start', value: lead.buckets.walk_in, color: 'bg-gray-400' },
  ] : []
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0)
  return (
    <Section title="Booking lead time" subtitle="How far ahead people book — gap between when the booking was made and the session start">
      {lead === undefined ? <Loading /> : !lead || lead.counted === 0 ? (
        <Empty label="No bookings with a creation timestamp in range yet (tracked on bookings made from June 2026 on)." />
      ) : (
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KpiCard label="Median lead" value={fmtMins(lead.medianLeadHours * 60)} sub={`${lead.medianLeadDays} days`} tone="emerald" />
            <KpiCard label="Avg lead" value={`${lead.avgLeadDays} days`} />
            <KpiCard label="Customer median" value={`${lead.custMedianLeadDays} days`} sub="customers only" tone="blue" />
            <KpiCard label="Bookings analysed" value={String(lead.counted)} />
          </div>
          <div className="space-y-2">
            {rows.map((r) => <BarRow key={r.label} label={r.label} value={r.value} max={max} color={r.color} />)}
          </div>
        </div>
      )}
    </Section>
  )
}

function CreditPanel({ credit }: { credit: any }) {
  return (
    <Section title="Account credit" subtitle="Credit issued (mostly from cancellations), redeemed, and how long it takes customers to use it">
      {credit === undefined ? <Loading /> : credit === null ? <Empty label="Unavailable." /> : (
        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KpiCard label="Credit issued" value={fmtMoney(credit.totalIssued)} sub={`${credit.issuedCount} entries`} tone="amber" />
            <KpiCard label="From cancellations" value={fmtMoney(credit.cancellationCredit)} sub="cancellation credit" tone="red" />
            <KpiCard label="Redeemed" value={fmtMoney(credit.totalRedeemed)} sub={`${credit.redeemedPctOfIssued}% of issued`} tone="emerald" />
            <KpiCard label="Outstanding" value={fmtMoney(credit.outstanding)} sub={`${credit.holders} customers hold credit`} tone="blue" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Time to redeem</div>
              <div className="flex gap-6">
                <div><div className="text-2xl font-bold text-gray-900">{credit.medianDaysToRedeem}</div><div className="text-xs text-gray-500">median days</div></div>
                <div><div className="text-2xl font-bold text-gray-900">{credit.avgDaysToRedeem}</div><div className="text-xs text-gray-500">avg days</div></div>
                <div><div className="text-2xl font-bold text-gray-900">{credit.matchedRedemptions}</div><div className="text-xs text-gray-500">redemptions matched</div></div>
              </div>
            </div>
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Issued by reason</div>
              <div className="space-y-1.5">
                {Object.entries(credit.issuedByReason ?? {}).length === 0 ? (
                  <div className="text-sm text-gray-400 italic">No credit issued in range.</div>
                ) : Object.entries(credit.issuedByReason as Record<string, number>)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, amt]) => (
                    <div key={reason} className="flex justify-between text-sm">
                      <span className="text-gray-600 capitalize">{reason.replace(/_/g, ' ')}</span>
                      <span className="font-medium text-gray-900">{fmtMoney(amt)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </Section>
  )
}
