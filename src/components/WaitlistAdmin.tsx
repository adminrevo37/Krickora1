import { useEffect, useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import ModalShell from './ModalShell'
import { formatDateLong } from '../lib/dateFormat'

// SPEC_WAITLIST_OFFER_REDESIGN — admin waitlist & first-refusal offer dashboard.
// Shows each slot's queue (oldest first), the current offeree + live countdown,
// and admin overrides: "Offer now" (re-kick the engine) and "Clear offer" (drop
// the live offer + hold and roll to the next member).

// SPEC_WAITLIST_SPLIT_BM_RU — entries are keyed by POOL sentinel, not a lane:
// '*bm' (bowling machines) / '*ru' (run-ups) / legacy '*' (any lane, pre-split).
const GROUP_NAMES: Record<string, string> = {
  '*bm': '🏏 BM waitlist',
  '*ru': '🏃 RU waitlist',
  '*': 'Any lane (legacy)',
}

function fmtHour12(h: number): string {
  const hr = Math.floor(h)
  const min = Math.round((h - hr) * 60)
  const period = hr >= 12 ? 'PM' : 'AM'
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr
  return `${display}:${min.toString().padStart(2, '0')} ${period}`
}

const fmtDate = formatDateLong

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const ms = expiresAt - now
  if (ms <= 0) return <span className="text-gray-400">expired</span>
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return <span className="font-mono">{mins}:{secs.toString().padStart(2, '0')}</span>
}

type Entry = {
  _id: string
  userId: string
  userName: string
  userEmail: string
  laneId: string
  date: string
  hour: number
  status: string
  offerExpiresAt: string | null
  createdAt: number
}

type Hold = {
  laneId: string
  date: string
  startHour: number
  userId: string
  userEmail: string
  expiresAt: number
}

