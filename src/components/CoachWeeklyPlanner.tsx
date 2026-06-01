import { useState, useMemo, useRef, useCallback } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import { useAuth } from '../hooks/useAuth'
import { useBookings } from '../hooks/useBookingStore'
import {
  LANES, formatTime, formatDateKey, formatDayLabel, getAWSTNow, getCoachPrice,
  getValidCoachStartTimes, getCoachDurations, canBookSlot, isToday,
  type Booking, type AthleteSlot,
} from '../lib/booking-data'
import { getSettingsStore, getHoursForDate } from '../lib/settings-store'
import AthleteAllocationEditor from './AthleteAllocationEditor'

const HOUR_PX = 60 // vertical pixels per hour
const SNAP = 0.25   // 15-minute snap
const snap = (h: number) => Math.round(h / SNAP) * SNAP

// Stable colour per lane so blocks are visually distinguishable.
const LANE_COLOR: Record<string, string> = {
  bm1: 'bg-orange-500', bm2: 'bg-blue-500', bm3: 'bg-purple-500',
  ru1: 'bg-emerald-500', ru2: 'bg-pink-500',
}
const laneShort = (id: string) => LANES.find(l => l.id === id)?.shortName ?? id.toUpperCase()

type DragState = {
  bookingId: string
  mode: 'move' | 'resize'
  origStartHour: number
  origDuration: number
  origDayIndex: number
  dayIndex: number
  startHour: number
  duration: number
}

