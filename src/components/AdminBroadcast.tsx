// SPEC_ADMIN_BROADCAST — admin "Broadcast" tab. Audience builder (scope + types)
// → deduped recipient checklist (push/email reachability) → compose (title/body/
// link, tier, promotional, also-email-all) → preview + test-to-self → confirm +
// send. Plus a history list of past sends.
import { useMemo, useState } from 'react'
import { useQuery, useMutation, useAction } from 'convex/react'
import { toast } from 'sonner'
import { api } from '../../convex/_generated/api'

type Scope = 'day' | 'week' | 'month' | 'range' | 'all'
type RecipientType = 'customer' | 'coach' | 'athlete'

type Recipient = {
  customerId: string
  name: string
  email: string
  types: string[]
  childNames: string[]
  pushReachable: boolean
}

// ── date helpers (local) ──────────────────────────────────────────────────────
const fmt = (d: Date) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}
function rangeForScope(scope: Scope, ref: string, rStart: string, rEnd: string): { start?: string; end?: string } {
  if (scope === 'all') return {}
  if (scope === 'range') return { start: rStart, end: rEnd }
  const d = parse(ref)
  if (scope === 'day') return { start: ref, end: ref }
  if (scope === 'week') {
    const dow = (d.getDay() + 6) % 7 // Mon=0
    const mon = new Date(d); mon.setDate(d.getDate() - dow)
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
    return { start: fmt(mon), end: fmt(sun) }
  }
  // month
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { start: fmt(first), end: fmt(last) }
}

