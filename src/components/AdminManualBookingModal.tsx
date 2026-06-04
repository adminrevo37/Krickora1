import { useMemo, useState, useEffect } from 'react'
import { useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import {
  formatDateKey, formatTime, getCustomerPrice, getCoachPrice,
  getCustomerDurations, getCoachDurations, bookingOccupiesLane, LANES, type Lane, type LaneVariant, type Booking,
} from '../lib/booking-data'
import { getSettingsStore, getHoursForDate } from '../lib/settings-store'
import { useLaneConfigState } from '../hooks/useLaneConfig'
import { resolveLaneAt } from '../lib/lanes'

type PaymentMode = 'comp' | 'offline' | 'request'

export interface AdminCustomerOption {
  _id: string
  name: string
  email: string
  phone?: string
  role: string
}

type Recurrence = 'none' | 'weekly' | 'fortnightly' | 'monthly'

export interface BookingConfirmResult {
  succeeded: number
  failed: number
  failedDates: string[]
  // Created booking IDs, in the same order as the bookings passed to onConfirm
  // (used to generate per-booking Stripe payment links for the request mode).
  createdIds?: string[]
}

interface Props {
  lane: Lane
  date: Date
  startHour: number
  customer: AdminCustomerOption
  existingBookings: Booking[]
  onClose: () => void
  onConfirm: (bookings: Booking[]) => Promise<BookingConfirmResult | void> | void
}

function addOccurrence(base: Date, recurrence: Recurrence, index: number): Date {
  const d = new Date(base)
  if (recurrence === 'weekly') d.setDate(d.getDate() + 7 * index)
  else if (recurrence === 'fortnightly') d.setDate(d.getDate() + 14 * index)
  else if (recurrence === 'monthly') d.setMonth(d.getMonth() + index)
  return d
}

function hasConflict(bookings: Booking[], laneId: string, dateKey: string, startHour: number, durationMinutes: number): boolean {
  const endHour = startHour + durationMinutes / 60
  return bookings.some(b => {
    if (!bookingOccupiesLane(b, laneId) || b.date !== dateKey || b.status === 'cancelled') return false
    const bEnd = b.startHour + b.duration / 60
    return startHour < bEnd && endHour > b.startHour
  })
}

export default function AdminManualBookingModal({ lane, date, startHour, customer, existingBookings, onClose, onConfirm }: Props) {
  const isCoach = customer.role === 'coach'
  const hasVariants = !!(lane.variants && lane.variants.length > 0)
  const [selectedVariant, setSelectedVariant] = useState<LaneVariant | null>(hasVariants ? lane.variants![0] : null)
  const dateKey = formatDateKey(date)
  useLaneConfigState() // SPEC_RECONFIGURABLE_LANES: react to layout changes
  // Cap durations so an admin booking can't cross a segment boundary (§2.14) —
  // createBooking rejects a crossing booking server-side, so mirror the cap here.
  const segEndHour = resolveLaneAt(lane.id, dateKey, startHour).segment.endHour

  const availableDurations = useMemo(() => {
    const base = isCoach
      ? getCoachDurations(existingBookings, lane.id, dateKey, startHour)
      : getCustomerDurations(existingBookings, lane.id, dateKey, startHour)
    return base.filter((d) => startHour + d / 60 <= segEndHour + 1e-9)
  }, [existingBookings, lane.id, dateKey, startHour, isCoach, segEndHour])

  const [duration, setDuration] = useState<number>(() => availableDurations[0] ?? 60)
  const [recurrence, setRecurrence] = useState<Recurrence>('none')
  const [occurrences, setOccurrences] = useState<number>(4)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // MF-5: Discount code + price override
  const [discountCode, setDiscountCode] = useState('')
  const [priceOverrideStr, setPriceOverrideStr] = useState('')
  const [showAdminOptions, setShowAdminOptions] = useState(false)

  // SPEC_ADMIN_AND_SETTINGS #2: payment mode for manual bookings (customers only;
  // coach bookings always bill via their statement). Default = paid offline.
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('offline')
  const createPaymentLink = useAction(api.stripe.createPaymentLink)

  // Admin notes
  const [notes, setNotes] = useState('')

  // SPEC_SCHEDULE_DAY_VIEW §2.13: coach bookings created by an admin default to
  // "Managed by admin" (view+allocate only for the coach). Untick to hand a
  // one-off booking to the coach to modify/cancel/repeat themselves.
  const [managedByAdmin, setManagedByAdmin] = useState(true)

  // Additional lanes (multi-lane booking)
  const [additionalLaneIds, setAdditionalLaneIds] = useState<string[]>([])
  const toggleLane = (id: string) => {
    setAdditionalLaneIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  // Determine which other lanes are available for the same start + duration (no conflicts on first occurrence)
  const otherLanes = useMemo(() => {
    const dayClose = getHoursForDate(getSettingsStore().get(), dateKey).close
    return LANES.filter(l => l.id !== lane.id).map(l => ({
      lane: l,
      conflict: hasConflict(existingBookings, l.id, dateKey, startHour, duration) ||
                (startHour + duration / 60) > dayClose,
    }))
  }, [lane.id, existingBookings, dateKey, startHour, duration])

  // Auto-prune additional lanes that became conflicting after duration change
  useEffect(() => {
    setAdditionalLaneIds(prev => prev.filter(id => {
      const entry = otherLanes.find(o => o.lane.id === id)
      return entry && !entry.conflict
    }))
  }, [otherLanes])

  const selectedLaneCount = 1 + additionalLaneIds.length
  const pricePerLane = isCoach ? getCoachPrice(duration) : getCustomerPrice(lane, selectedVariant?.id ?? null, duration)
  // MF-5: Apply price override if provided
  const priceOverride = priceOverrideStr !== '' && !isNaN(Number(priceOverrideStr)) ? Number(priceOverrideStr) : null
  const effectivePricePerLane = priceOverride !== null ? priceOverride : pricePerLane
  const price = effectivePricePerLane * selectedLaneCount
  const endHour = startHour + duration / 60
  const totalSessions = recurrence === 'none' ? 1 : occurrences

  const occurrenceInfo = useMemo(() => {
    const list: { date: Date; dateKey: string; conflict: boolean }[] = []
    for (let i = 0; i < totalSessions; i++) {
      const d = recurrence === 'none' ? date : addOccurrence(date, recurrence, i)
      const dk = formatDateKey(d)
      const allLanes = [lane.id, ...additionalLaneIds]
      // DI-3: Check all occurrences for conflicts (including the first one)
      const conflict = allLanes.some(lid => hasConflict(existingBookings, lid, dk, startHour, duration))
      list.push({ date: d, dateKey: dk, conflict })
    }
    return list
  }, [recurrence, totalSessions, date, lane.id, additionalLaneIds, startHour, duration, existingBookings])

  const conflictCount = occurrenceInfo.filter(o => o.conflict).length

  const handleConfirm = async () => {
    setSubmitting(true); setError(null)
    try {
      const validOccurrences = occurrenceInfo.filter(o => !o.conflict)
      if (validOccurrences.length === 0) throw new Error('No valid dates available — all selected dates have conflicts.')

      // Payment mode (customers only). Coaches always bill via statement.
      const isRequest = !isCoach && paymentMode === 'request'
      const isComp = !isCoach && paymentMode === 'comp'
      const perBookingCents = Math.round((isComp ? 0 : price) * 100)
      const bookingStatus = isRequest ? 'pending_payment' : 'confirmed'
      const bookingPaymentStatus = isCoach ? undefined : isRequest ? 'pending' : 'paid'

      const bookings: Booking[] = []
      for (const occ of validOccurrences) {
        bookings.push({
          id: crypto.randomUUID(),
          laneId: lane.id,
          variantId: selectedVariant?.id ?? null,
          date: occ.dateKey,
          startHour,
          duration,
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone,
          userId: customer._id,
          status: bookingStatus,
          paymentStatus: bookingPaymentStatus,
          priceInCents: isCoach ? undefined : perBookingCents,
          isCoachBooking: isCoach,
          coachPrice: isCoach ? effectivePricePerLane : undefined,
          createdByAdmin: isCoach && managedByAdmin ? true : undefined,
          additionalLaneIds: additionalLaneIds.length > 0 ? additionalLaneIds : undefined,
          discountCode: discountCode.trim() || undefined,
          notes: notes.trim() || (isComp ? 'Comp (complimentary)' : undefined),
        })
      }

      // DI-3 / DI-4: Report per-date results instead of silently swallowing failures
      const result = await onConfirm(bookings)

      // Send-payment-request mode: generate a Stripe payment link per created
      // pending booking and present them for the admin to send to the customer.
      if (isRequest && result && result.createdIds && result.createdIds.length > 0) {
        const laneName = lane.name + (selectedVariant ? ` (${selectedVariant.name})` : '')
        const links: string[] = []
        for (let i = 0; i < result.createdIds.length; i++) {
          const occ = validOccurrences[i]
          try {
            const res = await createPaymentLink({
              laneName,
              variantName: selectedVariant?.name,
              date: occ?.dateKey ?? validOccurrences[0].dateKey,
              startHour,
              duration,
              customerName: customer.name,
              customerEmail: customer.email,
              priceInCents: perBookingCents,
              bookingId: result.createdIds[i],
            })
            links.push(`${occ?.dateKey ?? ''}: ${res.url}`)
          } catch { /* skip a failed link; booking still pending */ }
        }
        if (links.length > 0) {
          try { await navigator.clipboard.writeText(links.map(l => l.split(': ').slice(1).join(': ')).join('\n')) } catch {}
          alert(
            `Payment request created. Send this pay link to ${customer.name || customer.email}` +
            ` (copied to clipboard):\n\n${links.join('\n')}`
          )
        }
      }

      if (result && result.failed > 0) {
        const summary = result.failedDates.length > 0
          ? `${result.succeeded} booking(s) created. ${result.failed} could not be saved:\n${result.failedDates.slice(0, 4).join('\n')}${result.failedDates.length > 4 ? '\n…and more' : ''}`
          : `${result.succeeded} booking(s) created. ${result.failed} failed.`
        setError(summary)
        setSubmitting(false)
        return
      }
      // Request mode keeps the modal open (parent doesn't auto-close) so the
      // admin can read the pay link — reset the busy state.
      if (isRequest) setSubmitting(false)
    } catch (e: any) {
      setError(getErrorMessage(e) ?? 'Failed to create booking.')
      setSubmitting(false)
    }
  }

  // UX-6: Computed display prices with toFixed(2)
  const displayTotal = (price * (totalSessions - conflictCount)).toFixed(2)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={!submitting ? onClose : undefined} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-md overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className={`p-5 text-white ${isCoach ? 'bg-gradient-to-r from-orange-500 to-amber-500' : 'bg-gradient-to-r from-blue-500 to-indigo-500'}`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">🛡️ Admin Manual Booking</h3>
              <p className="text-white/80 text-sm mt-0.5">{date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
            </div>
            <button onClick={onClose} disabled={submitting} className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors">✕</button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div className={`flex items-center gap-3 rounded-xl p-3 border ${isCoach ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800/50' : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/50'}`}>
            <div className={`w-10 h-10 ${isCoach ? 'bg-orange-500' : 'bg-emerald-500'} rounded-full flex items-center justify-center text-white text-sm font-bold`}>
              {customer.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{customer.name}</div>
              <div className="text-xs text-gray-500 truncate">{customer.email}</div>
            </div>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${isCoach ? 'bg-orange-200 dark:bg-orange-900/40 text-orange-800 dark:text-orange-300' : 'bg-emerald-200 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300'}`}>
              {isCoach ? '🏅 Coach' : '👤 Customer'}
            </span>
          </div>

          <div className="flex items-center gap-3 bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
            <div className="w-10 h-10 bg-white dark:bg-gray-700 rounded-lg flex items-center justify-center text-lg shadow-sm">{lane.icon}</div>
            <div>
              <div className="font-semibold text-gray-800 dark:text-gray-200">{lane.name} <span className="text-[10px] text-emerald-600 dark:text-emerald-400">(primary)</span></div>
              <div className="text-xs text-gray-500">{formatTime(startHour)} start</div>
            </div>
          </div>

          {hasVariants && lane.variants && !isCoach && (
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Machine Type (primary lane)</label>
              <div className="grid grid-cols-2 gap-3">
                {lane.variants.map(v => (
                  <button key={v.id} onClick={() => setSelectedVariant(v)}
                    className={`p-3 rounded-xl border-2 transition-all text-left ${selectedVariant?.id === v.id ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 shadow-md' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}`}>
                    <div className="text-base font-bold text-gray-800 dark:text-gray-200">{v.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">${getCustomerPrice(lane, v.id, 60)}/hr</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Duration</label>
            {availableDurations.length === 0 ? (
              <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">No available durations for this slot.</div>
            ) : (
              <select value={duration} onChange={e => setDuration(Number(e.target.value))}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-sm">
                {availableDurations.map(d => {
                  const hrs = Math.floor(d / 60); const mins = d % 60
                  const label = hrs > 0 ? `${hrs}hr${mins > 0 ? ` ${mins}min` : ''}` : `${mins}min`
                  const dPrice = isCoach ? getCoachPrice(d) : getCustomerPrice(lane, selectedVariant?.id ?? null, d)
                  return <option key={d} value={d}>{label} — ${(dPrice as number).toFixed(2)}</option>
                })}
              </select>
            )}
          </div>

          {/* Additional Lanes */}
          <div>
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              ➕ Additional Lanes <span className="text-[11px] font-normal text-gray-500">(book multiple lanes at the same time)</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {otherLanes.map(({ lane: l, conflict }) => {
                const checked = additionalLaneIds.includes(l.id)
                return (
                  <button
                    key={l.id}
                    type="button"
                    disabled={conflict}
                    onClick={() => toggleLane(l.id)}
                    className={`p-2.5 rounded-xl border-2 transition-all text-left flex items-center gap-2 ${
                      conflict
                        ? 'border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-800/50 opacity-50 cursor-not-allowed'
                        : checked
                          ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 shadow-sm'
                          : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-lg">{l.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate">{l.shortName}</div>
                      <div className="text-[10px] text-gray-500 truncate">
                        {conflict ? 'Unavailable' : checked ? '✓ Added' : 'Click to add'}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
            {additionalLaneIds.length > 0 && (
              <div className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-2 border border-emerald-200 dark:border-emerald-800/50">
                ✓ {selectedLaneCount} lanes selected — all will share the same access code for this session.
              </div>
            )}
          </div>

          <div>
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">🔁 Recurrence</label>
            <div className="grid grid-cols-4 gap-2">
              {([
                { value: 'none', label: 'One-time' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'fortnightly', label: 'Fortnightly' },
                { value: 'monthly', label: 'Monthly' },
              ] as { value: Recurrence; label: string }[]).map(opt => (
                <button key={opt.value} onClick={() => setRecurrence(opt.value)}
                  className={`px-2 py-2 rounded-lg text-[11px] font-semibold transition-all border-2 ${
                    recurrence === opt.value
                      ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:border-gray-300'
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>

            {recurrence !== 'none' && (
              <div className="mt-3 space-y-2">
                <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 block">
                  Number of sessions: <span className="text-emerald-600 dark:text-emerald-400">{occurrences}</span>
                </label>
                <input type="range" min={2} max={26} value={occurrences} onChange={e => setOccurrences(Number(e.target.value))} className="w-full accent-emerald-500" />
                <div className="max-h-32 overflow-y-auto bg-gray-50 dark:bg-gray-800 rounded-lg p-2 space-y-1">
                  {occurrenceInfo.map((o, i) => (
                    <div key={i} className={`flex items-center justify-between text-[11px] px-2 py-1 rounded ${o.conflict ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}>
                      <span>#{i + 1} — {o.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      <span className="font-semibold">{o.conflict ? '⚠️ Conflict' : '✓ Available'}</span>
                    </div>
                  ))}
                </div>
                {conflictCount > 0 && (
                  <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-2 border border-amber-200 dark:border-amber-800/50">
                    ⚠️ {conflictCount} of {totalSessions} dates have conflicts and will be skipped.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* MF-5: Admin overrides — discount code + price override */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdminOptions(v => !v)}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 font-semibold flex items-center gap-1 transition-colors"
            >
              {showAdminOptions ? '▾' : '▸'} Admin Overrides (discount / price)
            </button>
            {showAdminOptions && (
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">Discount Code</span>
                  <input
                    type="text"
                    value={discountCode}
                    onChange={e => setDiscountCode(e.target.value)}
                    placeholder="e.g. COMP2025"
                    className="mt-1 w-full px-2.5 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-gray-800 dark:text-gray-200"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">Price Override ($/lane)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={priceOverrideStr}
                    onChange={e => setPriceOverrideStr(e.target.value)}
                    placeholder={`Default: $${pricePerLane.toFixed(2)}`}
                    className="mt-1 w-full px-2.5 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-gray-800 dark:text-gray-200"
                  />
                </label>
                {priceOverride !== null && (
                  <div className="col-span-2 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-2 border border-amber-200 dark:border-amber-800/50">
                    ⚠️ Price overridden: ${priceOverride.toFixed(2)}/lane (default ${pricePerLane.toFixed(2)}/lane)
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Payment mode (customers only — coaches bill via statement) */}
          {!isCoach && (
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">💳 Payment</label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { id: 'offline', label: 'Paid offline', hint: 'Records as paid' },
                  { id: 'comp', label: 'Comp', hint: 'Free / $0' },
                  { id: 'request', label: 'Payment request', hint: 'Send pay link' },
                ] as const).map(m => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setPaymentMode(m.id)}
                    className={`px-2 py-2 rounded-xl border text-center transition-all ${
                      paymentMode === m.id
                        ? 'bg-emerald-500 border-emerald-500 text-white'
                        : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100'
                    }`}
                  >
                    <div className="text-xs font-semibold">{m.label}</div>
                    <div className={`text-[10px] ${paymentMode === m.id ? 'text-emerald-50' : 'text-gray-400'}`}>{m.hint}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Admin Notes */}
          <div>
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              📝 Notes <span className="text-[11px] font-normal text-gray-400">(optional — displays on calendar)</span>
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Winter Program, Trial Session, Tournament prep…"
              rows={2}
              className="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none text-gray-800 dark:text-gray-200 resize-none"
            />
          </div>

          {/* UX-6: All price displays use toFixed(2) */}
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Time</span><span className="font-medium">{formatTime(startHour)} - {formatTime(endHour)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Lanes</span><span className="font-medium">{selectedLaneCount} × ${effectivePricePerLane.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Sessions</span><span className="font-medium">{totalSessions - conflictCount} {recurrence !== 'none' && conflictCount > 0 && <span className="text-red-500 text-xs">(skipping {conflictCount})</span>}</span></div>
            {discountCode.trim() && <div className="flex justify-between"><span className="text-gray-500">Discount Code</span><span className="font-medium text-emerald-600">{discountCode.trim()}</span></div>}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-1 flex justify-between"><span className="font-semibold">Total</span><span className="font-bold text-emerald-600">${displayTotal}</span></div>
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 border border-blue-200 dark:border-blue-800/50">
            <p className="text-xs text-blue-700 dark:text-blue-400">
              🛡️ {isCoach
                ? 'Coach booking — charged to the coach statement.'
                : paymentMode === 'comp'
                  ? 'Complimentary — recorded as paid at $0, no charge.'
                  : paymentMode === 'request'
                    ? 'A Stripe pay link will be generated for you to send the customer; the slot is held until they pay.'
                    : 'Recorded as paid offline — no Stripe charge.'}
              {selectedLaneCount > 1 ? ` ${selectedLaneCount} lanes per session.` : ''}
            </p>
          </div>

          {/* §2.13: admin-managed lock for coach bookings (default ON). */}
          {isCoach && (
            <label className="flex items-start gap-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl p-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={managedByAdmin}
                onChange={(e) => setManagedByAdmin(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-orange-500 shrink-0"
              />
              <span className="text-xs text-gray-600 dark:text-gray-300">
                <span className="font-semibold text-gray-800 dark:text-gray-200">Managed by admin</span>
                {' '}— the coach can allocate athletes but can't modify, cancel or repeat this booking.
                Untick to hand it over for the coach to manage.
              </span>
            </label>
          )}

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50 text-xs text-red-700 dark:text-red-400 whitespace-pre-line">
              ⚠️ {error}
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={onClose} disabled={submitting} className="flex-1 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-all disabled:opacity-50">Cancel</button>
            <button onClick={handleConfirm} disabled={submitting || availableDurations.length === 0 || (totalSessions - conflictCount) === 0}
              className={`flex-[2] py-3 font-semibold rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white ${isCoach ? 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600' : 'bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600'}`}>
              {submitting
                ? 'Creating...'
                : !isCoach && paymentMode === 'request'
                  ? `Create & get pay link — $${displayTotal}`
                  : !isCoach && paymentMode === 'comp'
                    ? 'Confirm Comp Booking'
                    : `Confirm — $${displayTotal}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