export default function CoachWeeklyPlanner() {
  const { user, isCoach, isAdmin, customerRecord } = useAuth()
  const {
    bookings, addBooking, rescheduleBooking, editBookingDuration, cancelBooking, updateAthleteSlots,
  } = useBookings()

  const coachId = (customerRecord as any)?._id ?? user?.email ?? ''
  const coachEmail = (user?.email ?? (customerRecord as any)?.email ?? '').toLowerCase()
  const settings = getSettingsStore().get()

  const athletes = useQuery(api.queries.listAthletesByCoach, coachId ? { coachId } : 'skip')
  const addAthleteToCoach = useMutation(api.athletes.addAthleteToCoach)
  const removeAthleteFromCoach = useMutation(api.athletes.removeAthleteFromCoach)
  const copyCoachWeek = useMutation(api.mutations.copyCoachWeek)

  const [weekOffset, setWeekOffset] = useState(0)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [selected, setSelected] = useState<Booking | null>(null)
  const [allocating, setAllocating] = useState<Booking | null>(null)
  const [createAt, setCreateAt] = useState<{ dayIndex: number; startHour: number } | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [copyBusy, setCopyBusy] = useState(false)
  const [showRoster, setShowRoster] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)

  // ── week model: Mon–Sun, navigable ──
  const baseMonday = useMemo(() => {
    const t = getAWSTNow(); t.setHours(0, 0, 0, 0)
    const offsetToMon = (t.getDay() + 6) % 7
    const mon = new Date(t); mon.setDate(t.getDate() - offsetToMon)
    return mon
  }, [])
  const visibleDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => {
      const d = new Date(baseMonday); d.setDate(baseMonday.getDate() + i + weekOffset * 7); return d
    }),
    [baseMonday, weekOffset],
  )

  // grid vertical bounds = widest open/close across the visible week
  const { gridOpen, gridClose } = useMemo(() => {
    let open = 24, close = 0
    for (const d of visibleDays) {
      const h = getHoursForDate(settings, d)
      if (h.closed) continue
      open = Math.min(open, h.open)
      close = Math.max(close, h.close)
    }
    if (open >= close) { open = 7; close = 21 }
    return { gridOpen: open, gridClose: close }
  }, [visibleDays, settings])

  const hourRows = useMemo(() => {
    const rows: number[] = []
    for (let h = gridOpen; h <= gridClose; h++) rows.push(h)
    return rows
  }, [gridOpen, gridClose])

  const isMine = useCallback(
    (b: Booking) => b.isCoachBooking && b.customerEmail?.toLowerCase() === coachEmail,
    [coachEmail],
  )

  // bookings indexed by day key for the visible week
  const dayKeys = useMemo(() => visibleDays.map(formatDateKey), [visibleDays])
  const weekBookings = useMemo(
    () => bookings.filter(b => b.status !== 'cancelled' && dayKeys.includes(b.date)),
    [bookings, dayKeys],
  )

  const yToHour = (clientY: number) => {
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return gridOpen
    const rel = clientY - rect.top
    return snap(gridOpen + rel / HOUR_PX)
  }
  const xToDayIndex = (clientX: number) => {
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return 0
    const col = Math.floor(((clientX - rect.left) / rect.width) * 7)
    return Math.max(0, Math.min(6, col))
  }

  // ── drag (move / resize) ──
  const beginDrag = (e: React.PointerEvent, b: Booking, mode: 'move' | 'resize', dayIndex: number) => {
    e.stopPropagation()
    e.preventDefault()
    setSelected(null)
    setCreateAt(null)
    const state: DragState = {
      bookingId: b.id, mode,
      origStartHour: b.startHour, origDuration: b.duration, origDayIndex: dayIndex,
      dayIndex, startHour: b.startHour, duration: b.duration,
    }
    setDrag(state)
    const move = (ev: PointerEvent) => {
      setDrag(prev => {
        if (!prev) return prev
        if (mode === 'resize') {
          const endHour = Math.max(prev.startHour + 0.5, yToHour(ev.clientY))
          const dur = Math.min(Math.round((endHour - prev.startHour) * 60), Math.round((gridClose - prev.startHour) * 60))
          return { ...prev, duration: Math.max(30, dur) }
        }
        const newStart = Math.max(gridOpen, Math.min(yToHour(ev.clientY), gridClose - prev.duration / 60))
        return { ...prev, startHour: newStart, dayIndex: xToDayIndex(ev.clientX) }
      })
    }
    const up = async () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(prev => { void commitDrag(prev, b); return null })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const commitDrag = async (state: DragState | null, b: Booking) => {
    if (!state || !user) return
    const changed = state.mode === 'resize'
      ? state.duration !== state.origDuration
      : state.startHour !== state.origStartHour || state.dayIndex !== state.origDayIndex
    if (!changed) return
    if (state.mode === 'resize') {
      const res = await editBookingDuration(b.id, state.duration, user.id)
      flash(res, `Duration updated to ${state.duration}min`)
    } else {
      const newDate = formatDateKey(visibleDays[state.dayIndex])
      const res = await rescheduleBooking(b.id, {
        newDate, newStartHour: state.startHour, newDuration: b.duration, userId: user.id,
      })
      flash(res, `Moved to ${formatDayLabel(visibleDays[state.dayIndex])} ${formatTime(state.startHour)}`)
    }
  }

  const flash = (res: { success: boolean; error?: string }, okText: string) => {
    if (res.success) setBanner({ kind: 'ok', text: okText })
    else setBanner({ kind: 'err', text: res.error ?? 'Action failed.' })
    setTimeout(() => setBanner(null), 4000)
  }

  // ── create a coach booking inline ──
  const handleCreate = async (laneId: string, dayIndex: number, startHour: number, duration: number) => {
    if (!user) return
    const dateKey = formatDateKey(visibleDays[dayIndex])
    if (!canBookSlot(weekBookings, laneId, dateKey, startHour, duration)) {
      flash({ success: false, error: 'That slot is not available.' }, '')
      return
    }
    const accessCode = String(1000 + Math.floor(Math.random() * 9000))
    const booking: Booking = {
      id: crypto.randomUUID(),
      laneId, variantId: null, date: dateKey, startHour, duration,
      customerName: user.name, customerEmail: user.email, customerPhone: user.phone,
      userId: user.id, status: 'confirmed', isCoachBooking: true,
      coachPrice: getCoachPrice(duration), accessCode,
    }
    try {
      await addBooking(booking)
      setBanner({ kind: 'ok', text: `Booked ${laneShort(laneId)} ${formatTime(startHour)}` })
      setTimeout(() => setBanner(null), 4000)
    } catch (err: any) {
      setBanner({ kind: 'err', text: getErrorMessage(err) ?? 'Booking failed.' })
    }
    setCreateAt(null)
  }

  const handleCancel = async (b: Booking) => {
    if (!confirm(`Cancel this ${laneShort(b.laneId)} session? Allocated athletes will be notified.`)) return
    const ok = await cancelBooking(b.id, user?.id)
    flash({ success: ok, error: ok ? undefined : 'Could not cancel (check the cancellation window).' }, 'Session cancelled')
    setSelected(null)
  }

  const handleSaveAlloc = async (slots: AthleteSlot[], opts?: { confirmedOverride?: boolean }) => {
    if (!allocating || !user) return { success: false, error: 'Not signed in.' }
    return await updateAthleteSlots(allocating.id, slots, user.id, opts?.confirmedOverride)
  }

  const runCopyLastWeek = async () => {
    if (!coachId) return
    setCopyBusy(true)
    setBanner(null)
    try {
      const fromWeekStart = formatDateKey(new Date(visibleDays[0].getTime() - 7 * 86400000))
      const toWeekStart = formatDateKey(visibleDays[0])
      const res: any = await copyCoachWeek({ coachId, fromWeekStart, toWeekStart })
      const created = res?.created?.length ?? 0
      const skipped = res?.skipped ?? []
      const skipText = skipped.length
        ? ` Skipped ${skipped.length}: ` + skipped.slice(0, 3).map((s: any) => `${s.date} ${formatTime(s.startHour)} (${s.reason})`).join('; ')
        : ''
      setBanner({ kind: created > 0 ? 'ok' : 'err', text: `Rebooked ${created} of ${res?.sourceCount ?? 0}.${skipText}` })
    } catch (err: any) {
      setBanner({ kind: 'err', text: getErrorMessage(err) ?? 'Copy failed.' })
    } finally {
      setCopyBusy(false)
      setTimeout(() => setBanner(null), 8000)
    }
  }

  if (!user || (!isCoach && !isAdmin)) {
    return (
      <div className="max-w-md mx-auto mt-16 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 text-center">
        <div className="text-4xl mb-3">📋</div>
        <h2 className="text-lg font-bold text-gray-800 dark:text-gray-200 mb-1">Coach Planner</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">This planner is available to coaches only.</p>
      </div>
    )
  }

  const weekLabel = `${visibleDays[0].toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} – ${visibleDays[6].toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`

  return (
    <div className="max-w-6xl mx-auto px-2 sm:px-4 py-4 space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-200">📋 Weekly Planner</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">Your sessions only · drag to move, drag the bottom edge to resize</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowRoster(s => !s)} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">
            👥 My Athletes
          </button>
          <button onClick={runCopyLastWeek} disabled={copyBusy} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-orange-500 hover:bg-orange-600 text-white disabled:opacity-60">
            {copyBusy ? 'Copying…' : '⧉ Copy last week'}
          </button>
        </div>
      </div>

      {/* Week nav */}
      <div className="flex items-center justify-center gap-3">
        <button onClick={() => setWeekOffset(o => o - 1)} className="px-3 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-sm hover:bg-gray-100 dark:hover:bg-gray-800">←</button>
        <button onClick={() => setWeekOffset(0)} className="text-sm font-semibold text-gray-700 dark:text-gray-300 min-w-[10rem] text-center">
          {weekOffset === 0 ? 'This week' : weekLabel}
        </button>
        <button onClick={() => setWeekOffset(o => o + 1)} className="px-3 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-sm hover:bg-gray-100 dark:hover:bg-gray-800">→</button>
      </div>

      {banner && (
        <div className={`rounded-lg px-3 py-2 text-xs ${banner.kind === 'ok' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/50' : 'bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/50'}`}>
          {banner.text}
        </div>
      )}

      {showRoster && (
        <RosterPanel
          athletes={athletes}
          coachId={coachId}
          addAthleteToCoach={addAthleteToCoach}
          removeAthleteFromCoach={removeAthleteFromCoach}
        />
      )}

      {/* Calendar */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        <div className="min-w-[700px]">
          {/* Day headers */}
          <div className="grid" style={{ gridTemplateColumns: `3rem repeat(7, 1fr)` }}>
            <div className="border-b border-gray-200 dark:border-gray-800" />
            {visibleDays.map((d, i) => (
              <div key={i} className={`text-center py-2 border-b border-l border-gray-200 dark:border-gray-800 ${isToday(d) ? 'bg-orange-50 dark:bg-orange-900/10' : ''}`}>
                <div className="text-xs font-bold text-gray-700 dark:text-gray-300">{formatDayLabel(d)}</div>
                <div className="text-[10px] text-gray-400">{d.getDate()}</div>
              </div>
            ))}
          </div>

          {/* Time grid */}
          <div className="grid" style={{ gridTemplateColumns: `3rem repeat(7, 1fr)` }}>
            {/* time gutter */}
            <div>
              {hourRows.map(h => (
                <div key={h} className="text-[9px] text-gray-400 text-right pr-1 border-b border-gray-100 dark:border-gray-800/60" style={{ height: HOUR_PX }}>
                  {formatTime(h)}
                </div>
              ))}
            </div>

            {/* day columns */}
            <div ref={gridRef} className="col-span-7 grid relative" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
              {visibleDays.map((day, dayIndex) => {
                const dateKey = dayKeys[dayIndex]
                const dayHours = getHoursForDate(settings, day)
                const dayBookings = weekBookings.filter(b => b.date === dateKey)
                return (
                  <div
                    key={dayIndex}
                    className="relative border-l border-gray-200 dark:border-gray-800"
                    style={{ height: hourRows.length * HOUR_PX }}
                    onClick={(e) => {
                      if (drag) return
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      const hour = snap(gridOpen + (e.clientY - rect.top) / HOUR_PX)
                      if (dayHours.closed || hour < dayHours.open || hour >= dayHours.close) return
                      setSelected(null)
                      setCreateAt({ dayIndex, startHour: Math.floor(hour) + (hour % 1 >= 0.5 ? 0.5 : 0) })
                    }}
                  >
                    {/* hour lines + closed shading */}
                    {hourRows.map((h, i) => {
                      const closed = dayHours.closed || h < dayHours.open || h >= dayHours.close
                      return <div key={i} className={`border-b border-gray-100 dark:border-gray-800/60 ${closed ? 'bg-gray-100/70 dark:bg-gray-800/40' : ''}`} style={{ height: HOUR_PX }} />
                    })}

                    {/* bookings */}
                    {dayBookings.map(b => {
                      const mine = isMine(b)
                      const live = drag && drag.bookingId === b.id
                      const sh = live ? drag!.startHour : b.startHour
                      const dur = live ? drag!.duration : b.duration
                      const di = live ? drag!.dayIndex : dayIndex
                      if (live && di !== dayIndex) return null // render in the dragged-over column instead
                      const top = (sh - gridOpen) * HOUR_PX
                      const height = (dur / 60) * HOUR_PX
                      if (!mine) {
                        return (
                          <div key={b.id} className="absolute left-0.5 right-0.5 rounded bg-gray-200/80 dark:bg-gray-700/50 border border-gray-300 dark:border-gray-600 overflow-hidden" style={{ top, height }}>
                            <div className="text-[8px] text-gray-500 dark:text-gray-400 px-1 pt-0.5 truncate">Booked · {laneShort(b.laneId)}</div>
                          </div>
                        )
                      }
                      return (
                        <div
                          key={b.id}
                          onPointerDown={(e) => beginDrag(e, b, 'move', dayIndex)}
                          onClick={(e) => { e.stopPropagation(); if (!drag) { setSelected(b); setCreateAt(null) } }}
                          className={`absolute left-0.5 right-0.5 rounded-md text-white shadow-sm overflow-hidden cursor-grab active:cursor-grabbing ${LANE_COLOR[b.laneId] ?? 'bg-gray-500'} ${selected?.id === b.id ? 'ring-2 ring-white' : ''}`}
                          style={{ top, height }}
                        >
                          <div className="px-1 pt-0.5 text-[9px] font-bold leading-tight truncate">{laneShort(b.laneId)} · {formatTime(sh)}</div>
                          {/* athlete sub-bars */}
                          <div className="relative mx-1 mt-0.5" style={{ height: Math.max(0, height - 18) }}>
                            {(b.athleteSlots ?? []).map((s, si) => {
                              const sTop = ((s.startHour - b.startHour) / (b.duration / 60)) * (height - 18)
                              const sH = (s.durationMinutes / b.duration) * (height - 18)
                              return (
                                <div key={si} className="absolute left-0 right-0 bg-white/30 rounded-sm text-[8px] px-1 truncate" style={{ top: sTop, height: Math.max(8, sH) }}>
                                  {s.athleteName.split(' ')[0]}
                                </div>
                              )
                            })}
                          </div>
                          {/* resize handle */}
                          <div
                            onPointerDown={(e) => beginDrag(e, b, 'resize', dayIndex)}
                            className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize bg-black/10"
                            title="Drag to resize"
                          />
                        </div>
                      )
                    })}

                    {/* dragged ghost from another column lands here */}
                    {drag && drag.dayIndex === dayIndex && (() => {
                      const b = weekBookings.find(x => x.id === drag.bookingId)
                      if (!b || drag.origDayIndex === dayIndex) return null
                      const top = (drag.startHour - gridOpen) * HOUR_PX
                      const height = (drag.duration / 60) * HOUR_PX
                      return <div className={`absolute left-0.5 right-0.5 rounded-md opacity-70 ${LANE_COLOR[b.laneId] ?? 'bg-gray-500'}`} style={{ top, height }} />
                    })()}

                    {/* inline create popover */}
                    {createAt && createAt.dayIndex === dayIndex && (
                      <CreatePopover
                        day={day}
                        startHour={createAt.startHour}
                        bookings={weekBookings}
                        onClose={() => setCreateAt(null)}
                        onCreate={(laneId, startHour, duration) => handleCreate(laneId, dayIndex, startHour, duration)}
                        topPx={(createAt.startHour - gridOpen) * HOUR_PX}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Selected booking actions */}
      {selected && (
        <BookingActions
          booking={selected}
          onClose={() => setSelected(null)}
          onAllocate={() => { setAllocating(selected); setSelected(null) }}
          onCancel={() => handleCancel(selected)}
          onChangeDuration={async (d) => { if (user) { flash(await editBookingDuration(selected.id, d, user.id), `Duration set to ${d}min`); setSelected(null) } }}
          gridClose={gridClose}
        />
      )}

      {/* Allocation editor */}
      {allocating && (
        <AthleteAllocationEditor
          bookingStartHour={allocating.startHour}
          bookingDuration={allocating.duration}
          currentSlots={allocating.athleteSlots ?? []}
          coachId={coachId}
          onSave={handleSaveAlloc}
          onClose={() => setAllocating(null)}
          defaultSessionDuration={(customerRecord as any)?.defaultSessionDuration ?? undefined}
          athleteCapacity={(customerRecord as any)?.athleteCapacity ?? undefined}
        />
      )}
    </div>
  )
}

// ── inline create popover ──
function CreatePopover({ day, startHour, bookings, onClose, onCreate, topPx }: {
  day: Date; startHour: number; bookings: Booking[]
  onClose: () => void
  onCreate: (laneId: string, startHour: number, duration: number) => void
  topPx: number
}) {
  const dateKey = formatDateKey(day)
  const validStarts = getValidCoachStartTimes(day)
  const [laneId, setLaneId] = useState(LANES[0].id)
  const [start, setStart] = useState(validStarts.includes(startHour) ? startHour : (validStarts[0] ?? startHour))
  const durations = getCoachDurations(bookings, laneId, dateKey, start)
  const [duration, setDuration] = useState(durations[0] ?? 60)

  return (
    <div className="absolute left-1 right-1 z-30 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-2 space-y-1.5" style={{ top: Math.max(0, topPx) }} onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-gray-600 dark:text-gray-300">New session</span>
        <button onClick={onClose} className="text-gray-400 text-xs">✕</button>
      </div>
      <select value={laneId} onChange={e => setLaneId(e.target.value)} className="w-full text-[11px] px-1.5 py-1 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800">
        {LANES.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      <select value={start} onChange={e => setStart(parseFloat(e.target.value))} className="w-full text-[11px] px-1.5 py-1 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800">
        {validStarts.map(h => <option key={h} value={h}>{formatTime(h)}</option>)}
      </select>
      <select value={duration} onChange={e => setDuration(parseInt(e.target.value))} className="w-full text-[11px] px-1.5 py-1 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800">
        {(durations.length ? durations : [60]).map(d => <option key={d} value={d}>{d}min · ${getCoachPrice(d).toFixed(0)}</option>)}
      </select>
      <button onClick={() => onCreate(laneId, start, duration)} className="w-full py-1 bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-semibold rounded">Book</button>
    </div>
  )
}

// ── selected-booking action sheet ──
function BookingActions({ booking, onClose, onAllocate, onCancel, onChangeDuration, gridClose }: {
  booking: Booking
  onClose: () => void
  onAllocate: () => void
  onCancel: () => void
  onChangeDuration: (d: number) => void
  gridClose: number
}) {
  const maxDur = Math.round((gridClose - booking.startHour) * 60)
  const durOptions = [] as number[]
  for (let d = 30; d <= Math.min(maxDur, 600); d += 30) durOptions.push(d)
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 w-full max-w-sm p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-gray-800 dark:text-gray-200">{laneShort(booking.laneId)} · {formatTime(booking.startHour)}</h3>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {booking.date} · {booking.duration}min · {(booking.athleteSlots ?? []).length} athlete(s)
        </p>
        <button onClick={onAllocate} className="w-full py-2 text-sm font-semibold rounded-lg bg-orange-500 hover:bg-orange-600 text-white">🏏 Edit allocations</button>
        <label className="block text-xs text-gray-500 dark:text-gray-400">
          Change duration
          <select
            defaultValue={booking.duration}
            onChange={e => onChangeDuration(parseInt(e.target.value))}
            className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
          >
            {durOptions.map(d => <option key={d} value={d}>{d}min</option>)}
          </select>
        </label>
        <p className="text-[10px] text-gray-400">Tip: drag the block to move it, or drag its bottom edge to resize.</p>
        <button onClick={onCancel} className="w-full py-2 text-sm font-semibold rounded-lg border border-rose-200 dark:border-rose-800/50 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20">Cancel session</button>
      </div>
    </div>
  )
}

// ── roster panel (Part 4: list + add + remove) ──
function RosterPanel({ athletes, coachId, addAthleteToCoach, removeAthleteFromCoach }: {
  athletes: any[] | undefined
  coachId: string
  addAthleteToCoach: (a: { coachId: string; parentEmail: string; childName: string }) => Promise<any>
  removeAthleteFromCoach: (a: { coachId: string; athleteId: any }) => Promise<any>
}) {
  const [email, setEmail] = useState('')
  const [child, setChild] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const add = async () => {
    if (!email.trim() || !child.trim()) { setMsg('Enter both the parent email and athlete name.'); return }
    setBusy(true); setMsg(null)
    try {
      const res = await addAthleteToCoach({ coachId, parentEmail: email.trim(), childName: child.trim() })
      setMsg(res?.accountExists ? `Added ${child.trim()}.` : `Invite sent to ${email.trim()}.`)
      setEmail(''); setChild('')
    } catch (e: any) { setMsg(getErrorMessage(e) ?? 'Failed to add.') } finally { setBusy(false) }
  }
  const remove = async (id: string, name: string) => {
    if (!confirm(`Remove ${name} from your roster? Past bookings are unaffected.`)) return
    try { await removeAthleteFromCoach({ coachId, athleteId: id }) } catch (e: any) { alert(getErrorMessage(e) ?? 'Failed.') }
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-3 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
        <input value={child} onChange={e => setChild(e.target.value)} placeholder="Athlete name" className="px-2 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800" />
        <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="Parent / account email" className="px-2 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800" />
        <button onClick={add} disabled={busy} className="px-3 py-1.5 text-sm font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-60">{busy ? 'Adding…' : 'Add'}</button>
      </div>
      {msg && <p className="text-[11px] text-gray-600 dark:text-gray-300">{msg}</p>}
      <div className="flex flex-wrap gap-1.5">
        {(athletes ?? []).map((a: any) => (
          <span key={a._id} className="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-full pl-2.5 pr-1 py-0.5 text-xs text-gray-700 dark:text-gray-300">
            {a.name}
            {!a.isSelf && (
              <button onClick={() => remove(a._id, a.name)} className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-rose-100 dark:hover:bg-rose-900/30 text-rose-500" title="Remove">×</button>
            )}
          </span>
        ))}
        {athletes !== undefined && athletes.length === 0 && <span className="text-xs text-gray-400">No athletes yet — add one above.</span>}
      </div>
    </div>
  )
}
