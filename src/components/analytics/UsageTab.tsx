// SPEC_ANALYTICS_BUILD_2026-06 C2.3 (app usage) + C2.8 (door-code access lead time).
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import {
  type AnalyticsRange, KpiCard, DeltaKpi, Section, Loading, Empty, BarRow, fmtMins,
  periodsOf, usePeriodResults, PERIOD_COLORS,
} from './shared'

function SplitCard({ title, data, color }: { title: string; data: Record<string, number>; color: string }) {
  const entries = Object.entries(data ?? {}).sort((a, b) => b[1] - a[1])
  const max = entries.reduce((m, [, v]) => Math.max(m, v), 0)
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h4 className="text-sm font-semibold text-gray-700 mb-3">{title}</h4>
      {entries.length === 0 ? <div className="text-sm text-gray-400 italic">No data.</div> : (
        <div className="space-y-2">
          {entries.map(([k, v]) => <BarRow key={k} label={k} value={v} max={max} color={color} />)}
        </div>
      )}
    </div>
  )
}

export default function UsageTab({ range }: { range: AnalyticsRange }) {
  // A) Live active-user snapshot (range-independent).
  const snapshot = useQuery(api.analyticsUsage.getActiveUserSnapshot, {})

  // B) One query per comparison period (results[0] = current). In non-comparison
  // mode periods has length 1, so only the current window runs.
  const periods = periodsOf(range)
  const results = usePeriodResults<any>(
    api.analyticsUsage.getUsageAnalytics,
    periods,
    (p) => ({ from: p.from, to: p.to, fromMs: p.fromMs, toMs: p.toMs }),
  )
  const data = results[0]
  const prev = results[1]
  const comparing = range.compare && periods.length > 1

  // C) Lead time stays current-period only; sub-day windows need the ms bounds.
  const lead = useQuery(api.analyticsUsage.getCodeAccessLeadTime, {
    from: range.from || undefined,
    to: range.to || undefined,
    fromMs: range.fromMs,
    toMs: range.toMs,
  })

  if (data === undefined) return <Loading label="Loading usage…" />
  if (data === null) return <Empty label="Unavailable." />

  const leadBuckets = lead ? [
    { label: '>24h before', value: lead.buckets.gt24 },
    { label: '6–24h', value: lead.buckets.h6_24 },
    { label: '1–6h', value: lead.buckets.h1_6 },
    { label: '22–60 min', value: lead.buckets.m22_60 },
    { label: '<22 min', value: lead.buckets.lt22 },
    { label: 'after start', value: lead.buckets.after_start },
  ] : []

  // Overlay the daily-active series, aligned by bucket index across periods.
  const maxLen = comparing
    ? Math.max(0, ...results.map((r) => r?.dailyActive?.length ?? 0))
    : 0
  const overlayData = comparing
    ? Array.from({ length: maxLen }).map((_, i) => {
      const row: any = { idx: i + 1 }
      periods.forEach((p, pi) => {
        const v = results[pi]?.dailyActive?.[i]
        row[p.label] = v ? v.users : null
        row[`__date${pi}`] = v?.date ?? ''
      })
      return row
    })
    : []

  return (
    <div className="space-y-5">
      {/* A) Live active-user snapshot */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard icon="🟢" label="Active — last hour"
          value={snapshot == null ? '…' : String(snapshot.lastHour)} tone="emerald" />
        <KpiCard icon="📆" label="Active — today"
          value={snapshot == null ? '…' : String(snapshot.today)} tone="blue" />
      </div>

      {/* B) KPI rows — DeltaKpi vs prev period when comparing, else plain cards. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {comparing ? (
          <DeltaKpi icon="👥" label="Unique visitors" value={data.uniqueUsers} prev={prev?.uniqueUsers} format={(n) => String(n)} tone="blue" />
        ) : (
          <KpiCard icon="👥" label="Unique visitors" value={String(data.uniqueUsers)} sub={`${data.sessions} sessions`} tone="blue" />
        )}
        <KpiCard icon="📈" label="WAU / MAU" value={`${data.wau} / ${data.mau}`} sub="last 7 / 30 days" tone="emerald" />
        {comparing ? (
          <DeltaKpi icon="⏱️" label="Avg session (min)" value={data.avgSessionMin} prev={prev?.avgSessionMin} format={fmtMins} />
        ) : (
          <KpiCard icon="⏱️" label="Avg session" value={fmtMins(data.avgSessionMin)} sub={`median ${fmtMins(data.medianSessionMin)}`} />
        )}
        {comparing ? (
          <DeltaKpi icon="📄" label="Pageviews / session" value={data.pageviewsPerSession} prev={prev?.pageviewsPerSession} format={(n) => String(n)} />
        ) : (
          <KpiCard icon="📄" label="Pageviews / session" value={String(data.pageviewsPerSession)} sub={`${data.pageviews} pageviews`} />
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {comparing ? (
          <DeltaKpi icon="✨" label="New visitors" value={data.newVisitors} prev={prev?.newVisitors} format={(n) => String(n)} tone="emerald" />
        ) : (
          <KpiCard icon="✨" label="New visitors" value={String(data.newVisitors)} tone="emerald" />
        )}
        {comparing ? (
          <DeltaKpi icon="🔁" label="Returning" value={data.returning} prev={prev?.returning} format={(n) => String(n)} tone="amber" />
        ) : (
          <KpiCard icon="🔁" label="Returning" value={String(data.returning)} tone="amber" />
        )}
        {comparing ? (
          <DeltaKpi icon="🧭" label="Sessions / user" value={data.sessionsPerUser} prev={prev?.sessionsPerUser} format={(n) => String(n)} />
        ) : (
          <KpiCard icon="🧭" label="Sessions / user" value={String(data.sessionsPerUser)} />
        )}
        <KpiCard icon="🟢" label="Active days tracked" value={String(data.dailyActive.length)} />
      </div>

      <Section title="Daily active visitors"
        subtitle={comparing ? 'Distinct visitors per day — overlaid by period (aligned by position)' : 'Distinct visitors per day (AWST)'}>
        <div className="p-5">
          {comparing ? (
            overlayData.length === 0 ? <Empty label="No sessions tracked yet — analytics begins collecting once this build is live." /> : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={overlayData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="idx" tick={{ fontSize: 11 }} label={{ value: 'day #', position: 'insideBottom', offset: -2, fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={28} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {periods.map((p, pi) => (
                    <Line key={p.label} type="monotone" dataKey={p.label} stroke={PERIOD_COLORS[pi]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )
          ) : data.dailyActive.length === 0 ? <Empty label="No sessions tracked yet — analytics begins collecting once this build is live." /> : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data.dailyActive} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={28} />
                <Tooltip />
                <Bar dataKey="users" name="Visitors" fill="#10b981" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Section>

      {/* Tables/splits show the CURRENT period only (comparison does not fan tables). */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SplitCard title="Device" data={data.device} color="bg-blue-500" />
        <SplitCard title="Operating system" data={data.os} color="bg-violet-500" />
        <SplitCard title="Browser" data={data.browser} color="bg-emerald-500" />
      </div>

      <Section title="Top pages" subtitle="Most-viewed routes in range">
        {data.topPages.length === 0 ? <Empty /> : (
          <div className="p-5 space-y-2">
            {data.topPages.map((p: any) => (
              <BarRow key={p.path} label={p.path} value={p.count} max={data.topPages[0].count} color="bg-gray-400" />
            ))}
          </div>
        )}
      </Section>

      {/* C2.8 — door-code access lead time (current period only) */}
      <Section title="Door-code access lead time"
        subtitle="When people open the app to get their access code, relative to their booking start">
        {lead === undefined ? <Loading /> : !lead || lead.total === 0 ? (
          <Empty label="No code views tracked yet (begins collecting once live)." />
        ) : (
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <KpiCard label="Median lead" value={fmtMins(lead.medianLeadMin)} sub="before session start" tone="emerald" />
              <KpiCard label="Avg lead" value={fmtMins(lead.avgLeadMin)} />
              <KpiCard label="Code views" value={String(lead.total)} />
            </div>
            <div className="space-y-2">
              {leadBuckets.map((b) => (
                <BarRow key={b.label} label={b.label} value={b.value}
                  max={leadBuckets.reduce((m, x) => Math.max(m, x.value), 0)}
                  color={b.label === 'after start' ? 'bg-red-400' : b.label === '<22 min' ? 'bg-amber-500' : 'bg-blue-500'} />
              ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}