// SPEC_WAITLIST_ALT_TIME_OFFER_2026-08 — "offer a different time" sheet.
//
// The existing "Offer now" button can only ever re-run the engine for the hour the
// queue is waiting on, so a cancellation at a DIFFERENT hour was unreachable. This
// sends a pool-level offer for another hour to some or all of the queue.
//
// 2026-08-18 (Inspector): an alt-time offer NEVER holds the slot, whatever the
// recipient count. It is a heads-up that a lane is free, not a reservation — the
// general public must still be able to book it. (This reverses the original
// 2026-08-14 single-recipient exclusive hold, which took a sellable slot off the
// market for hours on the chance one person acted on a notification.) The sheet
// and both notification channels state plainly that it is not held.
function AltTimeOfferSheet({
  pool, date, sourceHour, entries, onClose,
}: {
  pool: 'bm' | 'ru'
  date: string
  sourceHour: number
  entries: Entry[]
  onClose: () => void
}) {
  const create = useMutation(api.waitlistOffers.createWaitlistOffer)
  // Real bookable start times for THIS pool on THIS date — driven by the segment
  // config, so per-date layouts and half-hour starts are included and anything
  // with no free lane is excluded. (Was a naive 6am-9pm whole-hour loop.)
  const times = useQuery(api.waitlistOffers.listOfferableTimes, { date, pool }) as
    | Array<{ hour: number; label: string; laneNames: string[] }>
    | undefined
  const [hour, setHour] = useState<number | null>(null)
  const [selected, setSelected] = useState<string[]>(entries.map(e => e._id))
  const [customNote, setCustomNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const toggle = (id: string) =>
    setSelected(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))

  const exclusive = selected.length === 1
  // Exclude the hour they're already waiting on — that's what "Offer now" is for.
  const options = (times ?? []).filter(t => t.hour !== sourceHour)
  // Default to the first genuinely available time once they load.
  useEffect(() => {
    if (hour === null && options.length > 0) setHour(options[0].hour)
  }, [hour, options])
  const chosen = options.find(t => t.hour === hour) ?? null

  return (
    <ModalShell
      onClose={busy ? undefined : onClose}
      labelledBy="alt-offer-title"
      overlayClassName="fixed inset-0 z-[60] flex items-center justify-center p-4"
      panelClassName="relative bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-md p-5 max-h-[90dvh] overflow-y-auto"
    >
      <h3 id="alt-offer-title" className="text-base font-bold text-gray-900">Offer a different time</h3>
      <p className="text-sm text-gray-500 mt-0.5">
        {GROUP_NAMES[`*${pool}`]} · waiting on {fmtHour12(sourceHour)} · {fmtDate(date)}
      </p>

      {done ? (
        <div className="mt-4">
          <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">{done}</p>
          <button onClick={onClose} className="mt-4 w-full py-2.5 rounded-xl bg-gray-900 text-white text-sm font-semibold">Done</button>
        </div>
      ) : (
        <>
          <label className="block mt-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">Offer this time instead</label>
          {times === undefined ? (
            <p className="mt-1 text-sm text-gray-400">Checking availability…</p>
          ) : options.length === 0 ? (
            <p className="mt-1 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
              No other {pool.toUpperCase()} time is free on {fmtDate(date)} — there's nothing to offer.
            </p>
          ) : (
            <>
              <select
                value={hour ?? ''}
                onChange={e => setHour(Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm"
              >
                {options.map(t => (
                  <option key={t.hour} value={t.hour}>{t.label}</option>
                ))}
              </select>
              {chosen && (
                <p className="mt-1 text-[11px] text-gray-500">
                  Free now on {chosen.laneNames.join(', ')}. Only times with a free {pool.toUpperCase()} lane are listed, including any custom layout for this date.
                </p>
              )}
            </>
          )}

          <label className="block mt-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">
            Who gets it ({selected.length} of {entries.length})
          </label>
          <div className="mt-1 flex gap-2">
            <button onClick={() => setSelected(entries.map(e => e._id))} className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50">Select all</button>
            <button onClick={() => setSelected([])} className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50">Clear</button>
          </div>
          <ul className="mt-2 border border-gray-200 rounded-lg divide-y divide-gray-100">
            {entries.map((e, i) => (
              <li key={e._id}>
                <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-gray-50">
                  <input type="checkbox" checked={selected.includes(e._id)} onChange={() => toggle(e._id)} className="rounded" />
                  <span className="text-gray-400 text-xs w-4">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-800 truncate">{e.userName}</span>
                    <span className="block text-xs text-gray-400 truncate">{e.userEmail}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <label className="block mt-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">Note to include (optional)</label>
          <textarea
            value={customNote}
            onChange={e => setCustomNote(e.target.value)}
            rows={2}
            placeholder="e.g. Sorry we couldn't do 8am — this is the closest we have."
            className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm"
          />
          <p className="mt-1 text-[11px] text-gray-400">Included in both the push notification and the email.</p>

          <div className="mt-4 rounded-xl p-3 border text-xs bg-amber-50 border-amber-200 text-amber-800">
            {selected.length === 0
              ? 'Pick at least one customer.'
              : selected.length === 1
                ? 'The slot is NOT held. It stays on sale to the general public — this just tells them it is free, and whoever books first gets it. They are told that plainly.'
                : `${selected.length} recipients — the slot is NOT held. It stays on sale to the general public as well, and everyone is told it has been offered to several people. First to book gets it.`}
          </div>

          {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

          <div className="flex gap-3 mt-4">
            <button onClick={onClose} disabled={busy} className="flex-1 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-semibold disabled:opacity-50">Cancel</button>
            <button
              disabled={busy || selected.length === 0 || hour === null}
              onClick={async () => {
                setBusy(true); setError(null)
                try {
                  const res: any = await create({
                    pool, date, hour: hour as number, sourceHour,
                    waitlistEntryIds: selected as any,
                    customNote: customNote.trim() || undefined,
                  })
                  setDone(
                    `Offered ${fmtHour12(hour as number)} to ${res.recipients} ${res.recipients === 1 ? 'customer' : 'customers'} by push and email.` +
                    ' The slot is NOT held — it stays on sale to everyone, first to book gets it.'
                  )
                } catch (err: any) {
                  setError(err?.data ?? err?.message ?? 'Could not send the offer.')
                } finally { setBusy(false) }
              }}
              className="flex-[2] py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50"
            >
              {busy ? 'Sending…' : `Send offer${selected.length ? ` to ${selected.length}` : ''}`}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  )
}

export default function WaitlistAdmin() {
  const data = useQuery(api.queries.listWaitlistAdmin, {})
  const offerNow = useMutation(api.waitlist.manualAdvanceWaitlistOffer)
  const clearOffer = useMutation(api.waitlist.adminClearWaitlistOffer)
  const [busy, setBusy] = useState<string | null>(null)
  // SPEC_WAITLIST_ALT_TIME_OFFER_2026-08 — offer a queue a DIFFERENT time.
  const liveOffers = useQuery(api.waitlistOffers.listLiveWaitlistOffers, {}) ?? []
  const cancelAltOffer = useMutation(api.waitlistOffers.cancelWaitlistOffer)
  const [altFor, setAltFor] = useState<{ pool: 'bm' | 'ru'; date: string; sourceHour: number; entries: Entry[] } | null>(null)

  if (data === undefined) {
    return <div className="text-sm text-gray-400 py-8 text-center">Loading waitlist…</div>
  }

  const entries: Entry[] = data.entries ?? []
  const holds: Hold[] = data.holds ?? []

  if (entries.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 text-center">
        <div className="text-4xl mb-3">🎟️</div>
        <p className="text-gray-600 font-medium">No active waitlist entries</p>
        <p className="text-sm text-gray-400 mt-1">Freed slots are offered automatically, oldest member first.</p>
      </div>
    )
  }

  // Group entries by slot key.
  const groups = new Map<string, Entry[]>()
  for (const e of entries) {
    const key = `${e.laneId}|${e.date}|${e.hour}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }
  // Sort slot groups by date then hour.
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const [, da, ha] = a.split('|')
    const [, db, hb] = b.split('|')
    return da === db ? Number(ha) - Number(hb) : da < db ? -1 : 1
  })

  // A waitlist hold sits on a REAL lane while entries are keyed by pool
  // sentinel — match the hold by (date, hour) + a member of this group. (The
  // old laneId equality could never match a sentinel → the countdown and
  // Clear-offer button never showed. Fixed with the BM/RU split.)
  const holdFor = (group: Entry[], date: string, hour: number): Hold | undefined => {
    const members = new Set(group.map(e => e.userId))
    return holds.find(h => h.date === date && h.startHour === hour && members.has(h.userId))
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-4">
        <h3 className="text-lg font-bold text-gray-800">🎟️ Waitlist & Offers</h3>
        <p className="text-sm text-gray-500 mt-0.5">
          Freed slots are offered automatically to the longest-waiting member first.
          Use the overrides to re-offer a slot or clear a stuck offer.
        </p>
      </div>

      {liveOffers.length > 0 && (
        <div className="bg-white rounded-2xl border border-emerald-200 shadow-sm overflow-hidden">
          <div className="px-6 py-3 border-b border-emerald-100 bg-emerald-50/60">
            <span className="font-semibold text-gray-800">📨 Live alternative-time offers</span>
            <p className="text-xs text-gray-500 mt-0.5">
              Sent by push and email. Admin-sent offers expire when the session starts or someone books the slot.
              <span className="font-medium text-emerald-700"> AUTO</span> offers are made by the system when a slot frees with nobody waiting for that exact hour — a held one rolls to the next person when its timer lapses.
            </p>
          </div>
          <ul className="divide-y divide-gray-50">
            {liveOffers.map((o: any) => (
              <li key={o.id} className="px-6 py-3 flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-gray-800">
                    {o.source === 'auto' && (
                      <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 align-middle">AUTO</span>
                    )}
                    {GROUP_NAMES[`*${o.pool}`]} · {fmtDate(o.date)} · {fmtHour12(o.hour)} – {fmtHour12(o.hour + 1)}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    to {o.recipientNames.join(', ')} · asked for {fmtHour12(o.sourceHour)} ·{' '}
                    {/* Admin offers made before 2026-08-18 can be `exclusive` (legacy);
                        AUTO exclusive offers hold for the configured window. */}
                    {o.exclusive
                      ? (o.source === 'auto' && o.expiresAt
                          ? <span className="text-blue-700 font-medium">held for them until {new Date(o.expiresAt).toLocaleTimeString('en-AU', { timeZone: 'Australia/Perth', hour: 'numeric', minute: '2-digit' })}</span>
                          : <span className="text-blue-700 font-medium">held for them (legacy offer)</span>)
                      : <span className="text-amber-700 font-medium">not held — first to book wins</span>}
                  </p>
                </div>
                <button
                  disabled={busy === o.id}
                  onClick={async () => {
                    setBusy(o.id)
                    try { await cancelAltOffer({ offerId: o.id as any }) } finally { setBusy(null) }
                  }}
                  className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
                >
                  Cancel offer
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {altFor && (
        <AltTimeOfferSheet
          pool={altFor.pool}
          date={altFor.date}
          sourceHour={altFor.sourceHour}
          entries={altFor.entries}
          onClose={() => setAltFor(null)}
        />
      )}

      {sortedKeys.map(key => {
        const list = groups.get(key)!
        const { laneId, date, hour } = list[0]
        const hold = holdFor(list, date, hour)
        return (
          <div key={key} className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <span className="font-semibold text-gray-800">{GROUP_NAMES[laneId] ?? laneId}</span>
                <span className="text-gray-500 text-sm ml-2">
                  {fmtDate(date)} · {fmtHour12(hour)} – {fmtHour12(hour + 1)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  disabled={busy === key}
                  title="Re-run the automatic engine for THIS hour. Does nothing if this hour is still full."
                  onClick={async () => {
                    setBusy(key)
                    try { await offerNow({ laneId, date, hours: [hour] }) } finally { setBusy(null) }
                  }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
                >
                  Offer now
                </button>
                {/* SPEC_WAITLIST_ALT_TIME_OFFER_2026-08 — "Offer now" above can only
                    ever offer THIS hour. This one offers a different hour (e.g. a
                    9am cancellation to the 8am queue). */}
                {(laneId === '*bm' || laneId === '*ru') && (
                  <button
                    onClick={() => setAltFor({ pool: laneId === '*bm' ? 'bm' : 'ru', date, sourceHour: hour, entries: list })}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white border border-emerald-600 text-emerald-700 hover:bg-emerald-50"
                  >
                    Offer a different time
                  </button>
                )}
                {hold && (
                  <button
                    disabled={busy === key}
                    onClick={async () => {
                      setBusy(key)
                      try { await clearOffer({ laneId, date, hour }) } finally { setBusy(null) }
                    }}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
                  >
                    Clear offer
                  </button>
                )}
              </div>
            </div>
            <ul className="divide-y divide-gray-50">
              {list.map((e, i) => {
                const isOffered = e.status === 'offered'
                return (
                  <li key={e._id} className="px-6 py-2.5 flex items-center justify-between gap-3 text-sm">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-gray-400 w-5 text-right">{i + 1}</span>
                      <div className="min-w-0">
                        <p className="font-medium text-gray-800 truncate">{e.userName}</p>
                        <p className="text-gray-400 text-xs truncate">{e.userEmail}</p>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {isOffered ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-semibold">
                          Offered ·{' '}
                          {hold ? <Countdown expiresAt={hold.expiresAt} /> : 'pending'}
                        </span>
                      ) : (
                        <span className="px-2.5 py-1 rounded-full bg-gray-50 text-gray-500 text-xs font-medium">
                          Waiting
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
