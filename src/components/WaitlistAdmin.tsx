import { useEffect, useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'

// SPEC_WAITLIST_OFFER_REDESIGN — admin waitlist & first-refusal offer dashboard.
// Shows each slot's queue (oldest first), the current offeree + live countdown,
// and admin overrides: "Offer now" (re-kick the engine) and "Clear offer" (drop
// the live offer + hold and roll to the next member).

const LANE_NAMES: Record<string, string> = {
  bm1: 'Bowling Machine Lane 1',
  bm2: 'Bowling Machine Lane 2',
  bm3: 'Bowling Machine Lane 3',
  ru1: 'Run-Up Lane 1',
  ru2: 'Run-Up Lane 2',
}

function fmtHour12(h: number): string {
  const hr = Math.floor(h)
  const min = Math.round((h - hr) * 60)
  const period = hr >= 12 ? 'PM' : 'AM'
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr
  return `${display}:${min.toString().padStart(2, '0')} ${period}`
}

function fmtDate(date: string): string {
  return new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  })
}

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

export default function WaitlistAdmin() {
  const data = useQuery(api.queries.listWaitlistAdmin, {})
  const offerNow = useMutation(api.waitlist.manualAdvanceWaitlistOffer)
  const clearOffer = useMutation(api.waitlist.adminClearWaitlistOffer)
  const [busy, setBusy] = useState<string | null>(null)

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

  const holdFor = (laneId: string, date: string, hour: number): Hold | undefined =>
    holds.find(h => h.laneId === laneId && h.date === date && h.startHour === hour)

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-4">
        <h3 className="text-lg font-bold text-gray-800">🎟️ Waitlist & Offers</h3>
        <p className="text-sm text-gray-500 mt-0.5">
          Freed slots are offered automatically to the longest-waiting member first.
          Use the overrides to re-offer a slot or clear a stuck offer.
        </p>
      </div>

      {sortedKeys.map(key => {
        const list = groups.get(key)!
        const { laneId, date, hour } = list[0]
        const hold = holdFor(laneId, date, hour)
        return (
          <div key={key} className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <span className="font-semibold text-gray-800">{LANE_NAMES[laneId] ?? laneId}</span>
                <span className="text-gray-500 text-sm ml-2">
                  {fmtDate(date)} · {fmtHour12(hour)} – {fmtHour12(hour + 1)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  disabled={busy === key}
                  onClick={async () => {
                    setBusy(key)
                    try { await offerNow({ laneId, date, hours: [hour] }) } finally { setBusy(null) }
                  }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
                >
                  Offer now
                </button>
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
