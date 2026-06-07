// SPEC_ANALYTICS_BUILD_2026-06 C2.6 — lane occupancy (booked hours ÷ open lane-hours).
import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts'
import {
  type AnalyticsRange, KpiCard, DeltaKpi, Section, Loading, Empty, BarRow, downloadCsv,
  periodsOf, usePeriodResults, PERIOD_COLORS,
} from './shared'

const hourLabel = (h: number) => {
  const period = h >= 12 ? 'pm' : 'am'
  const disp = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${disp}${period}`
}

export default function OccupancyTab({ range }: { range: AnalyticsRange }) {
  const periods = periodsOf(range)
  // Fire getOccupancy once per period (slot 0 = current). Tables/lists use slot 0 only.
  const occResults = usePeriodResults<any>(
    api.analyticsAdmin.getOccupancy, periods, (p) => ({ from: p.from || undefined, to: p.to || undefined }),
  )
  const data = occResults[0]
  const weekly = useQuery(api.analyticsAdmin.getLaneWeekly, { from: range.from || undefined, to: range.to || undefined })
  const [hourMode, setHourMode] = useState<'all' | 'weekday' | 'weekend'>('all')
  if (data === undefined) return <Loading label="Loading occupancy…" />
  if (data === null) return <Empty label="Unavailable." />

  const comparing = range.compare && periods.length > 1
  const prev = comparing ? occResults[1] : undefined

  const maxLaneHours = data.lanes.reduce((m: number, l: any) => Math.max(m, l.hours), 0)
  const hourData = hourMode === 'weekday' ? data.byHourWeekday : hourMode === 'weekend' ? data.byHourWeekend : data.byHourOfDay
  const peakHour = hourData.reduce((mx: any, h: any) => (h.count > (mx?.count ?? 0) ? h : mx), null as any)

  // Overlay the daily-occupancy series one line per period, aligned by BUCKET INDEX
  // (position i in each period's `daily` array), coloured by PERIOD_COLORS.
  const dailyMaxLen = Math.max(0, ...occResults.map((r) => r?.daily?.length ?? 0))
  const dailyOverlay = Array.from({ length: dailyMaxLen }).map((_, i) => {
    const row: any = { idx: i + 1 }
    periods.forEach((p, pi) => {
      const d = occResults[pi]?.daily?.[i]
      row[p.label] = d ? d.occupancyPct : null
      row[`__date${pi}`] = d?.date ?? ''
    })
    return row
  })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {comparing ? (
          <>
            <DeltaKpi icon="📊" label="Overall occupancy" value={data.overallPct} prev={prev?.overallPct} format={(n) => `${Math.round(n)}%`} tone="emerald" />
            <DeltaKpi icon="⏱️" label="Booked lane-hours" value={data.totalBookedHours} prev={prev?.totalBookedHours} format={(n) => String(Math.round(n * 10) / 10)} />
            <DeltaKpi icon="🏟️" label="Open capacity" value={data.totalCapacityHours} prev={prev?.totalCapacityHours} format={(n) => `${Math.round(n)} hrs`} tone="blue" />
            <DeltaKpi icon="🔥" label="Peak bookings/hr" value={peakHour?.count ?? 0} prev={undefined} format={(n) => String(Math.round(n))} tone="amber" />
          </>
        ) : (
          <>
            <KpiCard icon="📊" label="Overall occupancy" value={`${data.overallPct}%`} sub="booked ÷ open lane-hours" tone="emerald" />
            <KpiCard icon="⏱️" label="Booked lane-hours" value={String(data.totalBookedHours)} />
            <KpiCard icon="🏟️" label="Open capacity" value={`${data.totalCapacityHours} hrs`} sub={`${data.laneCount} lanes`} tone="blue" />
            <KpiCard icon="🔥" label="Busiest hour" value={peakHour ? hourLabel(peakHour.hour) : '—'} sub={peakHour ? `${peakHour.count} bookings` : ''} tone="amber" />
          </>
        )}
      </div>

      <Section title="Daily occupancy"
        subtitle={comparing ? 'Occupancy % per day — one line per period, aligned by position' : 'Booked lane-hours ÷ open lane-hours per day'}>
        <div className="p-5">
          {comparing ? (
            dailyOverlay.length === 0 ? <Empty /> : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={dailyOverlay} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="idx" tick={{ fontSize: 11 }} label={{ value: 'day #', position: 'insideBottom', offset: -2, fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} width={32} tickFormatter={(v: number) => `${v}%`} domain={[0, 100]} />
                  <Tooltip formatter={(v: number, name: string) => [`${v}%`, name]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {periods.map((p, pi) => (
                    <Line key={p.label} type="monotone" dataKey={p.label} stroke={PERIOD_COLORS[pi]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )
          ) : data.daily.length === 0 ? <Empty /> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.daily} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} width={32} tickFormatter={(v: number) => `${v}%`} domain={[0, 100]} />
                <Tooltip formatter={(v: number, _n, p: any) => [`${v}% (${p.payload.bookedHours}/${p.payload.capacityHours} hrs)`, 'Occupancy']} />
                <Bar dataKey="occupancyPct" name="Occupancy" radius={[3, 3, 0, 0]}>
                  {data.daily.map((d: any, i: number) => (
                    <Cell key={i} fill={d.occupancyPct >= 80 ? '#dc2626' : d.occupancyPct >= 50 ? '#f59e0b' : '#10b981'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Hours by lane" subtitle="Total booked hours per physical lane">
          <div className="p-5 space-y-2">
            {data.lanes.map((l: any) => <BarRow key={l.laneId} label={l.name} value={l.hours} max={maxLaneHours} suffix=" hrs" color="bg-blue-500" />)}
          </div>
        </Section>
        <Section title="Peak booking times" subtitle="Scheduled-start distribution"
          action={
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              {(['all', 'weekday', 'weekend'] as const).map((m) => (
                <button key={m} onClick={() => setHourMode(m)}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold capitalize ${hourMode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{m}</button>
              ))}
            </div>
          }>
          <div className="p-5">
            {hourData.length === 0 ? <Empty /> : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={hourData.map((h: any) => ({ ...h, label: hourLabel(h.hour) }))} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={28} />
                  <Tooltip />
                  <Bar dataKey="count" name="Bookings" fill={hourMode === 'weekend' ? '#8b5cf6' : '#f59e0b'} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Section>
      </div>

      {/* Weekly lane utilisation — carpet-wear monitoring */}
      <WeeklyLaneUtil weekly={weekly} />

      {/* Cumulative carpet wear since last reset — not range-driven */}
      <LaneWearCumulative />
    </div>
  )
}

function WeeklyLaneUtil({ weekly }: { weekly: any }) {
  // Colour cell by hours intensity to spot heavily-used (wearing) lanes per week.
  const cellTone = (hrs: number, max: number) => {
    if (hrs === 0) return 'bg-gray-50 text-gray-300'
    const r = max > 0 ? hrs / max : 0
    if (r >= 0.8) return 'bg-red-500 text-white'
    if (r >= 0.6) return 'bg-orange-400 text-white'
    if (r >= 0.4) return 'bg-amber-300 text-amber-900'
    if (r >= 0.2) return 'bg-amber-100 text-amber-800'
    return 'bg-emerald-50 text-emerald-700'
  }
  const exportCsv = () => {
    if (!weekly) return
    const header = ['Week', ...weekly.laneNames, 'Total']
    const rows = weekly.series.map((w: any) => [w.label, ...weekly.laneIds.map((l: string) => w.lanes[l]), w.total])
    downloadCsv('lane_utilisation_weekly.csv', [header, ...rows])
  }
  const max = weekly ? weekly.series.reduce((m: number, w: any) => Math.max(m, ...weekly.laneIds.map((l: string) => w.lanes[l])), 0) : 0
  return (
    <Section title="Weekly lane utilisation (carpet wear)" subtitle="Booked hours per physical lane, week by week — scroll to monitor wear"
      action={<button onClick={exportCsv} disabled={!weekly || weekly.series.length === 0}
        className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">CSV</button>}>
      {weekly === undefined ? <Loading /> : weekly === null ? <Empty label="Unavailable." /> : weekly.series.length === 0 ? <Empty /> : (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-500 uppercase bg-gray-50 sticky left-0">Week of</th>
                {weekly.laneNames.map((n: string) => (
                  <th key={n} className="px-3 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">{n}</th>
                ))}
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold text-gray-700 uppercase">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {weekly.series.map((w: any) => (
                <tr key={w.weekKey}>
                  <td className="px-4 py-2 text-gray-700 whitespace-nowrap bg-white sticky left-0 font-medium">{w.label}</td>
                  {weekly.laneIds.map((l: string) => (
                    <td key={l} className="px-1.5 py-1.5 text-center">
                      <span className={`inline-block min-w-[44px] rounded px-2 py-1 text-xs font-semibold tabular-nums ${cellTone(w.lanes[l], max)}`}>
                        {w.lanes[l] > 0 ? w.lanes[l] : '·'}
                      </span>
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-bold text-gray-900 tabular-nums">{w.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

// Extend PERIOD_COLORS so each physical lane gets a distinct line even past 6 lanes.
const LANE_COLORS = [...PERIOD_COLORS, '#0ea5e9', '#d946ef', '#65a30d', '#e11d48', '#0891b2', '#7c3aed']

function LaneResetRow({ laneId, laneName, resetDate }: { laneId: string; laneName: string; resetDate: string | null }) {
  const reset = useMutation(api.mutations.resetLaneWear)
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const onReset = async () => {
    if (!date || busy) return
    setBusy(true)
    try {
      await reset({ laneId, resetDate: date })
      setDate('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-3 flex-wrap text-sm">
      <div className="w-28 shrink-0 font-medium text-gray-700 truncate">{laneName}</div>
      <div className="w-40 shrink-0 text-xs text-gray-400">
        {resetDate ? `since ${resetDate}` : 'all-time'}
      </div>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
        className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm" />
      <button onClick={onReset} disabled={!date || busy}
        className="px-2.5 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
        {busy ? 'Saving…' : 'Mark carpet replaced'}
      </button>
    </div>
  )
}

function LaneWearCumulative() {
  // Not range-driven: cumulative wear since each lane's last carpet reset.
  const data = useQuery(api.analyticsAdmin.getLaneWearCumulative, {})
  return (
    <Section title="Carpet wear (cumulative)"
      subtitle="Accumulated booked hours per lane since its last carpet reset — all-time, not affected by the range">
      {data === undefined ? <Loading label="Loading carpet wear…" /> : data === null ? <Empty label="Unavailable." /> : (
        <div className="p-5 space-y-5">
          {data.series.length === 0 ? <Empty /> : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data.series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} width={36} tickFormatter={(v: number) => `${v}h`} />
                <Tooltip formatter={(v: number, name: string) => [`${v} hrs`, name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {data.laneIds.map((lid: string, i: number) => (
                  <Line key={lid} type="monotone" dataKey={lid} name={data.laneNames[i]}
                    stroke={LANE_COLORS[i % LANE_COLORS.length]} strokeWidth={2} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}

          <div className="border-t border-gray-100 pt-4 space-y-2">
            <div className="text-[11px] font-semibold text-gray-500 uppercase">Carpet resets</div>
            {data.resets.map((r: any) => (
              <LaneResetRow key={r.laneId} laneId={r.laneId} laneName={r.laneName} resetDate={r.resetDate} />
            ))}
            <p className="text-xs text-gray-400 pt-1">
              Resetting zeroes a lane's wear total from that date (use when the carpet is replaced).
            </p>
          </div>
        </div>
      )}
    </Section>
  )
}
