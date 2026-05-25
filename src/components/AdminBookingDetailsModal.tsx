import { useState, useMemo } from 'react'
import { LANES, formatTime, type Booking } from '../lib/booking-data'
import { useBookings } from '../hooks/useBookingStore'

interface Props {
  booking: Booking
  onClose: () => void
}

const DURATION_OPTIONS = [30, 60, 90, 120, 150, 180]
const STATUS_OPTIONS = ['confirmed', 'tentative', 'cancelled']

function generateHours(): number[] {
  const hours: number[] = []
  for (let h = 7; h < 21; h += 0.5) hours.push(h)
  return hours
}

export default function AdminBookingDetailsModal({ booking, onClose }: Props) {
  const { updateBooking } = useBookings()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const lane = LANES.find(l => l.id === booking.laneId)
  const hours = useMemo(() => generateHours(), [])

  const history = booking.modificationHistory ?? []

  const handleSave = async () => {
    setSaving(true); setError(null)
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
      setEditing(false)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save changes.')
    } finally {
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
              <p className="text-white/80 text-xs mt-0.5">{lane?.icon} {lane?.name ?? booking.laneId}</p>
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
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Field label="Customer" value={booking.customerName} />
                <Field label="Email" value={booking.customerEmail} />
                <Field label="Phone" value={booking.customerPhone ?? '—'} />
                <Field label="Status" value={
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                    booking.status === 'confirmed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                    booking.status === 'tentative' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                    'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
                  }`}>{booking.status}</span>
                } />
                <Field label="Date" value={new Date(booking.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} />
                <Field label="Time" value={`${formatTime(booking.startHour)} – ${formatTime(booking.startHour + booking.duration / 60)}`} />
                <Field label="Duration" value={`${booking.duration} min`} />
                <Field label="Type" value={booking.isCoachBooking ? '🏅 Coach' : '👤 Customer'} />
                {booking.isCoachBooking && <Field label="Coach Price" value={`$${(booking.coachPrice ?? 0).toFixed(2)}`} />}
                {booking.accessCode && <Field label="Access Code" value={<code className="font-mono">{booking.accessCode}</code>} />}
                {booking.discountCode && <Field label="Discount" value={booking.discountCode} />}
              </div>

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

              {/* Modification History */}
              <div>
                <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">📝 Modification History</h4>
                {history.length === 0 ? (
                  <p className="text-xs text-gray-500 italic">No modifications since initial booking.</p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {[...history].reverse().map((h, i) => (
                      <div key={i} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2.5 text-xs">
                        <div className="flex justify-between mb-1">
                          <span className="font-semibold text-gray-700 dark:text-gray-300">{h.modifiedByName}</span>
                          <span className="text-gray-500">{new Date(h.modifiedAt).toLocaleString()}</span>
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
                )}
              </div>

              <div className="flex gap-2 pt-2">
                <button onClick={onClose} className="flex-1 px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-semibold hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Close</button>
                <button onClick={() => setEditing(true)} className="flex-1 px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 transition-colors">✏️ Modify</button>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Customer Name" value={customerName} onChange={setCustomerName} />
                <Input label="Email" value={customerEmail} onChange={setCustomerEmail} />
                <Input label="Phone" value={customerPhone} onChange={setCustomerPhone} />
                <Select label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
                <Input label="Date (YYYY-MM-DD)" value={date} onChange={setDate} />
                <Select label="Lane" value={laneId} onChange={setLaneId} options={LANES.map(l => l.id)} optionLabels={LANES.map(l => l.name)} />
                <Select label="Start Time" value={String(startHour)} onChange={(v) => setStartHour(Number(v))} options={hours.map(String)} optionLabels={hours.map(h => formatTime(h))} />
                <Select label="Duration" value={String(duration)} onChange={(v) => setDuration(Number(v))} options={DURATION_OPTIONS.map(String)} optionLabels={DURATION_OPTIONS.map(d => `${d} min`)} />
                {booking.isCoachBooking && (
                  <Input label="Coach Price ($)" value={String(coachPrice)} onChange={(v) => setCoachPrice(Number(v) || 0)} />
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
                <button onClick={() => setEditing(false)} disabled={saving} className="flex-1 px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-semibold hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50">Cancel</button>
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
