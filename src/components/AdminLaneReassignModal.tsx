// Admin lane reassignment / swap tool — the UI side of convex/laneReassign.ts.
// Two flows share one modal, auto-detected from the selection:
//  - Same date + same hour, 2+ bookings selected -> "swap" mode: pick each
//    selected booking's new lane individually (2 bookings defaults to a
//    straight lane-A<->lane-B swap; 3+ needs each pick made explicitly).
//  - Anything else -> "bulk move" mode: one shared target lane for everyone.
// After a successful reassignment, a second step lets the admin review/edit
// the customer email before sending — nothing sends automatically.
import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import { LANES, type Booking } from '../lib/booking-data'

interface Props {
  bookings: Booking[]
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
}

const DEFAULT_INTRO =
  "Please note we have adjusted your lane selection for your upcoming session, this is to streamline bookings that are running over multiple hours."
const DEFAULT_CLOSING = 'Thank you for your understanding and flexibility.'

function laneShortName(id: string): string {
  return LANES.find((l) => l.id === id)?.shortName ?? id
}

export default function AdminLaneReassignModal({ bookings, onClose, onDone }: Props) {
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

  const isSwapMode =
    bookings.length > 1 &&
    bookings.every((b) => b.date === bookings[0].date && Math.abs(b.startHour - bookings[0].startHour) < 1e-6)

  const [perBookingLane, setPerBookingLane] = useState<Record<string, string>>(() => {
    if (isSwapMode && bookings.length === 2) {
      // The classic case: lane 4 <-> lane 5. Default each to the other's current lane.
      return { [bookings[0].id]: bookings[1].laneId, [bookings[1].id]: bookings[0].laneId }
    }
    return {}
  })
  const [bulkTargetLane, setBulkTargetLane] = useState('')

  async function handleAssign() {
    setError(null)
    const payload = isSwapMode
      ? bookings
          .map((b) => ({ bookingId: b.id, newLaneId: perBookingLane[b.id] ?? '' }))
          .filter((a) => a.newLaneId && a.newLaneId !== bookings.find((b) => b.id === a.bookingId)?.laneId)
      : bookings
          .map((b) => ({ bookingId: b.id, newLaneId: bulkTargetLane }))
          .filter((a) => a.newLaneId && a.newLaneId !== bookings.find((b) => b.id === a.bookingId)?.laneId)

    if (payload.length === 0) {
      setError('Nothing to move — pick a different lane than the current one.')
      return
    }
    setBusy(true)
    try {
      const result = await reassignMut({ assignments: payload as any })
      setMoved(result.moved as MovedResult[])
      setEmailSelected(new Set((result.moved as MovedResult[]).map((m) => m.bookingId)))
      setStep('email')
    } catch (e) {
      setError(getErrorMessage(e) ?? "Something went wrong.")
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
      setError(getErrorMessage(e) ?? "Something went wrong.")
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
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-xl overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="p-5 text-white bg-gradient-to-r from-indigo-500 to-purple-500">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">🔀 {isSwapMode ? 'Swap lanes' : 'Reassign lanes'}</h3>
              <p className="text-white/80 text-xs mt-0.5">
                {step === 'assign' && `${bookings.length} booking${bookings.length !== 1 ? 's' : ''} selected`}
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
              {isSwapMode ? (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    All selected bookings are at the same time ({bookings[0].date}, {LANES.find((l) => l.id === bookings[0].laneId)?.shortName}). Pick each one's new lane.
                  </p>
                  {bookings.map((b) => (
                    <div key={b.id} className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{b.customerName}</div>
                        <div className="text-[11px] text-gray-500 dark:text-gray-400">Currently {laneShortName(b.laneId)}</div>
                      </div>
                      <span className="text-gray-400">→</span>
                      <select
                        value={perBookingLane[b.id] ?? ''}
                        onChange={(e) => setPerBookingLane((prev) => ({ ...prev, [b.id]: e.target.value }))}
                        className="text-sm px-2 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
                      >
                        <option value="">— no change —</option>
                        {LANES.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.shortName}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    These bookings will all move to one lane. Each keeps its own date/time.
                  </p>
                  {bookings.map((b) => (
                    <div key={b.id} className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5 text-xs">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-800 dark:text-gray-200 truncate">{b.customerName}</div>
                        <div className="text-gray-500 dark:text-gray-400">
                          {b.date} · {laneShortName(b.laneId)}
                        </div>
                      </div>
                    </div>
                  ))}
                  <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400 pt-1">Move all to:</label>
                  <select
                    value={bulkTargetLane}
                    onChange={(e) => setBulkTargetLane(e.target.value)}
                    className="w-full text-sm px-2.5 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
                  >
                    <option value="">— choose a lane —</option>
                    {LANES.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.shortName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
                  Cancel
                </button>
                <button
                  onClick={handleAssign}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
                >
                  {busy ? 'Moving…' : 'Confirm reassignment'}
                </button>
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
                        <div>Date: {m.date}</div>
                        <div>Time: {m.timeSlot}</div>
                        <div>Duration: {m.durationLabel}</div>
                        <div>New Lane: {m.newLaneName}</div>
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
