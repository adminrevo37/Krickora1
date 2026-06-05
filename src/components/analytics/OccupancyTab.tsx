// SPEC_ANALYTICS_BUILD_2026-06 C2.6 — lane occupancy (booked hours ÷ open lane-hours).
import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { type DateRange, KpiCard, Section, Loading, Empty, BarRow, downloadCsv } from './shared'

const hourLabel = (h: number) => {
  const period = h >= 12 ? 'pm' : 'am'
  const disp = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${disp}${period}`
}

export default function OccupancyTab({ range }: { range: DateRange }) {
  const data = useQuery(api.analyticsAdmin.getOccupancy, { from: range.from || undefined, to: range.to || undefined })
  const weekly = useQuery(api.analyticsAdmin.getLaneWeekly, { from: range.from || undefined, to: range.to || undefined })
  const [hourMode, setHourMode] = useState<'all' | 'weekday' | 'weekend'>('all')
  if (data === undefined) return <Loading label="Loading occupancy…" />
  if (data === null) return <Empty label="Unavailable." />

  const maxLaneHours = data.lanes.reduce((m: number, l: any) => Math.max(m, l.hours), 0)
  const hourData = hourMode === 'weekday' ? data.byHourWeekday : hourMode === 'weekend' ? data.byHourWeekend : data.byHourOfDay
  const peakHour = hourData.reduce((mx: any, h: any) => (h.count > (mx?.count ?? 0) ? h : mx), null as any)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard icon="📊" label="Overall occupancy" value={`${data.overallPct}%`} sub="booked ÷ open lane-hours" tone="emerald" />
        <KpiCard icon="⏱️" label="Booked lane-hours" value={String(data.totalBookedHours)} />
        <KpiCard icon="🏟️" label="Open capacity" value={`${data.totalCapacityHours} hrs`} sub={`${data.laneCount} lanes`} tone="blue" />
        <KpiCard icon="🔥" label="Busiest hour" value={peakHour ? hourLabel(peakHour.hour) : '—'} sub={peakHour ? `${peakHour.count} bookings` : ''} tone="amber" />
      </div>

      <Section title="Daily occupancy" subtitle="Booked lane-hours ÷ open lane-hours per day">
        <div className="p-5">
          {data.daily.length === 0 ? <Empty /> : (
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
