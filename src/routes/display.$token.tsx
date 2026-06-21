// Public TV "lane status" board — full-screen, no login, auto-updating.
// Loaded by the facility display (Raspberry Pi kiosk) at /display/<25-char-token>.
// The token is checked server-side by api.display.getLaneDisplay; a wrong token
// shows an "invalid link" message, never booking data. See cricket/lane-display.
//
// LAYOUT: a large centred clock fills the top half of the screen; the bottom half
// is a compact lane board showing ONLY the current hour + the next hour (lanes as
// columns, blocks colour-coded blue = net / amber = run-up / purple = coaching),
// with a red "now" line and an OPEN chip on any lane free right now. No scrolling
// — the 2-hour window re-centres on the clock each tick. Updates live via Convex
// (data changes) + a 15s clock tick (time-based window/current/next).
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

const GUTTER = 64
const WINDOW_HOURS = 2 // show the current hour + the next hour

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

function fmtHourLabel(h: number): string {
  const hh = ((h % 24) + 24) % 24
  const ampm = hh >= 12 ? 'pm' : 'am'
  let h12 = hh % 12
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
    return <Centered>Loading lane status…</Centered>
  }
  if (!data.ok) {
    return (
      <Centered>
        <div className="text-5xl mb-3">🔒</div>
        This display link isn’t valid.
      </Centered>
    )
  }

  const lanes = [...data.lanes].sort((a, b) => a.order - b.order)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0a0f1f] text-white overflow-hidden font-sans">
      {/* Top half — big centred clock */}
      <div style={{ flex: '1 1 50%' }} className="relative flex flex-col items-center justify-center border-b border-white/10 min-h-0">
        <div className="absolute left-6 top-5 flex items-center gap-2">
          <span className="text-2xl">🏏</span>
          <span className="font-black text-red-500 tracking-tight" style={{ fontSize: 'clamp(0.9rem,1.5vw,1.6rem)' }}>
            Cricket Revolution
          </span>
        </div>
        <div className="font-black tabular-nums leading-none whitespace-nowrap" style={{ fontSize: 'clamp(7rem, min(42vh, 21.5vw), 34rem)', letterSpacing: '-0.02em' }}>
          {now.clock}
        </div>
        <div className="text-white/45" style={{ fontSize: 'clamp(1rem,3vh,2.4rem)', marginTop: 'clamp(0.5rem,1.5vh,1.5rem)' }}>
          {fmtDateLong(data.date)}
        </div>
      </div>

      {/* Bottom half — current hour + next hour */}
      <div style={{ flex: '1 1 50%' }} className="flex flex-col min-h-0">
        <HourBoard lanes={lanes} hour={now.hour} />
      </div>
    </div>
  )
}

