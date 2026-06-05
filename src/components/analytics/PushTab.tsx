// SPEC_ANALYTICS_BUILD_2026-06 C2.4 — push delivery/CTR by category + platform +
// opt-in rate, plus waitlist-offer response analytics (time-to-accept/reject and
// the share who never press a button).
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { type DateRange, KpiCard, Section, Loading, Empty, fmtMins } from './shared'

export default function PushTab({ range }: { range: DateRange }) {
  const push = useQuery(api.analyticsUsage.getPushAnalytics, { from: range.from || undefined, to: range.to || undefined })
  const wl = useQuery(api.analyticsUsage.getWaitlistAnalytics, { from: range.from || undefined, to: range.to || undefined })

  return (
    <div className="space-y-5">
      {push === undefined ? <Loading label="Loading push…" /> : push === null ? <Empty label="Unavailable." /> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KpiCard icon="📤" label="Notifications sent" value={String(push.totals.sent)} sub={`${push.totals.failed} failed · ${push.totals.pruned} pruned`} tone="blue" />
            <KpiCard icon="📥" label="Delivery rate" value={`${push.deliveryRatePct}%`} sub={`${push.totals.delivered} delivered`} tone="emerald" />
            <KpiCard icon="👆" label="Click-through" value={`${push.ctrPct}%`} sub={`${push.totals.clicked} clicked`} tone="amber" />
            <KpiCard icon="🔔" label="Opt-in rate" value={`${push.optInRatePct}%`} sub={`${push.subscribedAccounts}/${push.activeCustomers} accounts · ${push.subscribedDevices} devices`} tone="violet" />
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

      {/* Waitlist offer response analytics */}
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
