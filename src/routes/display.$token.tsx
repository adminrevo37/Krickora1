// Public TV "lane status" board — full-screen, no login, auto-updating.
// Loaded by the facility display (Raspberry Pi kiosk) at /display/<25-char-token>.
// The token is checked server-side by api.display.getLaneDisplay; a wrong token
// shows an "invalid link" message, never booking data. See cricket/lane-display.
//
// LAYOUT: website-style calendar grid — lanes as columns, time down the side,
// bookings as colour-coded blocks (blue = net / amber = run-up / purple =
// coaching), a red "now" line, and an "OPEN" chip on any lane that's free right
// now. The grid auto-scrolls so the now line stays near the top: finished
// bookings slide off and the next ones sit just below the line. Updates live via
// Convex (data changes) + a clock tick (time-based current/next + scroll).
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

const PX_PER_HOUR = 96
const GUTTER = 58

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

// Compact whole-hour label for the time gutter, e.g. "10am", "1pm".
function fmtHourLabel(h: number): string {
  const ampm = h >= 12 && h < 24 ? 'pm' : 'am'
  let h12 = h % 12
  if (h12 === 0) h12 = 12
  return `${h12}${ampm}`
}

function fmtDateLong(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
  })
}

function laneAccent(lane: Lane): string {
  return lane.mode === 'RU' ? 'text-amber-300' : 'text-sky-300'
}

// Block colour: coaching overrides the lane mode (purple); else net = blue, run-up = amber.
function blockColors(lane: Lane, b: Booking): { bg: string; name: string; sub: string } {
  if (b.isCoach) return { bg: '#6d28d9', name: '#f5f3ff', sub: '#c4b5fd' }
  if (lane.mode === 'RU') return { bg: '#b45309', name: '#fffbeb', sub: '#fcd34d' }
  return { bg: '#0369a1', name: '#e0f2fe', sub: '#7dd3fc' }
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

  if (data === undefined) {
    return (
      <Shell>
        <div className="flex-1 flex items-center justify-center text-2xl text-white/50">
          Loading lane status…
        </div>
      </Shell>
    )
  }
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
      <LaneGrid lanes={lanes} hour={now.hour} />
    </Shell>
  )
}