function Chip({ children, color }: { children: React.ReactNode; color: string }) {
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${color}`}>{children}</span>
}

export default function AdminBroadcast() {
  const today = fmt(new Date())
  // ── audience selection ──
  const [scope, setScope] = useState<Scope>('week')
  const [refDate, setRefDate] = useState(today)
  const [rStart, setRStart] = useState(today)
  const [rEnd, setREnd] = useState(today)
  const [types, setTypes] = useState<Set<RecipientType>>(new Set(['customer']))
  const [built, setBuilt] = useState(false)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  // ── compose ──
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [link, setLink] = useState('')
  const [broadcastType, setBroadcastType] = useState<'announcement' | 'urgent'>('announcement')
  const [isPromotional, setIsPromotional] = useState(false)
  const [alsoEmailAll, setAlsoEmailAll] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [testing, setTesting] = useState(false)

  const { start, end } = useMemo(
    () => rangeForScope(scope, refDate, rStart, rEnd),
    [scope, refDate, rStart, rEnd]
  )

  const audienceArgs = built
    ? { scope, scopeStart: start, scopeEnd: end, recipientTypes: Array.from(types) }
    : 'skip'
  const audience = useQuery(api.broadcast.resolveBroadcastAudience, audienceArgs as any) as
    | { recipients: Recipient[]; counts: { total: number; push: number; email: number } }
    | undefined

  const history = useQuery(api.broadcast.listBroadcasts, { limit: 25 }) as any[] | undefined
  const sendBroadcast = useMutation(api.broadcast.sendBroadcast)
  const sendTest = useAction(api.broadcast.sendTestBroadcast)

  const recipients = audience?.recipients ?? []
  const selected = recipients.filter((r) => !excluded.has(r.customerId))
  const selPush = selected.filter((r) => r.pushReachable).length
  const selEmail = selected.length - selPush

  const toggleType = (t: RecipientType) => {
    const next = new Set(types)
    next.has(t) ? next.delete(t) : next.add(t)
    setTypes(next)
    setBuilt(false)
  }
  const build = () => {
    if (types.size === 0) { toast.error('Pick at least one recipient type.'); return }
    if (scope === 'range' && (!rStart || !rEnd || rStart > rEnd)) { toast.error('Pick a valid date range.'); return }
    setExcluded(new Set())
    setBuilt(true)
  }
  const toggleRow = (id: string) => {
    const next = new Set(excluded)
    next.has(id) ? next.delete(id) : next.add(id)
    setExcluded(next)
  }

  const doSend = async () => {
    setSending(true)
    try {
      const res = await sendBroadcast({
        title: title.trim(),
        body: body.trim(),
        link: link.trim() || undefined,
        broadcastType,
        isPromotional,
        alsoEmailAll,
        scope,
        scopeStart: start,
        scopeEnd: end,
        recipientTypes: Array.from(types),
        recipients: selected.map((r) => ({ customerId: r.customerId as any, childNames: r.childNames })),
      })
      toast.success(`Broadcast queued to ${res.recipientCount} recipient(s).`)
      setConfirming(false)
      setTitle(''); setBody(''); setLink(''); setIsPromotional(false); setAlsoEmailAll(false)
      setBuilt(false)
    } catch (e: any) {
      toast.error(e?.data ?? e?.message ?? 'Could not send broadcast.')
    } finally {
      setSending(false)
    }
  }

  const doTest = async () => {
    if (!title.trim() || !body.trim()) { toast.error('Add a title and message first.'); return }
    setTesting(true)
    try {
      const res = await sendTest({ title: title.trim(), body: body.trim(), link: link.trim() || undefined })
      if (res.success) toast.success('Test sent to your own account.')
      else toast.error(res.reason ?? 'Could not send a test.')
    } catch (e: any) {
      toast.error(e?.data ?? e?.message ?? 'Could not send a test.')
    } finally {
      setTesting(false)
    }
  }

  const canSend = built && selected.length > 0 && title.trim().length > 0 && body.trim().length > 0

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-800">📣 Broadcast</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Send a message to a chosen audience as a push notification, with email fallback to anyone
          not reachable by push.
        </p>
      </div>

      {/* ── 1. Audience ── */}
      <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">1 · Audience</h3>
        <div className="flex flex-wrap gap-2">
          {([
            ['day', 'This day'], ['week', 'This week'], ['month', 'This month'],
            ['range', 'Custom range'], ['all', 'All customers'],
          ] as [Scope, string][]).map(([s, label]) => (
            <button
              key={s}
              onClick={() => { setScope(s); setBuilt(false) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${scope === s ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >{label}</button>
          ))}
        </div>

        {scope !== 'all' && scope !== 'range' && (
          <label className="block text-sm">
            <span className="text-gray-600">Reference date</span>
            <input type="date" value={refDate} onChange={(e) => { setRefDate(e.target.value); setBuilt(false) }}
              className="mt-1 block border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
            {start && <span className="ml-3 text-xs text-gray-400">{start} → {end}</span>}
          </label>
        )}
        {scope === 'range' && (
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="block"><span className="text-gray-600">From</span>
              <input type="date" value={rStart} onChange={(e) => { setRStart(e.target.value); setBuilt(false) }}
                className="mt-1 block border border-gray-300 rounded-lg px-3 py-1.5" /></label>
            <label className="block"><span className="text-gray-600">To</span>
              <input type="date" value={rEnd} onChange={(e) => { setREnd(e.target.value); setBuilt(false) }}
                className="mt-1 block border border-gray-300 rounded-lg px-3 py-1.5" /></label>
          </div>
        )}

        <div className="flex flex-wrap gap-4">
          {([['customer', 'Customers'], ['coach', 'Coaches'], ['athlete', 'Athletes / children']] as [RecipientType, string][]).map(([t, label]) => (
            <label key={t} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={types.has(t)} onChange={() => toggleType(t)} className="rounded" />
              {label}
            </label>
          ))}
        </div>
        {types.has('athlete') && (
          <p className="text-xs text-gray-400">Athletes have no login — the message goes to the parent account, referencing the child.</p>
        )}

        <button onClick={build} className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700">
          Build recipient list
        </button>
      </section>

      {/* ── 2. Recipients ── */}
      {built && (
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">2 · Recipients</h3>
            <div className="text-xs text-gray-500">
              {audience === undefined ? 'Loading…' : (
                <>
                  <strong className="text-gray-800">{selected.length}</strong> selected ·
                  🔔 {selPush} push · ✉️ {selEmail} email
                </>
              )}
            </div>
          </div>
          {audience !== undefined && recipients.length === 0 && (
            <p className="text-sm text-gray-400">No recipients match this scope.</p>
          )}
          {recipients.length > 0 && (
            <>
              <div className="flex gap-3 text-xs">
                <button onClick={() => setExcluded(new Set())} className="text-emerald-600 hover:underline">Select all</button>
                <button onClick={() => setExcluded(new Set(recipients.map((r) => r.customerId)))} className="text-gray-500 hover:underline">Select none</button>
              </div>
              <div className="max-h-72 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100">
                {recipients.map((r) => (
                  <label key={r.customerId} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" checked={!excluded.has(r.customerId)} onChange={() => toggleRow(r.customerId)} className="rounded" />
                    <span className="flex-1 min-w-0 truncate text-gray-800">{r.name}
                      {r.childNames.length > 0 && <span className="text-gray-400"> · re: {r.childNames.join(', ')}</span>}
                    </span>
                    <span className="flex items-center gap-1">
                      {r.types.map((t) => <Chip key={t} color="bg-gray-100 text-gray-500">{t}</Chip>)}
                      {r.pushReachable
                        ? <Chip color="bg-emerald-50 text-emerald-600">🔔 push</Chip>
                        : <Chip color="bg-amber-50 text-amber-600">✉️ email</Chip>}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* ── 3. Compose ── */}
      {built && selected.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">3 · Compose</h3>
          <label className="block text-sm">
            <span className="text-gray-600">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120}
              placeholder="Holiday hours this week" className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">Message</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4}
              placeholder="Write your message…" className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">Link (optional)</span>
            <input value={link} onChange={(e) => setLink(e.target.value)}
              placeholder="/bookings or https://…" className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>

          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={broadcastType === 'announcement'} onChange={() => setBroadcastType('announcement')} />
              Announcement <span className="text-xs text-gray-400">(respects opt-outs)</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={broadcastType === 'urgent'} onChange={() => setBroadcastType('urgent')} />
              Urgent update <span className="text-xs text-gray-400">(ignores all opt-outs)</span>
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2 text-gray-700">
              <input type="checkbox" checked={alsoEmailAll} onChange={(e) => setAlsoEmailAll(e.target.checked)} className="rounded" />
              Also email everyone (push-reachable still get push)
            </label>
            <label className="flex items-center gap-2 text-gray-700">
              <input type="checkbox" checked={isPromotional} disabled={broadcastType === 'urgent'}
                onChange={(e) => setIsPromotional(e.target.checked)} className="rounded" />
              Promotional <span className="text-xs text-gray-400">(adds unsubscribe, honours marketing opt-out)</span>
            </label>
          </div>

          {/* Preview */}
          {(title.trim() || body.trim()) && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
              <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Push preview</p>
              <div className="bg-white rounded-md border border-gray-200 p-2 shadow-sm max-w-sm">
                <p className="text-sm font-semibold text-gray-800">{title || '(title)'}</p>
                <p className="text-xs text-gray-600 whitespace-pre-wrap">{body || '(message)'}</p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button onClick={doTest} disabled={testing}
              className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 disabled:opacity-50">
              {testing ? 'Sending…' : 'Test to myself'}
            </button>
            <button onClick={() => setConfirming(true)} disabled={!canSend}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-40">
              Send broadcast →
            </button>
          </div>
        </section>
      )}

      {/* Confirm dialog */}
      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !sending && setConfirming(false)}>
          <div className="bg-white rounded-2xl p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-2">Send this broadcast?</h3>
            <p className="text-sm text-gray-600 mb-3">
              <strong>{selected.length}</strong> recipient(s): about <strong>{selPush}</strong> by push and{' '}
              <strong>{alsoEmailAll ? selected.length : selEmail}</strong> by email
              {broadcastType === 'urgent' && <> · <span className="text-red-600 font-semibold">urgent (ignores opt-outs)</span></>}
              {isPromotional && <> · promotional</>}.
            </p>
            <p className="text-xs text-gray-400 mb-4">Final counts depend on each recipient's preferences and devices at send time.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirming(false)} disabled={sending} className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm">Cancel</button>
              <button onClick={doSend} disabled={sending} className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50">
                {sending ? 'Sending…' : 'Confirm & send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── History ── */}
      <section className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-3">History</h3>
        {!history || history.length === 0 ? (
          <p className="text-sm text-gray-400">No broadcasts sent yet.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {history.map((b) => (
              <div key={b._id} className="py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-gray-800 truncate">{b.title}</span>
                  <span className="text-xs text-gray-400 shrink-0">{new Date(b.createdAt).toLocaleString()}</span>
                </div>
                <p className="text-xs text-gray-500 truncate mt-0.5">{b.body}</p>
                <div className="flex flex-wrap items-center gap-2 mt-1 text-[11px] text-gray-500">
                  <Chip color="bg-gray-100 text-gray-600">{b.scope}</Chip>
                  {b.broadcastType === 'urgent' && <Chip color="bg-red-50 text-red-600">urgent</Chip>}
                  {b.isPromotional && <Chip color="bg-purple-50 text-purple-600">promo</Chip>}
                  <span>{b.recipientCount} sent · 🔔 {b.pushCount} · ✉️ {b.emailCount}</span>
                  <Chip color={b.status === 'sent' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}>{b.status}</Chip>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
