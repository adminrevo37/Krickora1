// Per-booking ↻ Repeat (SPEC_COACH_PLANNER_RETIRE_AND_VIEW §5). Repeats a single
// coach session + its allocations into the same weekday/time/lane +7 days.
// STRICT release-gating: enabled ONLY when the +7d target is actually bookable
// for this coach (L1 rolling window / L2 Sunday-5pm release). Confirm preview
// before booking (previewRepeatCoachBooking → repeatCoachBooking).

import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useAuth } from '../hooks/useAuth'
import { useSettings } from '../hooks/useSettings'
import { getErrorMessage } from '../lib/errors'
import {
  formatTime,
  formatDayLabel,
  isWithinCoachWindow,
  isNextWeekOpen,
  getNextReleaseDate,
  type Booking,
} from '../lib/booking-data'

function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  dt.setHours(0, 0, 0, 0)
  return dt
}

function fmtHourShort(date: Date): string {
  const h = date.getHours()
  const m = date.getMinutes()
  const period = h >= 12 ? 'pm' : 'am'
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h
  return m === 0 ? `${display}${period}` : `${display}:${String(m).padStart(2, '0')}${period}`
}

function fmtLongDate(key: string): string {
  return new Date(key + 'T00:00:00').toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  })
}

export default function RepeatBookingButton({ booking, compact }: { booking: Booking; compact?: boolean }) {
  const { customerRecord } = useAuth()
  const settings = useSettings()
  const [open, setOpen] = useState(false)

  const coachTier: 'L1' | 'L2' =
    ((customerRecord as any)?.coachTier === 'L2' || (customerRecord as any)?.coachTier === 'BowlingL2') ? 'L2' : 'L1'
  const windowDays = (settings as any).coachBookingWindowDays ?? 8
  const releaseSettings = {
    customerOpenDay: (settings as any).customerOpenDay,
    customerOpenHour: (settings as any).customerOpenHour,
    l2CoachOpenDay: (settings as any).l2CoachOpenDay,
    l2CoachOpenHour: (settings as any).l2CoachOpenHour,
  }

  // +7d target — the session a Repeat would create.
  const target = parseDateKey(booking.date)
  target.setDate(target.getDate() + 7)

  let enabled: boolean
  let reason: string | undefined
  if (coachTier === 'L2') {
    enabled = isNextWeekOpen('coach', 'L2', releaseSettings) && isWithinCoachWindow(target, 8)
    if (!enabled) {
      const rel = getNextReleaseDate('coach', 'L2', releaseSettings)
      reason = `Repeat opens ${formatDayLabel(rel)} ${fmtHourShort(rel)}`
    }
  } else {
    enabled = isWithinCoachWindow(target, windowDays)
    reason = enabled ? undefined : 'Repeat opens once next week is in range'
  }

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); if (enabled) setOpen(true) }}
        disabled={!enabled}
        title={reason ?? `Repeat this session next week (${fmtLongDate(target.toISOString().slice(0, 10))})`}
        className={
          compact
            ? `flex items-center justify-center w-6 h-6 rounded-md border text-[12px] leading-none transition-colors ${
                enabled
                  ? 'border-sky-300 bg-white/90 text-sky-600 hover:bg-sky-50 shadow-sm'
                  : 'border-gray-200 bg-white/70 text-gray-300 cursor-not-allowed'
              }`
            : `text-[11px] px-2.5 py-1 rounded-lg border transition-colors ${
                enabled
                  ? 'border-sky-200 dark:border-sky-800 text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-900/20'
                  : 'border-gray-200 dark:border-gray-700 text-gray-400 cursor-not-allowed'
              }`
        }
        aria-label={compact ? 'Repeat this session next week' : undefined}
      >
        {compact ? '↻' : '↻ Repeat'}
      </button>
      {open && <RepeatConfirmModal booking={booking} onClose={() => setOpen(false)} />}
    </>
  )
}

function RepeatConfirmModal({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const preview = useQuery(api.mutations.previewRepeatCoachBooking, { bookingId: booking.id as any })
  const repeat = useMutation(api.mutations.repeatCoachBooking)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const handleConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await repeat({ bookingId: booking.id as any })
      const dropped = res?.droppedCount ? ` (${res.droppedCount} athlete(s) skipped — no longer on your roster)` : ''
      setDone(`Booked for ${fmtLongDate(res.targetDate)}${dropped}.`)
    } catch (err: any) {
      setError(getErrorMessage(err) ?? 'Could not repeat this booking.')
    } finally {
      setBusy(false)
    }
  }

  const blocked = preview && preview.status !== 'ok'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-gray-900 dark:text-white">↻ Repeat session</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        {preview === undefined ? (
          <div className="py-8 text-center text-sm text-gray-500">Loading preview…</div>
        ) : done ? (
          <div className="py-2">
            <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 mb-4">✓ {done}</div>
            <button onClick={onClose} className="w-full py-2 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-semibold">Done</button>
          </div>
        ) : (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              This books the same session into next week with its athlete allocations.
            </p>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 mb-3 space-y-1">
              <div className="text-sm font-bold text-gray-900 dark:text-white">{fmtLongDate(preview.targetDate)}</div>
              <div className="text-xs text-gray-600 dark:text-gray-300">
                {formatTime(preview.startHour)} – {formatTime(preview.startHour + preview.duration / 60)}
                {' · '}{preview.laneNameSnapshot}
                {preview.variantLabelSnapshot ? ` · ${preview.variantLabelSnapshot}` : ''}
              </div>
              {preview.allocations.length > 0 ? (
                <div className="pt-1 mt-1 border-t border-gray-100 dark:border-gray-800 space-y-0.5">
                  {preview.allocations.map((a, i) => (
                    <div key={i} className="text-xs text-gray-600 dark:text-gray-300">
                      • {a.athleteName} <span className="text-gray-400">({a.durationMinutes}m @ {formatTime(a.startHour)})</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-gray-400 pt-1">No athletes allocated.</div>
              )}
            </div>

            {preview.droppedCount > 0 && (
              <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2.5 py-2 mb-3">
                ⚠️ {preview.droppedCount} athlete(s) will be skipped — no longer on your roster.
              </div>
            )}
            {blocked && (
              <div className="text-[11px] text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-2.5 py-2 mb-3">
                Can't repeat: {preview.reason}.
              </div>
            )}
            {error && (
              <div className="text-[11px] text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-2.5 py-2 mb-3">{error}</div>
            )}

            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-700 dark:text-gray-300">Cancel</button>
              <button
                onClick={handleConfirm}
                disabled={busy || !!blocked}
                className="flex-1 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-sm font-semibold"
              >
                {busy ? 'Booking…' : 'Confirm booking'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
