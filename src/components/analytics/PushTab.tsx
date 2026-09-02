// SPEC_ANALYTICS_BUILD_2026-06 C2.4 — push delivery/CTR by category + platform +
// opt-in rate, plus waitlist-offer response analytics (time-to-accept/reject and
// the share who never press a button).
import { useMemo, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import {
  type AnalyticsRange, KpiCard, DeltaKpi, Section, Loading, Empty, fmtMins,
  periodsOf, usePeriodResults, downloadCsv,
} from './shared'

const fmtHour = (h: number) => {
  const hr = Math.floor(h)
  const min = Math.round((h - hr) * 60)
  const period = hr >= 12 ? 'pm' : 'am'
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr
  return min ? `${display}:${String(min).padStart(2, '0')}${period}` : `${display}${period}`
}
const POOL_LABEL: Record<string, string> = { bm: 'BM', ru: 'RU', any: 'Any' }
// Columns Mon..Sun (dow 1..6, then 0).
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part C1 — demand the facility failed to
// serve, by weekday × hour. Keyed on the SESSION date, so "Tuesday 7pm was
// waitlisted 40× this quarter" is exactly what it says.
function WaitlistDemand({ range }: { range: AnalyticsRange }) {
  const cur = periodsOf(range)[0]
  const d = useQuery(api.analyticsUsage.getWaitlistDemand, {
    from: cur.from || undefined, to: cur.to || undefined, fromMs: cur.fromMs, toMs: cur.toMs,
  })
  const [pool, setPool] = useState<'all' | 'bm' | 'ru'>('all')

  const heat = useMemo(() => {
    if (!d) return null
    const cells = d.cells.filter((c: any) => pool === 'all' || c.pool === pool)
    const grid = new Map<string, number>()
    const hours = new Set<number>()
    let max = 0
    for (const c of cells) {
      const k = `${c.dow}|${c.hour}`
      const n = (grid.get(k) ?? 0) + c.entries
      grid.set(k, n)
      hours.add(c.hour)
      if (n > max) max = n
    }
    return { grid, hours: [...hours].sort((a, b) => a - b), max }
  }, [d, pool])

  const exportCsv = () => {
    if (!d) return
    downloadCsv(`waitlist-demand-${cur.from || 'all'}-${cur.to || 'all'}.csv`, [
      ['Weekday', 'Hour', 'Pool', 'Entries', 'Unique customers', 'Distinct dates'],
      ...d.cells.map((c: any) => [c.dowLabel, fmtHour(c.hour), POOL_LABEL[c.pool] ?? c.pool, c.entries, c.customers, c.dates]),
    ])
  }

  return (
    <Section
      title="Waitlist demand"
      subtitle="Sessions people wanted and couldn't get — by weekday and hour. The only record of demand the facility failed to serve."
      action={d && d.total > 0 ? (
        <button onClick={exportCsv} className="text-xs font-semibold text-gray-600 hover:text-gray-900 px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200">Export CSV</button>
      ) : undefined}
    >
      {d === undefined ? <Loading /> : d === null ? <Empty label="Unavailable." /> : d.total === 0 ? (
        <Empty label="No waitlist entries for sessions in range." />
      ) : (
        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KpiCard icon="🎟️" label="Waitlist entries" value={String(d.total)} sub={`${d.uniqueCustomers} customers · BM ${d.byPool.bm} / RU ${d.byPool.ru}${d.byPool.any ? ` / any ${d.byPool.any}` : ''}`} tone="blue" />
            <KpiCard icon="✅" label="Got a slot" value={String(d.outcomes.booked)} sub={`${d.servedPct}% of entries booked via an offer`} tone="emerald" />
            <KpiCard icon="🚫" label="Never offered" value={String(d.outcomes.neverOffered)} sub={`${d.neverOfferedPct}% — no lane ever freed for them`} tone="red" />
            <KpiCard icon="⏳" label="Offered, not taken" value={String(d.outcomes.offeredLost)} sub={`${d.outcomes.open} still open`} tone="amber" />
          </div>

          {/* Heatmap weekday × hour */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
              <p className="text-sm font-semibold text-gray-700">Demand by weekday × hour</p>
              <div className="flex gap-1">
                {(['all', 'bm', 'ru'] as const).map((p) => (
                  <button key={p} onClick={() => setPool(p)}
                    className={`text-xs px-2.5 py-1 rounded-lg font-semibold ${pool === p ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    {p === 'all' ? 'All' : p.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            {heat && heat.hours.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="text-xs border-separate border-spacing-0.5">
                  <thead>
                    <tr>
                      <th className="text-left text-[11px] font-semibold text-gray-500 pr-2 py-1">Hour</th>
                      {DOW_ORDER.map((dw) => <th key={dw} className="text-[11px] font-semibold text-gray-500 px-1 py-1 w-12 text-center">{DOW_SHORT[dw]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {heat.hours.map((h) => (
                      <tr key={h}>
                        <td className="text-gray-600 pr-2 whitespace-nowrap">{fmtHour(h)}</td>
                        {DOW_ORDER.map((dw) => {
                          const n = heat.grid.get(`${dw}|${h}`) ?? 0
                          const a = heat.max > 0 ? n / heat.max : 0
                          return (
                            <td key={dw} title={`${DOW_SHORT[dw]} ${fmtHour(h)}: ${n} entries`}
                              className="text-center rounded font-medium h-7 w-12"
                              style={{ backgroundColor: n === 0 ? '#f9fafb' : `rgba(16,185,129,${0.15 + 0.75 * a})`, color: a > 0.55 ? '#fff' : '#1f2937' }}>
                              {n || ''}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty label="No entries for this pool in range." />}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Most-waitlisted recurring slots</p>
              <div className="overflow-x-auto rounded-xl border border-gray-100">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-500 uppercase">Slot</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold text-gray-500 uppercase">Entries</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold text-gray-500 uppercase">People</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold text-gray-500 uppercase">Dates</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {d.topRecurring.map((c: any) => (
                      <tr key={`${c.dow}|${c.hour}|${c.pool}`}>
                        <td className="px-3 py-1.5 text-gray-700">{c.dowLabel} {fmtHour(c.hour)} <span className="text-gray-400">· {POOL_LABEL[c.pool] ?? c.pool}</span></td>
                        <td className="px-3 py-1.5 text-right font-medium text-gray-800">{c.entries}</td>
                        <td className="px-3 py-1.5 text-right text-gray-500">{c.customers}</td>
                        <td className="px-3 py-1.5 text-right text-gray-500">{c.dates}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Busiest specific sessions</p>
              <div className="overflow-x-auto rounded-xl border border-gray-100">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-500 uppercase">Session</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold text-gray-500 uppercase">Entries</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold text-gray-500 uppercase">People</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {d.topSessions.map((s: any) => (
                      <tr key={`${s.date}|${s.hour}|${s.pool}`}>
                        <td className="px-3 py-1.5 text-gray-700">{s.dowLabel} {s.date} {fmtHour(s.hour)} <span className="text-gray-400">· {POOL_LABEL[s.pool] ?? s.pool}</span></td>
                        <td className="px-3 py-1.5 text-right font-medium text-gray-800">{s.entries}</td>
                        <td className="px-3 py-1.5 text-right text-gray-500">{s.customers}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <p className="text-[11px] text-gray-400">
            Counted by the session date, not when the person joined. "Never offered" = the entry expired without a lane ever freeing for them; "Offered, not taken" = an offer lapsed or was declined.
          </p>
        </div>
      )}
    </Section>
  )
}

export default function PushTab({ range }: { range: AnalyticsRange }) {
  // Comparison fans the push KPIs (DeltaKpi vs prev period); the by-category +
  // by-platform tables and the waitlist panel always reflect ONLY the current
  // (most-recent) period.
  const periods = periodsOf(range)
  const pushResults = usePeriodResults(
    api.analyticsUsage.getPushAnalytics,
    periods,
    (p) => ({ from: p.from || undefined, to: p.to || undefined, fromMs: p.fromMs, toMs: p.toMs }),
  )
  const push = pushResults[0]
  const pushPrev = pushResults[1]
  const cur = periods[0]
  const wl = useQuery(api.analyticsUsage.getWaitlistAnalytics, {
    from: cur.from || undefined, to: cur.to || undefined, fromMs: cur.fromMs, toMs: cur.toMs,
  })

  return (
    <div className="space-y-5">
      {push === undefined ? <Loading label="Loading push…" /> : push === null ? <Empty label="Unavailable." /> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {range.compare ? (
              <>
                <DeltaKpi icon="📤" label="Notifications sent" value={push.totals.sent} prev={pushPrev?.totals.sent} format={(n) => String(n)} tone="blue" />
                <DeltaKpi icon="📥" label="Delivery rate" value={push.deliveryRatePct} prev={pushPrev?.deliveryRatePct} format={(n) => `${n}%`} tone="emerald" />
                <DeltaKpi icon="👆" label="Click-through" value={push.ctrPct} prev={pushPrev?.ctrPct} format={(n) => `${n}%`} tone="amber" />
                <DeltaKpi icon="🔔" label="Opt-in rate" value={push.optInRatePct} prev={pushPrev?.optInRatePct} format={(n) => `${n}%`} tone="violet" />
              </>
            ) : (
              <>
                <KpiCard icon="📤" label="Notifications sent" value={String(push.totals.sent)} sub={`${push.totals.failed} failed · ${push.totals.pruned} pruned`} tone="blue" />
                <KpiCard icon="📥" label="Delivery rate" value={`${push.deliveryRatePct}%`} sub={`${push.totals.delivered} delivered`} tone="emerald" />
                <KpiCard icon="👆" label="Click-through" value={`${push.ctrPct}%`} sub={`${push.totals.clicked} clicked`} tone="amber" />
                <KpiCard icon="🔔" label="Opt-in rate" value={`${push.optInRatePct}%`} sub={`${push.subscribedAccounts}/${push.activeCustomers} accounts · ${push.subscribedDevices} devices`} tone="violet" />
              </>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="By category" subtitle="Sends, delivery and CTR per notification type">
              {push.byCategory.length === 0 ? <Empty label="No sends in range." /> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-500 uppercase">Category</th>
                        <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">Sent</th>
                        <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">Deliv.</th>
                        <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">CTR</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {push.byCategory.map((c: any) => (
                        <tr key={c.category}>
                          <td className="px-4 py-2 text-gray-700">{c.category}</td>
                          <td className="px-4 py-2 text-right text-gray-800 font-medium">{c.sent}</td>
                          <td className="px-4 py-2 text-right text-gray-500">{c.deliveryPct}%</td>
                          <td className="px-4 py-2 text-right text-gray-500">{c.ctrPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
            <Section title="By platform" subtitle="iOS / Android (fcm) / Firefox / Windows">
              {push.byPlatform.length === 0 ? <Empty label="No sends in range." /> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-500 uppercase">Platform</th>
                        <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">Sent</th>
                        <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">Deliv.</th>
                        <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">CTR</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {push.byPlatform.map((p: any) => (
                        <tr key={p.platform}>
                          <td className="px-4 py-2 text-gray-700 uppercase">{p.platform}</td>
                          <td className="px-4 py-2 text-right text-gray-800 font-medium">{p.sent}</td>
                          <td className="px-4 py-2 text-right text-gray-500">{p.deliveryPct}%</td>
                          <td className="px-4 py-2 text-right text-gray-500">{p.ctrPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </div>
          <p className="text-[11px] text-gray-400">
            Delivery/CTR rely on a service-worker beacon. iOS Safari can throttle background SW work, so iOS delivery may read low — treat as a floor.
          </p>
        </>
      )}

      {/* SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part C1 — demand */}
      <WaitlistDemand range={range} />

      {/* Waitlist offer response analytics — current period only */}
      <Section title="Waitlist offer responses" subtitle="How fast people accept/decline a waitlist offer — and how many never press a button">
        {wl === undefined ? <Loading /> : wl === null ? <Empty label="Unavailable." /> : wl.offered === 0 ? (
          <Empty label="No waitlist offers made in range." />
        ) : (
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <KpiCard label="Offers made" value={String(wl.offered)} tone="blue" />
              <KpiCard label="Accepted" value={`${wl.accepted}`} sub={`${wl.conversionPct}% conversion`} tone="emerald" />
              <KpiCard label="Declined" value={`${wl.declined}`} sub={`${wl.declineRatePct}% of offers`} tone="amber" />
              <KpiCard label="No action" value={`${wl.expired}`} sub={`${wl.noActionPct}% never pressed a button`} tone="red" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <KpiCard label="Median time to accept" value={fmtMins(wl.medianAcceptMin)} sub={`avg ${fmtMins(wl.avgAcceptMin)}`} />
              <KpiCard label="Median time to decline" value={fmtMins(wl.medianDeclineMin)} sub={`avg ${fmtMins(wl.avgDeclineMin)}`} />
              <KpiCard label="Response rate" value={`${wl.responseRatePct}%`} sub={`${wl.responses} of ${wl.offered} acted`} />
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}
