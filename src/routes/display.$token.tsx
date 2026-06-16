// Public TV "lane status" board — full-screen, no login, auto-updating.
// Loaded by the facility display (Raspberry Pi kiosk) at /display/<25-char-token>.
// The token is checked server-side by api.display.getLaneDisplay; a wrong token
// shows an "invalid link" message, never booking data. See cricket/lane-display.
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/display/$token')({
  component: DisplayBoard,
})

type Booking = { name: string; startHour: number; endHour: number; isCoach: boolean }
type Lane = {
  laneId: string
  bayNumber: number
  order: number
  name: string
  mode: string
  bookings: Booking[]
}
type DisplayData = { ok: true; date: string; lanes: Lane[] } | { ok: false }

// Current Perth (AWST) date + decimal hour, independent of the device's timezone.
function perthNow(): { date: string; hour: number; clock: string } {
  const now = new Date()
  const parts: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Australia/Perth',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)) {
    parts[p.type] = p.value
  }
  let hh = parseInt(parts.hour, 10)
  if (hh === 24) hh = 0
  const mm = parseInt(parts.minute, 10)
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: hh + mm / 60,
    clock: fmtTime(hh + mm / 60),
  }
}

function fmtTime(h: number): string {
  const hr = Math.floor(h + 1e-6)
  const min = Math.round((h - hr) * 60)
  const ampm = hr >= 12 ? 'pm' : 'am'
  let h12 = hr % 12
  if (h12 === 0) h12 = 12
  return `${h12}:${String(min).padStart(2, '0')}${ampm}`
}

function fmtDateLong(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
  })
}

function DisplayBoard() {
  const { token } = Route.useParams()
  const [now, setNow] = useState(() => perthNow())

  useEffect(() => {
    const id = setInterval(() => setNow(perthNow()), 15000)
    return () => clearInterval(id)
  }, [])

  const data = useQuery(api.display.getLaneDisplay, { token, date: now.date }) as
    | DisplayData
    | undefined

  // Loading
  if (data === undefined) {
    return (
      <Shell>
        <div className="flex-1 flex items-center justify-center text-2xl text-white/50">
          Loading lane status…
        </div>
      </Shell>
    )
  }
  // Bad/missing token
  if (!data.ok) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
          <div className="text-4xl">🔒</div>
          <div className="text-2xl text-white/70">This display link isn’t valid.</div>
        </div>
      </Shell>
    )
  }

  const lanes = [...data.lanes].sort((a, b) => a.order - b.order)

  return (
    <Shell clock={now.clock} date={fmtDateLong(data.date)}>
      <div
        className="flex-1 grid gap-3 px-4 pb-4"
        style={{ gridTemplateColumns: `repeat(${lanes.length || 1}, minmax(0, 1fr))` }}
      >
        {lanes.map((lane) => (
          <LaneCard key={lane.laneId} lane={lane} hour={now.hour} />
        ))}
      </div>
    </Shell>
  )
}

function LaneCard({ lane, hour }: { lane: Lane; hour: number }) {
  const current = lane.bookings.find((b) => b.startHour <= hour && hour < b.endHour - 1e-6)
  const next = lane.bookings
    .filter((b) => b.startHour > hour - 1e-6 && b !== current)
    .sort((a, b) => a.startHour - b.startHour)[0]

  const accent = lane.mode === 'RU' ? 'text-amber-300' : 'text-sky-300'

  return (
    <div
      className={`flex flex-col rounded-2xl border overflow-hidden ${
        current
          ? 'border-white/15 bg-white/[0.06]'
          : 'border-emerald-500/25 bg-emerald-500/[0.06]'
      }`}
    >
      {/* Lane header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-baseline justify-between">
        <span className={`font-black tracking-tight ${accent}`} style={{ fontSize: 'clamp(1.2rem,2.4vw,2.2rem)' }}>
          {lane.name}
        </span>
        <span className="text-white/30 text-sm uppercase tracking-widest">
          {lane.mode === 'RU' ? 'Run-Up' : 'Net'}
        </span>
      </div>

      {/* Now */}
      <div className="flex-1 flex flex-col items-center justify-center text-center px-3 py-4 gap-2">
        {current ? (
          <>
            <span className="text-rose-400 font-bold uppercase tracking-[0.2em]" style={{ fontSize: 'clamp(0.7rem,1vw,0.95rem)' }}>
              In use
            </span>
            <span className="font-extrabold leading-tight text-white break-words" style={{ fontSize: 'clamp(1.4rem,3vw,3rem)' }}>
              {current.name}
            </span>
            <span className="text-white/60" style={{ fontSize: 'clamp(0.9rem,1.5vw,1.4rem)' }}>
              {fmtTime(current.startHour)} – {fmtTime(current.endHour)}
              {current.isCoach && <span className="ml-2 text-purple-300">· Coaching</span>}
            </span>
          </>
        ) : (
          <>
            <span className="text-emerald-400 font-extrabold uppercase tracking-[0.15em]" style={{ fontSize: 'clamp(1.1rem,2.2vw,2rem)' }}>
              Available
            </span>
          </>
        )}
      </div>

      {/* Next up */}
      <div className="px-4 py-3 border-t border-white/10 min-h-[3.2rem] flex items-center">
        {next ? (
          <span className="text-white/70 truncate" style={{ fontSize: 'clamp(0.8rem,1.3vw,1.15rem)' }}>
            <span className="text-white/40 uppercase tracking-wider text-[0.7em] mr-2">Next</span>
            {fmtTime(next.startHour)} · {next.name}
          </span>
        ) : (
          <span className="text-white/25" style={{ fontSize: 'clamp(0.8rem,1.3vw,1.15rem)' }}>
            <span className="text-white/30 uppercase tracking-wider text-[0.7em] mr-2">Next</span>
            —
          </span>
        )}
      </div>
    </div>
  )
}

function Shell({ children, clock, date }: { children: React.ReactNode; clock?: string; date?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0a0f1f] text-white overflow-hidden font-sans">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <span className="text-3xl">🏏</span>
          <div className="flex flex-col leading-none">
            <span className="font-black text-red-500 tracking-tight" style={{ fontSize: 'clamp(1.1rem,2vw,1.8rem)' }}>
              Cricket Revolution
            </span>
            <span className="text-white/40 uppercase tracking-[0.25em] text-xs mt-1">Lane Status</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-black tabular-nums leading-none" style={{ fontSize: 'clamp(1.6rem,3.5vw,3.2rem)' }}>
            {clock ?? ''}
          </div>
          <div className="text-white/40 mt-1" style={{ fontSize: 'clamp(0.7rem,1.2vw,1rem)' }}>
            {date ?? ''}
          </div>
        </div>
      </header>
      {children}
    </div>
  )
}
