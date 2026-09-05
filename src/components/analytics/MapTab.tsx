// SPEC_ANALYTICS_BUILD_2026-06 addendum — OpenStreetMap suburb maps. Two maps:
//  1. Catchment heatmap (USAGE) — unique customers per suburb from confirmed
//     bookings (getCatchmentReport), respects the dashboard date range.
//  2. All customers by registered suburb (FULL DATABASE) — every customer account
//     plotted by the suburb on their profile, independent of bookings + no date
//     window (getCustomerSuburbMap). The registration footprint, separate to usage.
//
// 2026-09-05: both maps now state what the SERVER could not attribute (rows with no
// suburb snapshot / no suburb on file) — the postcode gate only went live this week,
// so most legacy accounts and their past bookings have nothing to plot. The new
// server fields (unknownCustomers, withoutPostcode) are read defensively so an
// in-flight tab talking to the previous deployment still renders.
import { useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { type DateRange, Section } from './shared'
import SuburbBubbleMap, { type SuburbRow } from './SuburbBubbleMap'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
  const usageNote = useMemo(() => {
    if (!usage) return undefined
    const u = usage as any
    if (!u.unknown) return undefined
    const who = typeof u.unknownCustomers === 'number' ? ` from ${plural(u.unknownCustomers, 'customer')}` : ''
    return `${plural(u.unknown, 'session')}${who} in this range have no suburb on file and are not on the map (booked before the customer had a postcode; re-run the booking-suburb backfill after customers fill in their profile).`
  }, [usage])

  // 2 — full-database registration map (no date window).
  const registered = useQuery(api.analytics.getCustomerSuburbMap, {})
  const registeredRows = useMemo<SuburbRow[] | undefined>(
    () => registered?.bySuburb?.map((r: any) => ({ suburb: r.suburb, postcode: r.postcode, count: r.customers })),
    [registered]
  )
  const registeredNote = useMemo(() => {
    if (!registered) return undefined
    const r = registered as any
    if (!r.unknown) return undefined
    const pct = r.totalCustomers ? ` (${Math.round((r.unknown / r.totalCustomers) * 100)}%)` : ''
    return `${plural(r.unknown, 'customer account')}${pct} have no suburb on file and are not on the map — they will appear as they complete the postcode gate.`
  }, [registered])

  return (
    <div className="space-y-4">
      <Section title="Catchment heatmap (usage)" subtitle="Where customers who BOOK travel from — unique customers per suburb over the selected range. Switch between bubbles, density heat and a ranked top-15; rings are 5/10/20 km from 78 Jones St (OpenStreetMap)">
        <SuburbBubbleMap
          rows={usageRows}
          metricLabel="Unique customers"
          title="Catchment heatmap (usage)"
          summaryRight={usage ? `${usage.uniqueCustomers ?? '—'} unique customers · ${usage.total} sessions` : ''}
          unknownNote={usageNote}
        />
      </Section>

      <Section title="All customers by registered suburb (full database)" subtitle="Every customer account plotted by the suburb on their profile — whether or not they have ever booked, all-time. The registration footprint, separate to usage.">
        <SuburbBubbleMap
          rows={registeredRows}
          metricLabel="Customers"
          title="All customers by registered suburb"
          summaryRight={registered ? `${registered.placed} of ${registered.totalCustomers} customers placed · ${registered.unknown} without a suburb` : ''}
          unknownNote={registeredNote}
        />
      </Section>
    </div>
  )
}
