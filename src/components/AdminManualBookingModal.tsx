import { useMemo, useState } from 'react'
import {
  formatDateKey, formatTime, getCustomerPrice, getCoachPrice,
  getCustomerDurations, getCoachDurations, LANES, type Lane, type LaneVariant, type Booking,
} from '../lib/booking-data'
import { generateAccessCode } from '../lib/access-code'

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
    if (b.laneId !== laneId || b.date !== dateKey || b.status === 'cancelled') return false
    const bEnd = b.startHour + b.duration / 60
    return startHour < bEnd && endHour > b.startHour
  })
}

export default function AdminManualBookingModal({ lane, date, startHour, customer, existingBookings, onClose, onConfirm }: Props) {
  const isCoach = customer.role === 'coach'
  const hasVariants = !!(lane.variants && lane.variants.length > 0)
  const [selectedVariant, setSelectedVariant] = useState<LaneVariant | null>(hasVariants ? lane.variants![0] : null)
  const dateKey = formatDateKey(date)

  const availableDurations = useMemo(() => {
    return isCoach
      ? getCoachDurations(existingBookings, lane.id, dateKey, startHour)
      : getCustomerDurations(existingBookings, lane.id, dateKey, startHour)
  }, [existingBookings, lane.id, dateKey, startHour, isCoach])

  const [duration, setDuration] = useState<number>(() => availableDurations[0] ?? 60)
  const [recurrence, setRecurrence] = useState<Recurrence>('none')
  const [occurrences, setOccurrences] = useState<number>(4)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // MF-5: Discount code + price override
  const [discountCode, setDiscountCode] = useState('')
  const [priceOverrideStr, setPriceOverrideStr] = useState('')
  const [showAdminOptions, setShowAdminOptions] = useState(false)

  // Additional lanes (multi-lane booking)
  const [additionalLaneIds, setAdditionalLaneIds] = useState<string[]>([])
  const toggleLane = (id: string) => {
    setAdditionalLaneIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  // Determine which other lanes are available for the same start + duration (no conflicts on first occurrence)
  const otherLanes = useMemo(() => {
    return LANES.filter(l => l.id !== lane.id).map(l => ({
      lane: l,
      conflict: hasConflict(existingBookings, l.id, dateKey, startHour, duration) ||
                (startHour + duration / 60) > 21,
    }))
  }, [lane.id, existingBookings, dateKey, startHour, duration])

  // Auto-prune additional lanes that became conflicting after duration change
  useMemo(() => {
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
      const allLaneIds = [lane.id, ...additionalLaneIds]
      const bookings: Booking[] = []
      for (const occ of validOccurrences) {
        // Share a single access code across all lanes for the same session
        const sharedCode = generateAccessCode()
        for (const lid of allLaneIds) {
          bookings.push({
            id: crypto.randomUUID(),
            laneId: lid,
            variantId: lid === lane.id ? (selectedVariant?.id ?? null) : null,
            date: occ.dateKey,
            startHour,
            duration,
            customerName: customer.name,
            customerEmail: customer.email,
            customerPhone: customer.phone,
            userId: customer._id,
            status: 'confirmed',
            isCoachBooking: isCoach,
            coachPrice: isCoach ? effectivePricePerLane : undefined,
            accessCode: sharedCode,
            discountCode: discountCode.trim() || undefined,
          })
        }
      }

      // DI-3 / DI-4: Report per-date results instead of silently swallowing failures
      const result = await onConfirm(bookings)
      if (result && result.failed > 0) {
        const summary = result.failedDates.length > 0
          ? `${result.succeeded} booking(s) created. ${result.failed} could not be saved:\n${result.failedDates.slice(0, 4).join('\n')}${result.failedDates.length > 4 ? '\n…and more' : ''}`
          : `${result.succeeded} booking(s) created. ${result.failed} failed.`
        setError(summary)
        setSubmitting(false)
        return
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create booking.')
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
                    {/* UX-6: toFixed(2) on price display */}
                    <div className="text-xs text-gray-500 mt-0.5">${v.pricePerHour.toFixed(2)}/hr</div>
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

          {/* UX-6: All price displays use toFixed(2) */}
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Time</span><span className="font-medium">{formatTime(startHour)} - {formatTime(endHour)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Lanes</span><span className="font-medium">{selectedLaneCount} × ${effectivePricePerLane.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Sessions</span><span className="font-medium">{totalSessions - conflictCount} {recurrence !== 'none' && conflictCount > 0 && <span className="text-red-500 text-xs">(skipping {conflictCount})</span>}</span></div>
            {discountCode.trim() && <div className="flex justify-between"><span className="text-gray-500">Discount Code</span><span className="font-medium text-emerald-600">{discountCode.trim()}</span></div>}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-1 flex justify-between"><span className="font-semibold">Total</span><span className="font-bold text-emerald-600">${displayTotal}</span></div>
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 border border-blue-200 dark:border-blue-800/50">
            <p className="text-xs text-blue-700 dark:text-blue-400">🛡️ Admin manual booking — no payment collected. {selectedLaneCount > 1 ? `${selectedLaneCount} lanes will be booked per session.` : ''}</p>
          </div>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50 text-xs text-red-700 dark:text-red-400 whitespace-pre-line">
              ⚠️ {error}
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={onClose} disabled={submitting} className="flex-1 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-all disabled:opacity-50">Cancel</button>
            <button onClick={handleConfirm} disabled={submitting || availableDurations.length === 0 || (totalSessions - conflictCount) === 0}
              className={`flex-[2] py-3 font-semibold rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white ${isCoach ? 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600' : 'bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600'}`}>
              {submitting ? 'Creating...' : `Confirm — $${displayTotal}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
