// Live booking feed (2026-06) — reactive admin view of booking lifecycle events
// (created / modified / cancelled), newest first, auto-updating via useQuery. For a
// modification the OLD slot is struck through and the NEW slot shows the changed
// fields highlighted, on one line. Source: convex/bookingEvents (by_at, newest first).
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { Section, Loading, Empty } from './shared'

type Snap = { date: string; startHour: number; duration: number; lane: string; variant?: string }
type FeedEvent = {
  _id: string
  at: number
  type: 'created' | 'modified' | 'cancelled'
  bookingId: string
  customerName: string
  actorName?: string
  isCoachBooking?: boolean
  before?: Snap
  after?: Snap
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

// AWST (UTC+8, no DST) wall-clock parts for a ms epoch.
function awst(ms: number) {
  const d = new Date(ms + 8 * 3600000)
  return {
    mo: d.getUTCMonth(), day: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
  }
}
function fmtEventTime(ms: number): string {
  const p = awst(ms)
  const h12 = (p.h % 12) || 12
  return `${p.day} ${MONTHS[p.mo]} · ${h12}:${pad(p.mi)}:${pad(p.s)}${p.h >= 12 ? 'pm' : 'am'}`
}
function fmtHour(h: number): string {
  const hr = Math.floor(h)
  const mn = Math.round((h - hr) * 60)
  const h12 = (hr % 12) || 12
  return `${h12}:${pad(mn)}${hr >= 12 ? 'pm' : 'am'}`
}
function fmtDur(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
}
function fmtSlotDate(dateKey: string): string {
  const [, mo, d] = dateKey.split('-').map(Number)
  return `${d} ${MONTHS[(mo || 1) - 1]}`
}
function fmtSlotPlain(s: Snap): string {
  return `${s.lane} · ${fmtSlotDate(s.date)} ${fmtHour(s.startHour)} · ${fmtDur(s.duration)}`
}

// Render a slot; when `cmp` is given, changed fields are highlighted (used for the
// NEW side of a modification so the diff reads at a glance).
function SlotParts({ snap, cmp }: { snap: Snap; cmp?: Snap }) {
  const hot = (c: boolean) => (c ? 'text-amber-600 font-semibold' : 'text-gray-700')
  return (
    <span className="tabular-nums">
      <span className={hot(!!cmp && snap.lane !== cmp.lane)}>{snap.lane}</span>
      {snap.variant ? <span className={hot(!!cmp && snap.variant !== cmp.variant)}> ({snap.variant})</span> : null}
      {' · '}
      <span className={hot(!!cmp && snap.date !== cmp.date)}>{fmtSlotDate(snap.date)}</span>{' '}
      <span className={hot(!!cmp && snap.startHour !== cmp.startHour)}>{fmtHour(snap.startHour)}</span>
      {' · '}
      <span className={hot(!!cmp && snap.duration !== cmp.duration)}>{fmtDur(snap.duration)}</span>
    </span>
  )
}

const TYPE_META: Record<FeedEvent['type'], { label: string; cls: string; dot: string }> = {
  created: { label: 'Created', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  modified: { label: 'Modified', cls: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
}

export default function LiveFeedTab() {
  const events = useQuery(api.bookingEvents.getRecentBookingEvents, { limit: 150 }) as FeedEvent[] | undefined

  if (events === undefined) return <Loading label="Loading live feed…" />

  return (
    <Section
      title="Live booking feed"
      subtitle="Bookings created, modified and cancelled — newest first, updating in real time."
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
      {events.length === 0 ? (
        <Empty label="No booking activity yet. New bookings will appear here instantly." />
      ) : (
        <div className="divide-y divide-gray-100">
          {events.map((e) => {
            const meta = TYPE_META[e.type] ?? TYPE_META.created
            return (
              <div key={e._id} className="px-6 py-3 flex items-start gap-3 text-sm">
                <div className="w-36 shrink-0 text-xs text-gray-400 tabular-nums pt-0.5">{fmtEventTime(e.at)}</div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${meta.cls}`}>
                  {meta.label}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-semibold text-gray-800">{e.customerName}</span>
                    {e.isCoachBooking && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 border border-violet-200">coach</span>
                    )}
                    {e.actorName && e.actorName !== e.customerName && (
                      <span className="text-xs text-gray-400">by {e.actorName}</span>
                    )}
                  </div>
                  <div className="mt-0.5 leading-snug">
                    {e.type === 'modified' && e.before && e.after ? (
                      <span>
                        <span className="line-through text-gray-400">{fmtSlotPlain(e.before)}</span>
                        <span className="text-gray-400 mx-1.5">→</span>
                        <SlotParts snap={e.after} cmp={e.before} />
                      </span>
                    ) : e.type === 'cancelled' && e.after ? (
                      <span className="line-through text-gray-400">{fmtSlotPlain(e.after)}</span>
                    ) : e.after ? (
                      <SlotParts snap={e.after} />
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}
