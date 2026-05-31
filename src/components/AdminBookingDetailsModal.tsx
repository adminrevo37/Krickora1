import { useState, useMemo, useEffect } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { LANES, formatTime, getCoachPrice, getCustomerPrice, canBookSlot, getAWSTNow, type Booking } from '../lib/booking-data'
import { getSettingsStore, getHoursForDate } from '../lib/settings-store'
import { useBookings } from '../hooks/useBookingStore'
import { useAuth } from '../hooks/useAuth'

interface Props {
  booking: Booking
  onClose: () => void
  onSave?: (newDate: string) => void
}

const ALL_DURATION_OPTIONS = [30, 60, 90, 120, 150, 180, 240, 300, 360]
const STATUS_OPTIONS = ['confirmed', 'tentative', 'cancelled']

/** Convert an ISO timestamp to a relative string like "2h ago" or "3d ago". */
function relativeTime(isoStr: string): string {
  const diffMs = getAWSTNow().getTime() - new Date(isoStr).getTime()
  const mins = Math.round(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(diffMs / 3_600_000)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(diffMs / 86_400_000)
  if (days < 7) return `${days}d ago`
  return new Date(isoStr).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

function generateHoursForDate(dateKey: string): number[] {
  const { open, close } = getHoursForDate(getSettingsStore().get(), dateKey)
  const hours: number[] = []
  for (let h = open; h < close; h += 0.5) hours.push(h)
  return hours
}

export default function AdminBookingDetailsModal({ booking, onClose, onSave }: Props) {
  const { updateBooking, bookings } = useBookings()
  const { user } = useAuth()
  const cancelMut = useMutation(api.mutations.cancelBooking)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  // UX-1: Use local state for ALL displayed fields so view mode reflects saved changes
  const [date, setDate] = useState(booking.date)
  const [startHour, setStartHour] = useState(booking.startHour)
  const [duration, setDuration] = useState(booking.duration)
  const [laneId, setLaneId] = useState(booking.laneId)
  const [customerName, setCustomerName] = useState(booking.customerName)
  const [customerEmail, setCustomerEmail] = useState(booking.customerEmail)
  const [customerPhone, setCustomerPhone] = useState(booking.customerPhone ?? '')
  const [status, setStatus] = useState<string>(booking.status)
  const [coachPrice, setCoachPrice] = useState(booking.coachPrice ?? 0)
  const [notes, setNotes] = useState(booking.notes ?? '')

  const displayLane = LANES.find(l => l.id === laneId)
  const hours = useMemo(() => generateHoursForDate(date), [date])

  // Auto-recalculate coach price when duration changes
  useEffect(() => {
    if (booking.isCoachBooking) {
      setCoachPrice(getCoachPrice(duration))
    }
  }, [duration, booking.isCoachBooking])

  // Duration options capped at day's closing hour for the selected date + start time
  const durationOptions = useMemo(() => {
    const { close } = getHoursForDate(getSettingsStore().get(), date)
    const maxMinutes = Math.round((close - startHour) * 60)
    return ALL_DURATION_OPTIONS.filter(d => d >= 60 && d <= maxMinutes)
  }, [date, startHour])

  // Computed customer price — for display reference (payment already processed)
  const calculatedCustomerPrice = useMemo(() => {
    if (booking.isCoachBooking) return null
    const lane = LANES.find(l => l.id === laneId)
    if (!lane) return null
    return getCustomerPrice(lane, booking.variantId ?? null, duration)
  }, [booking.isCoachBooking, booking.variantId, laneId, duration])

  const history = booking.modificationHistory ?? []

  // Part 2 — allocation change history (coach bookings only).
  const allocationAudit = useQuery(
    api.queries.getAllocationAuditLog,
    booking.isCoachBooking ? { bookingId: booking.id } : 'skip',
  )

  // SPEC_ADD_A_MATE: mates sharing this (customer) booking's door access.
  const mates = useQuery(
    api.mates.listBookingMates,
    booking.isCoachBooking ? 'skip' : { bookingId: booking.id as Id<'bookings'> },
  ) ?? []

  // Detect whether a cancellation is already recorded in the history array
  const hasCancelledInHistory = history.some(h =>
    h.changes.some(c => c.field === 'status' && c.newValue === 'cancelled')
  )
  // Most-recent real history entry (last = newest, since Convex appends)
  const lastHistoryEntry = history.length > 0 ? history[history.length - 1] : null

  const handleSave = async () => {
    setSaving(true); setError(null)

    // Availability check when scheduling fields change
    const schedulingChanged =
      date !== booking.date ||
      startHour !== booking.startHour ||
      duration !== booking.duration ||
      laneId !== booking.laneId
    if (schedulingChanged) {
      // Exclude the current booking so it doesn't conflict with itself
      const otherBookings = bookings.filter(b => b.id !== booking.id)
      if (!canBookSlot(otherBookings, laneId, date, startHour, duration)) {
        setError('This time slot is already taken. Please choose a different time or lane.')
        setSaving(false)
        return
      }
    }

    try {
      await updateBooking(booking.id, {
        date,
        startHour,
        duration,
        laneId,
        customerName,
        customerEmail,
        customerPhone: customerPhone || undefined,
        status: status as Booking['status'],
        notes: notes.trim() || undefined,
        ...(booking.isCoachBooking ? { coachPrice } : {}),
      } as any)
      // Auto-close and navigate calendar to the (possibly new) date
      onSave?.(date)
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save changes.')
    } finally {
      setSaving(false)
    }
  }

  // MF-3: Cancel booking handler — calls cancelBooking directly (sets cancelledAt,
  // cancelledByUserId, sends email). The previous updateBooking pre-step was removed
  // because it set status='cancelled' before cancelMut ran, causing cancelMut to throw
  // "Already cancelled" every time (BUG-1 fix).
  const handleCancel = async () => {
    setSaving(true); setError(null)
    try {
      await cancelMut({ id: booking.id as any, cancelledByUserId: user?.id })
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to cancel booking.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={!saving ? onClose : undefined} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-lg overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className={`p-5 text-white ${booking.isCoachBooking ? 'bg-gradient-to-r from-orange-500 to-amber-500' : 'bg-gradient-to-r from-blue-500 to-indigo-500'}`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">📋 Booking Details</h3>
              <p className="text-white/80 text-xs mt-0.5">{displayLane?.icon} {displayLane?.name ?? laneId}</p>
            </div>
            <button onClick={onClose} disabled={saving} className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors">✕</button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-lg p-3 text-xs text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          {!editing ? (
            <>
              {/* UX-1: View mode reads from local state so it reflects the last saved values */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Field label="Customer" value={customerName} />
                <Field label="Email" value={customerEmail} />
                <Field label="Phone" value={customerPhone || '—'} />
                <Field label="Status" value={
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                    status === 'confirmed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                    status === 'tentative' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                    'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
                  }`}>{status}</span>
                } />
                <Field label="Date" value={new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} />
                <Field label="Time" value={`${formatTime(startHour)} – ${formatTime(startHour + duration / 60)}`} />
                <Field label="Duration" value={`${duration} min`} />
                <Field label="Type" value={booking.isCoachBooking ? '🏅 Coach' : '👤 Customer'} />
                {booking.isCoachBooking && <Field label="Coach Price" value={`$${coachPrice.toFixed(2)}`} />}
                {!booking.isCoachBooking && calculatedCustomerPrice !== null && (
                  <Field label="Session Price" value={`$${(calculatedCustomerPrice as number).toFixed(2)}`} />
                )}
                {booking.accessCode && <Field label="Access Code" value={<code className="font-mono">{booking.accessCode}</code>} />}
                {booking.discountCode && <Field label="Discount" value={booking.discountCode} />}
              </div>

              {/* Last-modified strip — shows most recent history entry at a glance */}
              {lastHistoryEntry && (
                <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/60 rounded-lg px-3 py-1.5 text-[11px]">
                  <span className="text-gray-400 uppercase font-semibold tracking-wide">Last modified</span>
                  <span className="text-gray-600 dark:text-gray-400">
                    <span className="font-semibold text-gray-700 dark:text-gray-300">{lastHistoryEntry.modifiedByName ?? 'Unknown'}</span>
                    {' · '}{relativeTime(lastHistoryEntry.modifiedAt)}
                    {' · '}<span className="text-gray-400">{new Date(lastHistoryEntry.modifiedAt).toLocaleString()}</span>
                  </span>
                </div>
              )}

              {/* Notes — full width below the grid */}
              {notes && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-lg px-3 py-2">
                  <div className="text-[10px] uppercase font-semibold text-amber-700 dark:text-amber-400 tracking-wide mb-0.5">📝 Notes</div>
                  <p className="text-sm text-gray-800 dark:text-gray-200">{notes}</p>
                </div>
              )}

              {/* Athlete Allocations — coach bookings only */}
              {booking.isCoachBooking && (booking.athleteSlots ?? []).length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                    🏏 Athlete Allocations ({booking.athleteSlots!.length})
                  </h4>
                  <div className="space-y-1.5">
                    {booking.athleteSlots!.map((slot, i) => (
                      <div key={i} className="flex items-center justify-between bg-orange-50 dark:bg-orange-900/10 rounded-lg px-3 py-2 border border-orange-100 dark:border-orange-900/30">
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-5 bg-orange-400 rounded-full flex items-center justify-center text-white text-[9px] font-bold shrink-0">
                            {slot.athleteName.charAt(0).toUpperCase()}
                          </div>
                          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{slot.athleteName}</span>
                        </div>
                        <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                          {formatTime(slot.startHour)} – {formatTime(slot.startHour + slot.durationMinutes / 60)} · {slot.durationMinutes}min
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Mates (SPEC_ADD_A_MATE) — customer bookings only. Display name
                  only (first name + last initial) to match the privacy model. */}
              {!booking.isCoachBooking && mates.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                    👥 Mates ({mates.length})
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {mates.map((m: any) => (
                      <span
                        key={m.customerId}
                        className="text-xs px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50 text-blue-700 dark:text-blue-300"
                      >
                        {m.displayName}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Allocation change history (Part 2) — coach bookings only */}
              {booking.isCoachBooking && allocationAudit && allocationAudit.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                    🧾 Allocation History
                    <span className="ml-2 text-[10px] font-normal text-gray-400 normal-case tracking-normal">
                      ({allocationAudit.length} change{allocationAudit.length !== 1 ? 's' : ''})
                    </span>
                  </h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {allocationAudit.map((entry: any) => {
                      const label: Record<string, string> = {
                        allocate: 'Athletes allocated',
                        reallocate: 'Allocation changed',
                        remove: 'Athlete(s) removed',
                        cancel: 'Session cancelled',
                        reschedule: 'Session rescheduled',
                      }
                      const names = (slots: any[] | undefined) =>
                        (slots ?? []).map((s) => s.athleteName).join(', ') || '—'
                      return (
                        <div key={entry._id} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2.5 text-xs">
                          <div className="flex justify-between mb-1">
                            <span className="font-semibold text-gray-700 dark:text-gray-300">
                              {label[entry.action] ?? entry.action}
                            </span>
                            <span className="text-gray-500">{new Date(entry.at).toLocaleString()}</span>
                          </div>
                          <p className="text-[10px] text-gray-500 dark:text-gray-400">
                            {entry.actorName ? `By ${entry.actorName} · ` : ''}
                            <span className="text-gray-400">was:</span> {names(entry.before)}
                            {' → '}
                            <span className="text-gray-400">now:</span> {names(entry.after)}
                          </p>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Modification History */}
              <div>
                <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                  📝 Modification History
                  {history.length > 0 && (
                    <span className="ml-2 text-[10px] font-normal text-gray-400 normal-case tracking-normal">
                      ({history.length} change{history.length !== 1 ? 's' : ''})
                    </span>
                  )}
                </h4>

                {/* Synthesised cancellation entry — shown when booking is cancelled but the
                    cancellation wasn't routed through updateBooking (older bookings / customer cancels) */}
                {booking.status === 'cancelled' && !hasCancelledInHistory && booking.cancelledAt && (
                  <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-900/30 rounded-lg p-2.5 text-xs mb-2">
                    <div className="flex justify-between mb-1">
                      <span className="font-semibold text-rose-600 dark:text-rose-400">🚫 Cancelled</span>
                      <span className="text-gray-500">
                        {relativeTime(booking.cancelledAt)}
                        {' · '}{new Date(booking.cancelledAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-400 italic">
                      Cancelled via the customer or direct admin action (no field-level detail available).
                    </p>
                  </div>
                )}

                {history.length === 0 && !(booking.status === 'cancelled' && !hasCancelledInHistory && booking.cancelledAt) ? (
                  <p className="text-xs text-gray-500 italic">No modifications since initial booking.</p>
                ) : history.length > 0 ? (
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {[...history].reverse().map((h, i) => (
                      <div key={i} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2.5 text-xs">
                        <div className="flex justify-between mb-1">
                          <span className="font-semibold text-gray-700 dark:text-gray-300">{h.modifiedByName ?? 'Unknown'}</span>
                          <span className="text-gray-500 text-right">
                            <span className="text-gray-400">{relativeTime(h.modifiedAt)}</span>
                            {' · '}{new Date(h.modifiedAt).toLocaleString()}
                          </span>
                        </div>
                        <ul className="space-y-0.5 text-gray-600 dark:text-gray-400">
                          {h.changes.map((c, j) => (
                            <li key={j}>
                              <span className="font-medium">{c.field}:</span>{' '}
                              <span className="line-through text-rose-500">{c.oldValue ?? '∅'}</span>{' → '}
                              <span className="text-emerald-600 dark:text-emerald-400">{c.newValue ?? '∅'}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* MF-3: Inline cancel confirmation — no window.confirm (IMPR-4 fix) */}
              {showCancelConfirm && status !== 'cancelled' ? (
                <div className="mt-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-lg p-4 space-y-3">
                  <p className="text-sm font-semibold text-red-700 dark:text-red-400">Cancel this booking?</p>
                  <p className="text-xs text-red-600 dark:text-red-400">The customer will receive a cancellation email. This cannot be undone.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowCancelConfirm(false)}
                      disabled={saving}
                      className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-semibold hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                    >
                      No, go back
                    </button>
                    <button
                      onClick={handleCancel}
                      disabled={saving}
                      className="flex-1 px-3 py-2 rounded-lg bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition-colors disabled:opacity-50"
                    >
                      {saving ? 'Cancelling…' : 'Yes, cancel'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 pt-2">
                  <button onClick={onClose} className="flex-1 px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-semibold hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Close</button>
                  {status !== 'cancelled' && (
                    <button onClick={() => setShowCancelConfirm(true)} disabled={saving} className="flex-1 px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition-colors disabled:opacity-50">
                      🚫 Cancel
                    </button>
                  )}
                  <button onClick={() => setEditing(true)} className="flex-1 px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 transition-colors">✏️ Modify</button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Customer Name" value={customerName} onChange={setCustomerName} />
                <Input label="Email" value={customerEmail} onChange={setCustomerEmail} />
                <Input label="Phone" value={customerPhone} onChange={setCustomerPhone} />
                <Select label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
                {/* UX-2: Date field uses type="date" for proper date picker */}
                <DateInput label="Date" value={date} onChange={setDate} />
                <Select label="Lane" value={laneId} onChange={setLaneId} options={LANES.map(l => l.id)} optionLabels={LANES.map(l => l.name)} />
                <Select label="Start Time" value={String(startHour)} onChange={(v) => setStartHour(Number(v))} options={hours.map(String)} optionLabels={hours.map(h => formatTime(h))} />
                <Select label="Duration" value={String(duration)} onChange={(v) => setDuration(Number(v))} options={durationOptions.map(String)} optionLabels={durationOptions.map(d => d >= 60 ? `${Math.floor(d/60)}hr${d%60>0?` ${d%60}min`:''}` : `${d}min`)} />
                {booking.isCoachBooking && (
                  <div className="col-span-2">
                    <div className="text-[10px] uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide mb-1">Coach Price</div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 px-2.5 py-1.5 text-sm bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-lg font-bold text-emerald-700 dark:text-emerald-400">
                        ${coachPrice.toFixed(2)}
                      </div>
                      <span className="text-[10px] text-gray-400">auto-calculated from duration</span>
                    </div>
                  </div>
                )}
                {!booking.isCoachBooking && calculatedCustomerPrice !== null && (
                  <div className="col-span-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-200 dark:border-blue-800/40">
                    <div className="text-[10px] uppercase font-semibold text-blue-600 dark:text-blue-400 tracking-wide">Session Price</div>
                    <div className="text-sm font-bold text-blue-800 dark:text-blue-200 mt-0.5">
                      ${(calculatedCustomerPrice as number).toFixed(2)} <span className="text-[10px] font-normal text-blue-500">· reference only — already charged</span>
                    </div>
                  </div>
                )}
              </div>
              {/* Notes — full-width textarea */}
              <label className="block">
                <span className="text-[10px] uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">📝 Notes (optional)</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Winter Program, Trial Session, Tournament prep…"
                  rows={2}
                  className="mt-1 w-full px-2.5 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none text-gray-800 dark:text-gray-200 resize-none"
                />
              </label>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setEditing(false); setError(null) }} disabled={saving} className="flex-1 px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-semibold hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50">Cancel</button>
                <button onClick={handleSave} disabled={saving} className="flex-1 px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 transition-colors disabled:opacity-50">
                  {saving ? 'Saving...' : '💾 Save Changes'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">{label}</div>
      <div className="text-sm text-gray-800 dark:text-gray-200 mt-0.5">{value}</div>
    </div>
  )
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full px-2.5 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none text-gray-800 dark:text-gray-200"
      />
    </label>
  )
}

// UX-2: Native date picker instead of free-text YYYY-MM-DD input
function DateInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full px-2.5 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none text-gray-800 dark:text-gray-200"
      />
    </label>
  )
}

function Select({ label, value, onChange, options, optionLabels }: { label: string; value: string; onChange: (v: string) => void; options: string[]; optionLabels?: string[] }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full px-2.5 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none text-gray-800 dark:text-gray-200"
      >
        {options.map((o, i) => (
          <option key={o} value={o}>{optionLabels?.[i] ?? o}</option>
        ))}
      </select>
    </label>
  )
}
