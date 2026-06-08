// SPEC_SERVER_ACTIVITY_FEED (2026-06) — granular real-time admin feed of ALL
// server activity: page views (who opened what screen), push and email events
// (incl. delivery), newest first, exact AWST time to the second. Source filter
// (Page / Push / Email). Reactive via useQuery — rows appear instantly.
// Companion to LiveFeedTab (bookings only). Source: convex/serverActivity.
import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { Section, Loading, Empty } from './shared'

type Row = {
  id: string
  at: number
  source: 'page' | 'push' | 'email' | 'entry'
  kind: string
  email?: string
  name?: string
  label?: string
  sub?: string
  platform?: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

// AWST (UTC+8, no DST) wall-clock to the second.
function fmtTime(ms: number): string {
  const d = new Date(ms + 8 * 3600000)
  const h = d.getUTCHours()
  const h12 = (h % 12) || 12
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${h12}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${h >= 12 ? 'pm' : 'am'}`
}

const SOURCE_META: Record<Row['source'], { label: string; cls: string }> = {
  page: { label: 'Page', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  push: { label: 'Push', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  email: { label: 'Email', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  entry: { label: 'Entry', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
}

const LIFECYCLE_TONE: Record<string, string> = {
  sent: 'text-gray-500',
  delivered: 'text-emerald-600',
  opened: 'text-sky-600',
  clicked: 'text-violet-600',
  failed: 'text-red-600',
  bounced: 'text-red-600',
  complained: 'text-red-500',
  pruned: 'text-gray-400',
  delivery_delayed: 'text-amber-600',
}

function kindLabel(source: Row['source'], kind: string): { text: string; tone: string } {
  if (source === 'page') {
    if (kind === 'pageview') return { text: 'viewed', tone: 'text-gray-500' }
    if (kind === 'session_start') return { text: 'session start', tone: 'text-emerald-600' }
    if (kind === 'session_end') return { text: 'session end', tone: 'text-gray-400' }
    if (kind.startsWith('event:')) return { text: kind.slice(6), tone: 'text-sky-600' }
    return { text: kind, tone: 'text-gray-500' }
  }
  if (source === 'entry') {
    if (kind === 'valid') return { text: 'valid entry', tone: 'text-emerald-600' }
    if (kind === 'invalid') return { text: 'invalid code', tone: 'text-red-600' }
    return { text: kind, tone: 'text-gray-500' }
  }
  return { text: kind.replace(/_/g, ' '), tone: LIFECYCLE_TONE[kind] ?? 'text-gray-500' }
}

const FILTERS: { id: 'all' | Row['source']; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'page', label: 'Page views' },
  { id: 'push', label: 'Push' },
  { id: 'email', label: 'Email' },
  { id: 'entry', label: 'Entry' },
]

export default function ServerActivityTab() {
  const [filter, setFilter] = useState<'all' | Row['source']>('all')
  const sources = filter === 'all' ? undefined : [filter]
  const rows = useQuery(api.serverActivity.getServerActivity, { limit: 200, sources }) as Row[] | undefined

  return (
    <Section
      title="Live activity feed"
      subtitle="Every server event — page views, push and email — newest first, exact AWST time, updating in real time."
      action={
        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          Live
        </span>
      }
    >
      <div className="px-6 pt-1 pb-3 flex gap-1.5 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
              filter === f.id ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {rows === undefined ? (
        <Loading label="Loading activity…" />
      ) : rows.length === 0 ? (
        <Empty label="No activity yet. Server events will appear here instantly." />
      ) : (
        <div className="divide-y divide-gray-100">
          {rows.map((r) => {
            const sm = SOURCE_META[r.source]
            const k = kindLabel(r.source, r.kind)
            const who = r.source === 'entry' ? 'Keypad' : (r.name || r.email || 'Guest')
            const known = r.source === 'entry' || !!(r.name || r.email)
            return (
              <div key={r.id} className="px-6 py-2.5 flex items-start gap-3 text-sm">
                <div className="w-36 shrink-0 text-xs text-gray-400 tabular-nums pt-0.5">{fmtTime(r.at)}</div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${sm.cls}`}>
                  {sm.label}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`font-semibold ${known ? 'text-gray-800' : 'text-gray-400'}`}>{who}</span>
                    <span className={`text-xs font-medium ${k.tone}`}>{k.text}</span>
                    {r.platform && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 text-gray-500 border border-gray-200">
                        {r.platform}
                      </span>
                    )}
                  </div>
                  {(r.label || r.sub) && (
                    <div className="mt-0.5 leading-snug truncate">
                      {r.label && <span className="text-gray-700">{r.label}</span>}
                      {r.sub && <span className="text-gray-400">{r.label ? ' · ' : ''}{r.sub}</span>}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}
