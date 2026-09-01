// Admin lane reassignment / swap tool — the UI side of convex/laneReassign.ts.
//
// v2 (2026-09-01). The old modal auto-detected a "swap mode" (per-booking lane
// pickers) ONLY when every selected booking shared the same date+hour, and fell
// back to "bulk move" (one shared target lane) otherwise. Two problems in real
// use: swapping a whole evening between two lanes was impossible because the
// bookings start at different hours, and the fallback silently offered to stack
// everything onto one lane — an easy mis-click with no visible warning.
//
// Now there is ONE mode: a per-leg destination picker, always. "Set all to…" is
// a convenience that fills every row (still editable, still reviewable) rather
// than a hidden mode with different semantics. The admin always sees exactly
// what each booking will become before confirming.
//
// A selection is a (booking, lane) LEG, not a booking — so one lane can be moved
// out of a multi-lane club booking while its other lanes stay put.
import { useMemo, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import { type Booking } from '../lib/booking-data'
import { formatDateLong } from '../lib/dateFormat'
import { DEFAULT_LANE_META, resolveLaneAt } from '../lib/lanes'

export type ReassignLeg = { booking: Booking; laneId: string }

interface Props {
  legs: ReassignLeg[]
  onClose: () => void
  onDone: () => void
}

type MovedResult = {
  bookingId: string
  customerEmail: string
  customerName: string
  date: string
  startHour: number
  duration: number
  timeSlot: string
  durationLabel: string
  oldLaneName: string
  newLaneName: string
  newLaneId: string
  laneType: string
  isMultiLane: boolean
}

const DEFAULT_INTRO =
  "Please note we have adjusted your lane selection for your upcoming session, this is to streamline bookings that are running over multiple hours."
const DEFAULT_CLOSING = 'Thank you for your understanding and flexibility.'

const legKey = (l: ReassignLeg) => `${l.booking.id}|${l.laneId}`

function fmtHour(h: number): string {
  const whole = Math.floor(h)
  const min = Math.round((h - whole) * 60)
  const period = whole >= 12 ? 'pm' : 'am'
  const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole
  return min === 0 ? `${display}${period}` : `${display}:${String(min).padStart(2, '0')}${period}`
}

export default function AdminLaneReassignModal({ legs, onClose, onDone }: Props) {
  const reassignMut = useMutation(api.laneReassign.adminReassignLanes)
  const sendEmailsMut = useMutation(api.laneReassign.adminSendLaneChangeEmails)

  const [step, setStep] = useState<'assign' | 'email' | 'done'>('assign')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [moved, setMoved] = useState<MovedResult[]>([])
  const [introText, setIntroText] = useState(DEFAULT_INTRO)
  const [closingText, setClosingText] = useState(DEFAULT_CLOSING)
  const [emailSelected, setEmailSelected] = useState<Set<string>>(new Set())
  const [sentCount, setSentCount] = useState(0)

  // Date-resolved lane name (respects a lane override for that day — the legacy
  // static LANES map in booking-data.ts still carries pre-migration "RU 1"/"RU 2"
  // names and ignores overrides entirely, so it must not be used here).
  function laneNameAt(laneId: string, date: string, hour: number): string {
    try {
      return resolveLaneAt(laneId, date, hour).name
    } catch {
      return laneId
    }
  }

  // Prefill: exactly 2 legs, same date+hour, different lanes -> the classic
  // straight swap. Anything else starts blank so nothing moves by accident.
  const [target, setTarget] = useState<Record<string, string>>(() => {
    if (
      legs.length === 2 &&
      legs[0].booking.date === legs[1].booking.date &&
      Math.abs(legs[0].booking.startHour - legs[1].booking.startHour) < 1e-6 &&
      legs[0].laneId !== legs[1].laneId
    ) {
      return { [legKey(legs[0])]: legs[1].laneId, [legKey(legs[1])]: legs[0].laneId }
    }
    return {}
  })

  const pending = useMemo(
    () => legs.filter((l) => target[legKey(l)] && target[legKey(l)] !== l.laneId),
    [legs, target]
  )

  // Client-side preview of the same collision the server enforces, so a bad
  // selection is visible before submitting rather than coming back as an error.
  const collision = useMemo(() => {
    type Occ = { id: string; lane: string; start: number; end: number; name: string; date: string }
    const occ: Occ[] = legs.map((l) => ({
      id: l.booking.id,
      lane: target[legKey(l)] || l.laneId,
      start: l.booking.startHour,
      end: l.booking.startHour + l.booking.duration / 60,
      name: l.booking.customerName,
      date: l.booking.date,
    }))
    for (let i = 0; i < occ.length; i++) {
      for (let j = i + 1; j < occ.length; j++) {
        const a = occ[i]
        const b = occ[j]
        if (a.id === b.id || a.lane !== b.lane || a.date !== b.date) continue
        if (a.start < b.end && a.end > b.start) {
          return `${a.name} and ${b.name} would both be on ${laneNameAt(a.lane, a.date, a.start)} at overlapping times.`
        }
      }
    }
    return null
  }, [legs, target])

  function setAll(laneId: string) {
    if (!laneId) return
    setTarget(Object.fromEntries(legs.map((l) => [legKey(l), laneId])))
  }

  async function handleAssign() {
    setError(null)
    const payload = pending.map((l) => ({
      bookingId: l.booking.id,
      newLaneId: target[legKey(l)],
      fromLaneId: l.laneId,
    }))
    if (payload.length === 0) {
      setError('Nothing to move — pick a destination lane for at least one row.')
      return
    }
    setBusy(true)
    try {
      const result = await reassignMut({ assignments: payload as any })
      setMoved(result.moved as MovedResult[])
      setEmailSelected(new Set((result.moved as MovedResult[]).map((m) => m.bookingId)))
      setStep('email')
    } catch (e) {
      setError(getErrorMessage(e) ?? 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSendEmails() {
    setBusy(true)
    setError(null)
    try {
      const items = moved
        .filter((m) => emailSelected.has(m.bookingId))
        .map((m) => ({ bookingId: m.bookingId as any, introText, closingText }))
      const result = await sendEmailsMut({ items })
      setSentCount(result.sent.length)
      setStep('done')
    } catch (e) {
      setError(getErrorMessage(e) ?? 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  function toggleEmailSelected(bookingId: string) {
    setEmailSelected((prev) => {
      const next = new Set(prev)
      if (next.has(bookingId)) next.delete(bookingId)
      else next.add(bookingId)
      return next
    })
  }

  function finish() {
    onDone()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={!busy ? onClose : undefined} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-2xl overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="p-5 text-white bg-gradient-to-r from-indigo-500 to-purple-500">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">🔀 Reassign lanes</h3>
              <p className="text-white/80 text-xs mt-0.5">
                {step === 'assign' && `${legs.length} lane${legs.length !== 1 ? 's' : ''} selected`}
                {step === 'email' && `${moved.length} booking${moved.length !== 1 ? 's' : ''} moved — review the email`}
                {step === 'done' && 'Done'}
              </p>
            </div>
            <button onClick={onClose} disabled={busy} className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors">
              ✕
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-lg p-3 text-xs text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          {step === 'assign' && (
            <>
              <div className="flex items-center gap-2 pb-1">
                <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 whitespace-nowrap">Set all to:</label>
                <select
                  value=""
                  onChange={(e) => setAll(e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
                >
                  <option value="">— choose —</option>
                  {DEFAULT_LANE_META.map((l) => (
                    <option key={l.laneId} value={l.laneId}>
                      Lane {l.bayNumber}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-gray-400">fills every row below — you can still adjust each one</span>
              </div>

              <div className="space-y-2">
                {legs.map((l) => {
                  const k = legKey(l)
                  const b = l.booking
                  const multi = (b.additionalLaneIds?.length ?? 0) > 0
                  return (
                    <div key={k} className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">
                          {b.customerName}
                          {multi && (
                            <span
                              className="ml-1.5 inline-block align-middle text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500 text-white font-bold"
                              title={`This booking uses ${(b.additionalLaneIds?.length ?? 0) + 1} lanes — only the selected one moves`}
                            >
                              {(b.additionalLaneIds?.length ?? 0) + 1} LANES
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-gray-500 dark:text-gray-400">
                          {formatDateLong(b.date)} · {fmtHour(b.startHour)}–{fmtHour(b.startHour + b.duration / 60)} ·{' '}
                          <span className="font-semibold">{laneNameAt(l.laneId, b.date, b.startHour)}</span>
                        </div>
                      </div>
                      <span className="text-gray-400">→</span>
                      <select
                        value={target[k] ?? ''}
                        onChange={(e) => setTarget((prev) => ({ ...prev, [k]: e.target.value }))}
                        className="text-sm px-2 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
                      >
                        <option value="">— no change —</option>
                        {DEFAULT_LANE_META.map((meta) => (
                          <option key={meta.laneId} value={meta.laneId}>
                            {laneNameAt(meta.laneId, b.date, b.startHour)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )
                })}
              </div>

              {collision && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-400">
                  ⚠️ {collision}
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {pending.length} of {legs.length} will move
                </span>
                <div className="flex gap-2">
                  <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
                    Cancel
                  </button>
                  <button
                    onClick={handleAssign}
                    disabled={busy || pending.length === 0 || !!collision}
                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
                  >
                    {busy ? 'Moving…' : `Confirm ${pending.length} move${pending.length !== 1 ? 's' : ''}`}
                  </button>
                </div>
              </div>
            </>
          )}

          {step === 'email' && (
            <>
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400">Intro text</label>
                <textarea
                  value={introText}
                  onChange={(e) => setIntroText(e.target.value)}
                  rows={3}
                  className="w-full text-sm px-2.5 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
                />
                <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400">Closing text</label>
                <input
                  value={closingText}
                  onChange={(e) => setClosingText(e.target.value)}
                  className="w-full text-sm px-2.5 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
                />
              </div>

              <div className="space-y-2 pt-1">
                {moved.map((m) => (
                  <label key={m.bookingId} className="flex items-start gap-2.5 bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={emailSelected.has(m.bookingId)}
                      onChange={() => toggleEmailSelected(m.bookingId)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0 text-xs">
                      <div className="font-semibold text-gray-800 dark:text-gray-200">
                        {m.customerName} <span className="font-normal text-gray-500 dark:text-gray-400">({m.customerEmail})</span>
                      </div>
                      <div className="mt-1 text-gray-600 dark:text-gray-400 grid grid-cols-2 gap-x-3 gap-y-0.5">
                        <div>Date: {formatDateLong(m.date)}</div>
                        <div>Time: {m.timeSlot}</div>
                        <div>Duration: {m.durationLabel}</div>
                        <div>Moved from: {m.oldLaneName}</div>
                        <div>{m.isMultiLane ? 'Now on' : 'New Lane'}: {m.newLaneName}</div>
                        <div>Lane Type: {m.laneType}</div>
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={finish} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
                  Skip — don't email
                </button>
                <button
                  onClick={handleSendEmails}
                  disabled={busy || emailSelected.size === 0}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
                >
                  {busy ? 'Sending…' : `Send ${emailSelected.size} email${emailSelected.size !== 1 ? 's' : ''}`}
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 rounded-lg p-3 text-sm text-emerald-700 dark:text-emerald-400">
                Moved {moved.length} booking{moved.length !== 1 ? 's' : ''}. Sent {sentCount} email{sentCount !== 1 ? 's' : ''}.
              </div>
              <div className="flex justify-end pt-2">
                <button onClick={finish} className="px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors">
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
