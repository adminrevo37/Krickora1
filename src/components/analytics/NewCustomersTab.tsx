// New-customer registration feed — accounts as they register, newest first, live.
// Each row shows whether the customer has LINKED A COACH (any of their athletes,
// incl. their own, has an assigned coach) + who. Reactive via useQuery — a new
// signup appears instantly and the coach badge flips the moment they link one.
// Companion to LiveFeedTab (bookings) + ServerActivityTab. Source: serverActivity.
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { Section, Loading, Empty } from './shared'

type Row = {
  id: string
  at: number
  name: string
  email: string
  suburb?: string | null
  postcode?: string | null
  referralSource?: string | null
  hasLinkedCoach: boolean
  coachNames: string[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

// AWST (UTC+8, no DST) wall-clock.
function fmtTime(ms: number): string {
  const d = new Date(ms + 8 * 3600000)
  const h = d.getUTCHours()
  const h12 = (h % 12) || 12
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${h12}:${pad(d.getUTCMinutes())}${h >= 12 ? 'pm' : 'am'}`
}

export default function NewCustomersTab() {
  const data = useQuery((api as any).serverActivity.getNewCustomers, {}) as Row[] | null | undefined

  if (data === undefined) return <Loading label="Loading new customers…" />
  if (data === null) return <Empty label="Admin access required." />

  const linked = data.filter((r) => r.hasLinkedCoach).length

  return (
    <Section
      title="New customers"
      subtitle="Accounts as they register — newest first, live. Shows whether each has linked a coach."
      action={<span className="text-xs text-gray-500">{data.length} shown · {linked} with a coach</span>}
    >
      {data.length === 0 ? (
        <Empty label="No customers registered yet." />
      ) : (
        <div className="divide-y divide-gray-100">
          {data.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">{r.name}</div>
                <div className="text-xs text-gray-500 truncate">
                  {r.email}
                  {r.suburb ? ` · ${r.suburb}${r.postcode ? ` ${r.postcode}` : ''}` : ''}
                  {r.referralSource ? ` · via ${r.referralSource}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {r.hasLinkedCoach ? (
                  <span
                    className="inline-flex px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-medium max-w-[220px] truncate"
                    title={r.coachNames.join(', ')}
                  >
                    ✓ Coach{r.coachNames.length ? `: ${r.coachNames.join(', ')}` : ' linked'}
                  </span>
                ) : (
                  <span className="inline-flex px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200 text-xs font-medium">
                    No coach
                  </span>
                )}
                <span className="text-xs text-gray-400 whitespace-nowrap">{fmtTime(r.at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}
