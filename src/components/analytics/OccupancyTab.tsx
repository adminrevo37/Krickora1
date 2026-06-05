// SPEC_ANALYTICS_BUILD_2026-06 C2.6 — lane occupancy (booked hours ÷ open lane-hours).
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { type DateRange, KpiCard, Section, Loading, Empty, BarRow } from './shared'

const hourLabel = (h: number) => {
  const period = h >= 12 ? 'pm' : 'am'
  const disp = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${disp}${period}`
}

export default function OccupancyTab({ range }: { range: DateRange }) {
  const data = useQuery(api.analyticsAdmin.getOccupancy, { from: range.from || undefined, to: range.to || undefined })
  if (data === undefined) return <Loading label="Loading occupancy…" />
  if (data === null) return <Empty label="Unavailable." />

  const maxLaneHours = data.lanes.reduce((m: number, l: any) => Math.max(m, l.hours), 0)
  const peakHour = data.byHourOfDay.reduce((mx: any, h: any) => (h.count > (mx?.count ?? 0) ? h : mx), null as any)

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
        <Section title="Bookings by hour of day" subtitle="Scheduled-start distribution">
          <div className="p-5">
            {data.byHourOfDay.length === 0 ? <Empty /> : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data.byHourOfDay.map((h: any) => ({ ...h, label: hourLabel(h.hour) }))} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={28} />
                  <Tooltip />
                  <Bar dataKey="count" name="Bookings" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Section>
      </div>
    </div>
  )
}
