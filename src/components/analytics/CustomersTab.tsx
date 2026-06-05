// SPEC_ANALYTICS_BUILD_2026-06 C2.6 — retention cohorts, customer LTV/value,
// referral attribution, discount-code performance.
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { type DateRange, KpiCard, Section, Loading, Empty, fmtMoney } from './shared'

function TopList({ title, rows, accent }: { title: string; rows: any[]; accent: 'emerald' | 'indigo' }) {
  const badge = accent === 'indigo' ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700'
  return (
    <div className="min-w-0">
      <div className="px-5 py-3 border-b border-gray-100"><h4 className="text-sm font-semibold text-gray-700">{title}</h4></div>
      {rows.length === 0 ? <div className="p-6 text-sm text-gray-400 italic">No bookings.</div> : (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-500 uppercase w-8">#</th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-500 uppercase">Customer</th>
              <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">Bookings</th>
              <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">Revenue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((c, i) => (
              <tr key={c.name + i} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                <td className="px-4 py-2 font-medium text-gray-900">{c.name}</td>
                <td className="px-4 py-2 text-right">
                  <span className={`inline-flex items-center justify-center ${badge} text-xs font-bold rounded-full min-w-7 h-7 px-2`}>{c.bookings}</span>
                </td>
                <td className="px-4 py-2 text-right font-medium text-gray-900">{fmtMoney(c.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function cohortColor(pct: number): string {
  if (pct >= 60) return 'bg-emerald-600 text-white'
  if (pct >= 40) return 'bg-emerald-400 text-white'
  if (pct >= 20) return 'bg-emerald-200 text-emerald-900'
  if (pct > 0) return 'bg-emerald-50 text-emerald-700'
  return 'bg-gray-50 text-gray-300'
}

export default function CustomersTab({ range }: { range: DateRange }) {
  const cohorts = useQuery(api.analyticsAdmin.getRetentionCohorts, { weeks: 8 })
  const value = useQuery(api.analyticsAdmin.getCustomerValue, { from: range.from || undefined, to: range.to || undefined, limit: 25 })
  const topcmp = useQuery(api.analyticsAdmin.getTopCustomersComparison, { limit: 10 })
  const referral = useQuery(api.analyticsAdmin.getReferralBreakdown, { from: range.from || undefined, to: range.to || undefined })
  const discount = useQuery(api.analyticsAdmin.getDiscountPerformance, { from: range.from || undefined, to: range.to || undefined })

  return (
    <div className="space-y-5">
      {/* LTV / value */}
      {value === undefined ? <Loading /> : value === null ? <Empty label="Unavailable." /> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KpiCard icon="👤" label="Unique customers" value={String(value.uniqueCustomers)} tone="blue" />
            <KpiCard icon="💎" label="Avg lifetime value" value={fmtMoney(value.avgLtv)} sub="revenue / customer" tone="emerald" />
            <KpiCard icon="🔁" label="Avg bookings / customer" value={String(value.avgBookingsPerCustomer)} />
            <KpiCard icon="🧾" label="Avg revenue / booking" value={fmtMoney(value.avgRevenuePerBooking)} />
          </div>

        </>
      )}

      {/* Top customers — this month vs all time, side by side (no email) */}
      <Section title="Top customers" subtitle="This month and all-time, ranked by bookings">
        {topcmp === undefined ? <Loading /> : topcmp === null ? <Empty label="Unavailable." /> : (
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-100">
            <TopList title={`This month (${topcmp.monthKey})`} rows={topcmp.thisMonth} accent="emerald" />
            <TopList title="All time" rows={topcmp.allTime} accent="indigo" />
          </div>
        )}
      </Section>

      {/* Retention cohorts */}
      <Section title="Weekly retention cohorts" subtitle="Of customers who first booked in a week, the % booking again in later weeks">
        {cohorts === undefined ? <Loading /> : cohorts === null ? <Empty label="Unavailable." /> : cohorts.cohorts.length === 0 ? <Empty /> : (
          <div className="overflow-x-auto p-3">
            <table className="text-xs border-separate" style={{ borderSpacing: 3 }}>
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left text-gray-500 font-semibold">Cohort</th>
                  <th className="px-2 py-1 text-right text-gray-500 font-semibold">Size</th>
                  {Array.from({ length: cohorts.maxOffsets }).map((_, i) => (
                    <th key={i} className="px-2 py-1 text-center text-gray-400 font-medium">W{i}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohorts.cohorts.map((c: any) => (
                  <tr key={c.cohortKey}>
                    <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{c.cohort}</td>
                    <td className="px-2 py-1 text-right text-gray-500">{c.size}</td>
                    {c.retention.map((pct: number, i: number) => (
                      <td key={i} className={`px-2 py-1 text-center rounded font-medium tabular-nums ${cohortColor(pct)}`}>{pct > 0 ? `${pct}%` : '·'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Referral attribution */}
        <Section title="How did you hear about us?" subtitle="Signup referral source">
          {referral === undefined ? <Loading /> : referral === null ? <Empty label="Unavailable." /> : referral.rows.length === 0 ? <Empty label="No referral data in range." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  {referral.rows.map((r: any) => (
                    <tr key={r.source} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-700">{r.source}</td>
                      <td className="px-4 py-2 text-right font-medium text-gray-900">{r.count}</td>
                    </tr>
                  ))}
                  {referral.unknown > 0 && (
                    <tr className="bg-amber-50/40"><td className="px-4 py-2 text-amber-700">Not specified</td><td className="px-4 py-2 text-right text-amber-700 font-medium">{referral.unknown}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Discount performance */}
        <Section title="Discount code performance" subtitle="Redemptions per code">
          {discount === undefined ? <Loading /> : discount === null ? <Empty label="Unavailable." /> : discount.rows.length === 0 ? <Empty label="No redemptions in range." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-500 uppercase">Code</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">Uses</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-500 uppercase">Customers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {discount.rows.map((r: any) => (
                    <tr key={r.code} className="hover:bg-gray-50">
                      <td className="px-4 py-2"><span className="font-mono font-semibold text-gray-800 uppercase">{r.code}</span><div className="text-[11px] text-gray-400">{r.label}</div></td>
                      <td className="px-4 py-2 text-right text-gray-800 font-medium">{r.redemptions}{r.usageLimit ? `/${r.usageLimit}` : ''}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{r.uniqueCustomers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