function LaneGrid({ lanes, hour }: { lanes: Lane[]; hour: number }) {
  const all = lanes.flatMap((l) => l.bookings)
  const gridStart = Math.min(7, Math.floor(all.length ? Math.min(...all.map((b) => b.startHour)) : 7))
  const gridEnd = Math.max(21, Math.ceil(all.length ? Math.max(...all.map((b) => b.endHour)) : 21))
  const contentH = (gridEnd - gridStart) * PX_PER_HOUR

  const hours: number[] = []
  for (let h = gridStart; h <= gridEnd; h++) hours.push(h)

  // Auto-scroll: keep the now line ~1 hour from the top of the viewport.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [viewH, setViewH] = useState(0)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setViewH(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const desired = (hour - gridStart) * PX_PER_HOUR - PX_PER_HOUR
  const maxOff = Math.max(0, contentH - viewH)
  const offset = Math.min(maxOff, Math.max(0, desired))
  const nowTop = (hour - gridStart) * PX_PER_HOUR

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Lane-name header row (fixed above the scrolling grid) */}
      <div className="flex border-b border-white/10">
        <div style={{ flex: `0 0 ${GUTTER}px` }} />
        {lanes.map((lane) => (
          <div key={lane.laneId} className="flex-1 text-center py-2.5 flex flex-col items-center">
            <span className={`font-black tracking-tight ${laneAccent(lane)}`} style={{ fontSize: 'clamp(1.1rem,2vw,1.9rem)' }}>
              {lane.name}
            </span>
            <span className="text-white/30 uppercase tracking-widest" style={{ fontSize: 'clamp(0.55rem,0.8vw,0.8rem)' }}>
              {lane.mode === 'RU' ? 'Run-Up' : 'Net'}
            </span>
          </div>
        ))}
      </div>

      {/* Scrolling grid viewport */}
      <div ref={wrapRef} className="relative flex-1 overflow-hidden">
        <div
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${-offset}px)`, transition: 'transform 1.2s linear', height: contentH }}
        >
          <div className="flex" style={{ height: contentH }}>
            {/* Time gutter */}
            <div style={{ flex: `0 0 ${GUTTER}px`, position: 'relative' }}>
              {hours.map((h) => (
                <div
                  key={h}
                  className="text-white/40 pl-2"
                  style={{ position: 'absolute', top: (h - gridStart) * PX_PER_HOUR - 8, fontSize: 'clamp(0.7rem,1vw,0.95rem)' }}
                >
                  {fmtHourLabel(h)}
                </div>
              ))}
            </div>

            {/* Lane columns */}
            <div className="flex-1 relative">
              {/* hour gridlines */}
              {hours.map((h) => (
                <div
                  key={h}
                  className="border-t border-white/[0.06]"
                  style={{ position: 'absolute', top: (h - gridStart) * PX_PER_HOUR, left: 0, right: 0 }}
                />
              ))}

              <div className="flex h-full">
                {lanes.map((lane) => {
                  const current = lane.bookings.find((b) => b.startHour <= hour && hour < b.endHour - 1e-6)
                  return (
                    <div key={lane.laneId} className="flex-1 relative border-l border-white/[0.06]">
                      {lane.bookings.map((b, i) => {
                        const top = (b.startHour - gridStart) * PX_PER_HOUR
                        const h = (b.endHour - b.startHour) * PX_PER_HOUR
                        const isNow = b === current
                        const c = blockColors(lane, b)
                        return (
                          <div
                            key={i}
                            className="rounded-lg overflow-hidden"
                            style={{
                              position: 'absolute',
                              top,
                              height: Math.max(20, h - 3),
                              left: 4,
                              right: 4,
                              background: c.bg,
                              padding: '6px 8px',
                              boxShadow: isNow ? '0 0 0 2px #fff inset' : undefined,
                            }}
                          >
                            <div style={{ color: c.name, fontWeight: 700, lineHeight: 1.15, fontSize: 'clamp(0.85rem,1.3vw,1.25rem)' }}>
                              {b.name}
                            </div>
                            <div style={{ color: c.sub, fontSize: 'clamp(0.65rem,1vw,0.95rem)' }}>
                              {fmtTime(b.startHour)} – {fmtTime(b.endHour)}
                              {b.isCoach && ' · Coaching'}
                            </div>
                          </div>
                        )
                      })}

                      {/* OPEN chip on the now line if this lane is free right now */}
                      {!current && (
                        <div
                          style={{ position: 'absolute', top: nowTop + 6, left: 6, right: 6 }}
                          className="flex justify-center"
                        >
                          <span
                            className="rounded-md bg-emerald-500/15 text-emerald-300 font-bold uppercase tracking-widest"
                            style={{ padding: '2px 10px', fontSize: 'clamp(0.6rem,0.9vw,0.85rem)' }}
                          >
                            Open
                          </span>
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* NOW line spanning all lanes */}
                <div
                  style={{ position: 'absolute', top: nowTop, left: 0, right: 0, borderTop: '2px solid #f43f5e', zIndex: 5 }}
                />
                <div
                  className="bg-rose-500 text-white font-bold rounded"
                  style={{ position: 'absolute', top: nowTop - 11, left: 4, zIndex: 6, padding: '2px 9px', fontSize: 'clamp(0.6rem,0.9vw,0.85rem)' }}
                >
                  NOW · {fmtTime(hour)}
                </div>
              </div>
            </div>
          </div>
        </div>
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
        <div className="text-right flex flex-col items-end leading-none">
          <div className="font-black tabular-nums" style={{ fontSize: 'clamp(2.8rem,7vw,7rem)', letterSpacing: '-0.02em' }}>
            {clock ?? ''}
          </div>
          <div className="text-white/45 mt-2" style={{ fontSize: 'clamp(0.85rem,1.6vw,1.5rem)' }}>
            {date ?? ''}
          </div>
        </div>
      </header>
      {children}
    </div>
  )
}
