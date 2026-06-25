// SPEC_MACHINE_USAGE_AUDIT_KRICKORA_2026-06 (Phase 2) — admin "Machine Utilisation"
// view: each booking's ACTUAL bowling-machine-use minutes (motor running) vs the
// booked duration, pushed by Home Assistant. Range-driven (by booking date), with
// a per-lane filter, summary KPIs, a per-customer roll-up and CSV export. Low
// utilisation (<40%) and over-use (>100%) are flagged. Source:
// convex/machineUsage.getMachineUtilisation.
import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { type AnalyticsRange, KpiCard, Section, Loading, Empty, downloadCsv, fmtMins } from './shared'

type Row = {
  id: string
  at: number
  date: string
  startHour: number | null
  lane: number
  laneId: string
  laneName: string
  customer: string
  email: string | null
  bookedMinutes: number
  usedMinutes: number
  utilPct: number
  matchStatus: string
  bookingId: string | null
}
type ByCustomer = {
  customer: string
  email: string | null
  sessions: number
  totalBooked: number
  totalUsed: number
  avgUtilPct: number
}
type Data = {
  rows: Row[]
  summary: {
    sessions: number
    totalBooked: number
    totalUsed: number
    avgUtilPct: number
    lowUtilCount: number
    overUseCount: number
    unmatchedCount: number
  }
  byCustomer: ByCustomer[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "23 Jun · 5:00pm" from an AWST date string + decimal hour.
function fmtWhen(date: string, hour: number | null): string {
  const parts = date.split('-')
  const d = parts.length === 3 ? `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1] ?? '?'}` : date
  if (hour == null) return d
  const h = Math.floor(hour)
  const m = Math.round((hour - h) * 60)
  const h12 = h % 12 || 12
  return `${d} · ${h12}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`
}

// Utilisation colour: low (<40%) red, over-use (>100%) amber, otherwise emerald.
function utilTone(p: number): string {
  if (p > 100) return 'text-amber-600'
  if (p < 40) return 'text-red-600'
  return 'text-emerald-600'
}

const MATCH_META: Record<string, { label: string; cls: string }> = {
  matched: { label: 'Matched', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  ambiguous: { label: 'Review', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  unmatched: { label: 'No match', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
}

const LANE_FILTERS: { id: number | null; label: string }[] = [
  { id: null, label: 'All lanes' },
  { id: 1, label: 'BM 1' },
  { id: 2, label: 'BM 2' },
  { id: 3, label: 'BM 3' },
]

export default function MachineUsageTab({ range }: { range: AnalyticsRange }) {
  const [lane, setLane] = useState<number | null>(null)
  const data = useQuery(api.machineUsage.getMachineUtilisation, {
    from: range.from || undefined,
    to: range.to || undefined,
    lane: lane ?? undefined,
  }) as Data | null | undefined

  if (data === undefined) return <Loading label="Loading machine usage…" />
  if (data === null) return <Empty label="Unavailable." />

  const { rows, summary, byCustomer } = data

  const exportCsv = () => {
    const header = ['Date', 'Time', 'Lane', 'Customer', 'Email', 'Booked (min)', 'Used (min)', 'Util %', 'Match']
    const body = rows.map((r) => [
      r.date,
      r.startHour != null ? fmtWhen(r.date, r.startHour).split('· ')[1] ?? '' : '',
      r.laneName,
      r.customer,
      r.email ?? '',
      r.bookedMinutes,
      r.usedMinutes,
      r.utilPct,
      r.matchStatus,
    ])
    downloadCsv(`machine-utilisation_${range.from}_${range.to}.csv`, [header, ...body])
  }

  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon="⚙️" label="Sessions" value={String(summary.sessions)} />
        <KpiCard
          icon="📊"
          label="Avg utilisation"
          value={`${summary.avgUtilPct}%`}
          valueColor={utilTone(summary.avgUtilPct)}
          sub="actual machine-use vs booked"
        />
        <KpiCard
          icon="⏱️"
          label="Machine-minutes used"
          value={fmtMins(summary.totalUsed)}
          sub={`of ${fmtMins(summary.totalBooked)} booked`}
        />
        <KpiCard
          icon="⚠️"
          label="Flagged"
          value={`${summary.lowUtilCount} low · ${summary.overUseCount} over`}
          sub={summary.unmatchedCount ? `${summary.unmatchedCount} unmatched` : 'all matched'}
          tone={summary.lowUtilCount || summary.overUseCount ? 'amber' : undefined}
        />
      </div>

      {/* Records table */}
      <Section
        title="Machine utilisation by session"
        subtitle="Actual machine-use minutes (motor running) vs booked duration, newest first."
        action={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex gap-1">
              {LANE_FILTERS.map((f) => (
                <button
                  key={String(f.id)}
                  onClick={() => setLane(f.id)}
                  className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                    lane === f.id ? 'bg-gray-900 text-white border-gray-900' : 'text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              onClick={exportCsv}
              disabled={rows.length === 0}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              ⬇ CSV
            </button>
          </div>
        }
      >
        {rows.length === 0 ? (
          <Empty label="No machine-usage records for this range yet. HA streams one per bowling-machine booking once the /ha/usage webhook is wired." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                  <th className="px-6 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Lane</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium text-right">Booked</th>
                  <th className="px-3 py-2 font-medium text-right">Used</th>
                  <th className="px-3 py-2 font-medium text-right">Util</th>
                  <th className="px-3 py-2 font-medium">Match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => {
                  const mm = MATCH_META[r.matchStatus] ?? MATCH_META.unmatched
                  return (
                    <tr key={r.id} className="hover:bg-gray-50/60">
                      <td className="px-6 py-2 text-gray-500 whitespace-nowrap tabular-nums">
                        {fmtWhen(r.date, r.startHour)}
                      </td>
                      <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{r.laneName}</td>
                      <td className="px-3 py-2 text-gray-800 truncate max-w-[14rem]">
                        {r.customer || <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{fmtMins(r.bookedMinutes)}</td>
                      <td className="px-3 py-2 text-right text-gray-800 tabular-nums">{fmtMins(r.usedMinutes)}</td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${utilTone(r.utilPct)}`}>
                        {r.utilPct}%
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${mm.cls}`}>
                          {mm.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Per-customer roll-up */}
      {byCustomer.length > 0 && (
        <Section title="By customer" subtitle="Total machine-minutes and average utilisation per customer in this range.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                  <th className="px-6 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium text-right">Sessions</th>
                  <th className="px-3 py-2 font-medium text-right">Booked</th>
                  <th className="px-3 py-2 font-medium text-right">Used</th>
                  <th className="px-3 py-2 font-medium text-right">Avg util</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {byCustomer.map((c, i) => (
                  <tr key={`${c.email ?? c.customer}-${i}`} className="hover:bg-gray-50/60">
                    <td className="px-6 py-2 text-gray-800 truncate max-w-[18rem]">{c.customer}</td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{c.sessions}</td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{fmtMins(c.totalBooked)}</td>
                    <td className="px-3 py-2 text-right text-gray-800 tabular-nums">{fmtMins(c.totalUsed)}</td>
                    <td className={`px-3 py-2 text-right font-semibold tabular-nums ${utilTone(c.avgUtilPct)}`}>
                      {c.avgUtilPct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  )
}
