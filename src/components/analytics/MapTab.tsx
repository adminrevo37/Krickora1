// SPEC_ANALYTICS_BUILD_2026-06 addendum — OpenStreetMap suburb maps. Two maps:
//  1. Catchment heatmap (USAGE) — unique customers per suburb from confirmed
//     bookings (getCatchmentReport), respects the dashboard date range.
//  2. All customers by registered suburb (FULL DATABASE) — every customer account
//     plotted by the suburb on their profile, independent of bookings + no date
//     window (getCustomerSuburbMap). The registration footprint, separate to usage.
import { useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { type DateRange, Section } from './shared'
import SuburbBubbleMap, { type SuburbRow } from './SuburbBubbleMap'

export default function MapTab({ range }: { range: DateRange }) {
  // 1 — usage catchment (date-windowed).
  const usage = useQuery(api.analytics.getCatchmentReport, { from: range.from || undefined, to: range.to || undefined })
  const usageRows = useMemo<SuburbRow[] | undefined>(
    () => usage?.bySuburb?.map((r: any) => ({
      suburb: r.suburb,
      postcode: r.postcode,
      count: r.customers ?? r.bookings ?? 0,
      detail: `${r.bookings} session${r.bookings !== 1 ? 's' : ''}`,
    })),
    [usage]
  )

  // 2 — full-database registration map (no date window).
  const registered = useQuery(api.analytics.getCustomerSuburbMap, {})
  const registeredRows = useMemo<SuburbRow[] | undefined>(
    () => registered?.bySuburb?.map((r: any) => ({ suburb: r.suburb, postcode: r.postcode, count: r.customers })),
    [registered]
  )

  return (
    <div className="space-y-4">
      <Section title="Catchment heatmap (usage)" subtitle="Where customers who BOOK travel from — bubble size & colour scale with unique customers per suburb over the selected range (OpenStreetMap)">
        <SuburbBubbleMap
          rows={usageRows}
          metricLabel="Unique customers"
          summaryRight={usage ? `${usage.uniqueCustomers ?? '—'} unique customers · ${usage.total} sessions` : ''}
        />
      </Section>

      <Section title="All customers by registered suburb (full database)" subtitle="Every customer account plotted by the suburb on their profile — whether or not they have ever booked, all-time. The registration footprint, separate to usage.">
        <SuburbBubbleMap
          rows={registeredRows}
          metricLabel="Customers"
          summaryRight={registered ? `${registered.placed} of ${registered.totalCustomers} customers placed · ${registered.unknown} without a suburb` : ''}
        />
      </Section>
    </div>
  )
}
