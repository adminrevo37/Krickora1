// SPEC_ANALYTICS_BUILD_2026-06 addendum — comparison overlays. Compare up to four
// day/week/month/custom ranges side by side: overlaid line chart (aligned by
// bucket index) + a comparison table, for revenue, bookings or hours.
import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { Section, Loading, Empty, downloadCsv, fmtMoney } from './shared'

type Gran = 'day' | 'week' | 'month'
type Metric = 'custRevenue' | 'bookings' | 'hours'
type Period = { id: number; label: string; from: string; to: string }

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6']

const keyToMs = (k: string) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, (m || 1) - 1, d || 1) }
const msToKey = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` }
const addDaysKey = (k: string, n: number) => msToKey(keyToMs(k) + n * 86400000)
const todayKey = () => msToKey(Date.UTC(new Date(Date.now() + 8 * 3600000).getUTCFullYear(), new Date(Date.now() + 8 * 3600000).getUTCMonth(), new Date(Date.now() + 8 * 3600000).getUTCDate()))
const mondayOf = (k: string) => { const ms = keyToMs(k); const dow = new Date(ms).getUTCDay(); return addDaysKey(k, -((dow + 6) % 7)) }
const monthStart = (k: string) => k.slice(0, 8) + '01'
const addMonthsKey = (k: string, n: number) => { const [y, m] = k.split('-').map(Number); const t = new Date(Date.UTC(y, (m - 1) + n, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-01` }
const monthEnd = (k: string) => { const [y, m] = k.split('-').map(Number); const t = new Date(Date.UTC(y, m, 0)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}` }

const METRIC_LABEL: Record<Metric, string> = { custRevenue: 'Customer revenue', bookings: 'Bookings', hours: 'Hours' }

export default function CompareTab() {
  const [gran, setGran] = useState<Gran>('day')
  const [metric, setMetric] = useState<Metric>('custRevenue')
  const [periods, setPeriods] = useState<Period[]>(() => {
    const t = todayKey(); const thisMon = mondayOf(t); const lastMon = addDaysKey(thisMon, -7)
    return [
      { id: 1, label: 'This week', from: thisMon, to: addDaysKey(thisMon, 6) },
      { id: 2, label: 'Last week', from: lastMon, to: addDaysKey(lastMon, 6) },
    ]
  })
  const [draft, setDraft] = useState({ from: todayKey(), to: todayKey() })

  // Up to 4 period slots — fixed, unconditional useQuery calls (skip empty slots).
  const argFor = (p?: Period) => (p ? { granularity: gran, from: p.from, to: p.to } : 'skip' as const)
  const s0 = useQuery(api.analyticsAdmin.getBookingRevenueSeries, argFor(periods[0]))
  const s1 = useQuery(api.analyticsAdmin.getBookingRevenueSeries, argFor(periods[1]))
  const s2 = useQuery(api.analyticsAdmin.getBookingRevenueSeries, argFor(periods[2]))
  const s3 = useQuery(api.analyticsAdmin.getBookingRevenueSeries, argFor(periods[3]))
  const seriesByIdx = [s0, s1, s2, s3]

  const presets = (kind: 'weeks' | 'months' | 'years') => {
    const t = todayKey()
    if (kind === 'weeks') {
      const m = mondayOf(t)
      setGran('day')
      setPeriods([
        { id: 1, label: 'This week', from: m, to: addDaysKey(m, 6) },
        { id: 2, label: 'Last week', from: addDaysKey(m, -7), to: addDaysKey(m, -1) },
        { id: 3, label: '2 weeks ago', from: addDaysKey(m, -14), to: addDaysKey(m, -8) },
      ])
    } else if (kind === 'months') {
      const ms = monthStart(t)
      setGran('day')
      setPeriods([
        { id: 1, label: 'This month', from: ms, to: monthEnd(ms) },
        { id: 2, label: 'Last month', from: addMonthsKey(ms, -1), to: monthEnd(addMonthsKey(ms, -1)) },
      ])
    } else {
      const y = Number(t.slice(0, 4))
      setGran('month')
      setPeriods([
        { id: 1, label: `${y}`, from: `${y}-01-01`, to: `${y}-12-31` },
        { id: 2, label: `${y - 1}`, from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
      ])
    }
  }

  const addPeriod = () => {
    if (periods.length >= 4) return
    setPeriods([...periods, { id: Date.now(), label: `${draft.from}→${draft.to}`, from: draft.from, to: draft.to }])
  }
  const removePeriod = (id: number) => setPeriods(periods.filter((p) => p.id !== id))

  // Align by bucket index.
  const maxLen = Math.max(0, ...seriesByIdx.map((s) => s?.series?.length ?? 0))
  const chartData = Array.from({ length: maxLen }).map((_, i) => {
    const row: any = { idx: i + 1 }
    periods.forEach((p, pi) => {
      const v = seriesByIdx[pi]?.series?.[i]
      row[p.label] = v ? v[metric] : null
      row[`__label${pi}`] = v?.label ?? ''
    })
    return row
  })

  const totals = periods.map((p, pi) => {
    const ser = seriesByIdx[pi]?.series ?? []
    return ser.reduce((s: number, b: any) => s + (b[metric] ?? 0), 0)
  })

  const exportCsv = () => {
    const header = ['Bucket', ...periods.map((p) => p.label)]
    const rows = chartData.map((r) => [r.idx, ...periods.map((p) => r[p.label] ?? '')])
    rows.push(['TOTAL', ...totals.map((t) => Math.round(t * 100) / 100)])
    downloadCsv(`compare_${metric}_${gran}.csv`, [header, ...rows])
  }

  const anyLoading = periods.some((_, i) => seriesByIdx[i] === undefined)
  const fmtVal = (v: number) => (metric === 'custRevenue' ? fmtMoney(v) : String(Math.round(v * 10) / 10))

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap">
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            {(['day', 'week', 'month'] as Gran[]).map((g) => (
              <button key={g} onClick={() => setGran(g)} className={`px-3 py-1.5 rounded-lg text-sm font-semibold capitalize ${gran === g ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{g}</button>
            ))}
          </div>
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            {(['custRevenue', 'bookings', 'hours'] as Metric[]).map((m) => (
              <button key={m} onClick={() => setMetric(m)} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${metric === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{METRIC_LABEL[m]}</button>
            ))}
          </div>
        </div>
        <div className="flex gap-2 text-xs">
          <button onClick={() => presets('weeks')} className="px-2.5 py-1.5 border border-gray-200 rounded-lg font-medium text-gray-600 hover:bg-gray-50">Weeks</button>
          <button onClick={() => presets('months')} className="px-2.5 py-1.5 border border-gray-200 rounded-lg font-medium text-gray-600 hover:bg-gray-50">Months</button>
          <button onClick={() => presets('years')} className="px-2.5 py-1.5 border border-gray-200 rounded-lg font-medium text-gray-600 hover:bg-gray-50">Years</button>
        </div>
      </div>

      {/* Period chips + add custom */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {periods.map((p, pi) => (
            <span key={p.id} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm" style={{ background: COLORS[pi] + '22', color: COLORS[pi] }}>
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: COLORS[pi] }} />
              {p.label} <span className="text-[11px] opacity-70">({totals[pi] !== undefined ? fmtVal(totals[pi]) : '…'})</span>
              <button onClick={() => removePeriod(p.id)} className="text-gray-400 hover:text-red-500">✕</button>
            </span>
          ))}
        </div>
        {periods.length < 4 && (
          <div className="flex items-end gap-2 flex-wrap">
            <label className="text-xs text-gray-500">From<input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className="block mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm" /></label>
            <label className="text-xs text-gray-500">To<input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className="block mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm" /></label>
            <button onClick={addPeriod} className="px-3 py-1.5 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-700">+ Add period</button>
          </div>
        )}
      </div>

      <Section title={`Comparison — ${METRIC_LABEL[metric]}`} subtitle={`Overlaid by ${gran} (aligned by position in each period)`}
        action={<button onClick={exportCsv} disabled={chartData.length === 0} className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">CSV</button>}>
        <div className="p-5">
          {anyLoading ? <Loading /> : chartData.length === 0 ? <Empty label="No data for the selected periods." /> : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="idx" tick={{ fontSize: 11 }} label={{ value: gran === 'day' ? 'day #' : gran === 'week' ? 'week #' : 'month #', position: 'insideBottom', offset: -2, fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (metric === 'custRevenue' ? `$${v}` : String(v))} width={48} />
                <Tooltip formatter={(v: number, name: string) => [metric === 'custRevenue' ? `$${v}` : v, name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {periods.map((p, pi) => (
                  <Line key={p.id} type="monotone" dataKey={p.label} stroke={COLORS[pi]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </Section>

      {/* Comparison table */}
      <Section title="Comparison table" subtitle="Each period's value per aligned bucket">
        {chartData.length === 0 ? <Empty /> : (
          <div className="overflow-x-auto max-h-[420px]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                <tr>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-500 uppercase">#</th>
                  {periods.map((p, pi) => <th key={p.id} className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase" style={{ color: COLORS[pi] }}>{p.label}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {chartData.map((r) => (
                  <tr key={r.idx} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-500">{r.idx}</td>
                    {periods.map((p) => <td key={p.id} className="px-4 py-2 text-right text-gray-800">{r[p.label] != null ? fmtVal(r[p.label]) : '—'}</td>)}
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 border-t border-gray-200">
                <tr>
                  <td className="px-4 py-2.5 font-semibold text-gray-700">Total</td>
                  {totals.map((t, i) => <td key={i} className="px-4 py-2.5 text-right font-bold text-gray-900">{fmtVal(t)}</td>)}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}
