// SPEC_ANALYTICS_BUILD_2026-06 C2.5 — booking-flow funnel: per-step conversion,
// drop-off, median time-in-step, time-to-book, checkout abandon rate.
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { type DateRange, KpiCard, Section, Loading, Empty, fmtMins } from './shared'

export default function FunnelTab({ range }: { range: DateRange }) {
  const data = useQuery(api.analyticsUsage.getBookingFunnel, { from: range.from || undefined, to: range.to || undefined })
  if (data === undefined) return <Loading label="Loading funnel…" />
  if (data === null) return <Empty label="Unavailable." />

  const ladder = data.ladder ?? []
  const topCount = ladder[0]?.count ?? 0

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard icon="🧭" label="Calendar sessions" value={String(data.calendarOpens)} sub="top of funnel" tone="blue" />
        <KpiCard icon="🛒" label="Booking attempts" value={String(data.totalFlows)} sub="slot selected" />
        <KpiCard icon="✅" label="Slot→book conversion" value={`${data.conversionPct}%`} tone="emerald" />
        <KpiCard icon="🏁" label="Median time to book" value={fmtMins(data.medianTimeToBookSec / 60)} sub={`avg ${fmtMins(data.avgTimeToBookSec / 60)}`} />
      </div>

      <Section title="Conversion ladder" subtitle="Distinct booking attempts reaching each step (a fresh attempt begins at slot select)">
        {ladder.length === 0 || topCount === 0 ? (
          <Empty label="No booking-flow events tracked yet (begins collecting once live)." />
        ) : (
          <div className="p-5 space-y-3">
            {ladder.map((s: any, i: number) => (
              <div key={s.step} className="flex items-center gap-3">
                <div className="w-44 shrink-0 text-sm text-gray-700">{s.label}</div>
                <div className="flex-1 h-7 rounded-lg bg-gray-100 overflow-hidden relative">
                  <div className="h-full bg-gradient-to-r from-emerald-500 to-green-500 flex items-center"
                    style={{ width: `${s.pctOfTop}%` }}>
                    <span className="text-xs font-semibold text-white px-2 whitespace-nowrap">{s.count}</span>
                  </div>
                </div>
                <div className="w-28 text-right text-xs text-gray-500">
                  {i === 0 ? '—' : <>{s.pctOfPrev}% of prev{s.dropFromPrev > 0 ? ` · −${s.dropFromPrev}` : ''}</>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Time in step" subtitle="Median seconds between consecutive steps">
          {(data.transitions ?? []).length === 0 ? <Empty /> : (
            <div className="p-5 space-y-2">
              {data.transitions.map((t: any) => (
                <div key={t.transition} className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 truncate">{t.transition.replace(/_/g, ' ')}</span>
                  <span className="font-medium text-gray-900 tabular-nums">{t.medianSec}s <span className="text-gray-400 font-normal">({t.samples})</span></span>
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section title="Engagement & drop-off">
          <div className="p-5 grid grid-cols-2 gap-4">
            <KpiCard label="Chose a machine type" value={String(data.variantChosen)} />
            <KpiCard label="Changed duration" value={String(data.durationChosen)} />
            <KpiCard label="Checkout abandon rate" value={`${data.checkoutAbandonRatePct}%`} sub="redirected, never confirmed" tone="red" />
            <KpiCard label="Abandoned in-app" value={String(data.abandoned)} sub="closed before paying" tone="amber" />
          </div>
        </Section>
      </div>
    </div>
  )
}