function HourBoard({ lanes, hour }: { lanes: Lane[]; hour: number }) {
  const gridStart = Math.floor(hour)
  const gridEnd = gridStart + WINDOW_HOURS

  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyH, setBodyH] = useState(0)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const update = () => setBodyH(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pph = bodyH > 0 ? bodyH / WINDOW_HOURS : 130
  const nowTop = (hour - gridStart) * pph
  const lineHours: number[] = []
  for (let h = gridStart; h <= gridEnd; h++) lineHours.push(h)

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Lane headers */}
      <div className="flex border-b border-white/10">
        <div style={{ flex: `0 0 ${GUTTER}px` }} />
        {lanes.map((lane) => (
          <div key={lane.laneId} className="flex-1 text-center py-2 flex flex-col items-center">
            <span className={`font-black tracking-tight ${laneAccent(lane)}`} style={{ fontSize: 'clamp(1.1rem,2.2vw,2.2rem)' }}>
              {lane.name}
            </span>
            <span className="text-white/30 uppercase tracking-widest" style={{ fontSize: 'clamp(0.55rem,0.9vw,0.9rem)' }}>
              {lane.mode === 'RU' ? 'Run-Up' : 'Net'}
            </span>
          </div>
        ))}
      </div>

      {/* 2-hour body */}
      <div ref={bodyRef} className="relative flex-1 overflow-hidden">
        <div className="flex" style={{ height: pph * WINDOW_HOURS }}>
          {/* Time gutter */}
          <div style={{ flex: `0 0 ${GUTTER}px`, position: 'relative' }}>
            {lineHours.map((h) => (
              <div
                key={h}
                className="text-white/45 pl-2"
                style={{ position: 'absolute', top: (h - gridStart) * pph - 9, fontSize: 'clamp(0.8rem,1.2vw,1.2rem)' }}
              >
                {fmtHourLabel(h)}
              </div>
            ))}
          </div>

          {/* Lane columns */}
          <div className="flex-1 relative">
            {lineHours.map((h) => (
              <div
                key={h}
                className="border-t border-white/[0.07]"
                style={{ position: 'absolute', top: (h - gridStart) * pph, left: 0, right: 0 }}
              />
            ))}

            <div className="flex h-full">
              {lanes.map((lane) => {
                const current = lane.bookings.find((b) => b.startHour <= hour && hour < b.endHour - 1e-6)
                const visible = lane.bookings.filter((b) => b.endHour > gridStart + 1e-6 && b.startHour < gridEnd - 1e-6)
                return (
                  <div key={lane.laneId} className="flex-1 relative border-l border-white/[0.06]">
                    {visible.flatMap((b, i) => {
                      const c = blockColors(lane, b)
                      if (b.isCoach) {
                        // One block per visible hour slot — never reveals full booking extent
                        const slots: React.ReactElement[] = []
                        for (let slotH = gridStart; slotH < gridEnd; slotH++) {
                          if (b.startHour >= slotH + 1 || b.endHour <= slotH) continue
                          const isNow = slotH <= hour && hour < slotH + 1
                          slots.push(
                            <div
                              key={`${i}-${slotH}`}
                              className="rounded-lg overflow-hidden"
                              style={{
                                position: 'absolute',
                                top: (slotH - gridStart) * pph + 2,
                                height: Math.max(24, pph - 8),
                                left: 5,
                                right: 5,
                                background: c.bg,
                                padding: '8px 10px',
                                boxShadow: isNow ? '0 0 0 3px #fff inset' : undefined,
                              }}
                            >
                              <div style={{ color: c.name, fontWeight: 700, lineHeight: 1.15, fontSize: 'clamp(1rem,1.7vw,1.7rem)' }}>
                                {b.name}
                              </div>
                              <div style={{ color: c.sub, fontSize: 'clamp(0.75rem,1.1vw,1.15rem)' }}>
                                Coaching
                              </div>
                            </div>
                          )
                        }
                        return slots
                      }
                      const top = (Math.max(b.startHour, gridStart) - gridStart) * pph
                      const h = (Math.min(b.endHour, gridEnd) - Math.max(b.startHour, gridStart)) * pph
                      const isNow = b === current
                      return [(
                        <div
                          key={i}
                          className="rounded-lg overflow-hidden"
                          style={{
                            position: 'absolute',
                            top,
                            height: Math.max(24, h - 4),
                            left: 5,
                            right: 5,
                            background: c.bg,
                            padding: '8px 10px',
                            boxShadow: isNow ? '0 0 0 3px #fff inset' : undefined,
                          }}
                        >
                          <div style={{ color: c.name, fontWeight: 700, lineHeight: 1.15, fontSize: 'clamp(1rem,1.7vw,1.7rem)' }}>
                            {b.name}
                          </div>
                          <div style={{ color: c.sub, fontSize: 'clamp(0.75rem,1.1vw,1.15rem)' }}>
                            {`${fmtTime(b.startHour)} – ${fmtTime(b.endHour)}`}
                          </div>
                        </div>
                      )]
                    })}

                    {!current && (
                      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} className="flex items-center justify-center">
                        <span
                          className="rounded-md bg-emerald-500/15 text-emerald-300 font-bold uppercase tracking-widest"
                          style={{ padding: '4px 16px', fontSize: 'clamp(0.8rem,1.3vw,1.4rem)' }}
                        >
                          Open
                        </span>
                      </div>
                    )}
                  </div>
                )
              })}

              {/* NOW line */}
              <div style={{ position: 'absolute', top: nowTop, left: 0, right: 0, borderTop: '2px solid #f43f5e', zIndex: 5 }} />
              <div
                className="bg-rose-500 text-white font-bold rounded"
                style={{ position: 'absolute', top: nowTop - 12, left: 5, zIndex: 6, padding: '2px 10px', fontSize: 'clamp(0.7rem,1vw,1.05rem)' }}
              >
                NOW · {fmtTime(hour)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0a0f1f] text-white text-3xl text-white/60 text-center px-6 font-sans">
      {children}
    </div>
  )
}
