import { useState, useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import {
  LANES, formatDateKey, formatTime, canBookSlot, getCustomerPrice, getCoachPrice,
  getCoachDurations, getCustomerDurations, getValidCoachStartTimes, getCoachRolling7Days,
  getAWSTNow, bookingOccupiesLane, decreaseCreditCents,
  type Booking,
} from '../lib/booking-data'
import { getSettingsStore, getHoursForDate } from '../lib/settings-store'
// SPEC_EMBEDDED_CHECKOUT — in-app Stripe payment for the extend/modify top-up.
import { cancelUnpaidCheckout } from '../lib/stripe'
import EmbeddedCheckoutModal from './EmbeddedCheckoutModal'

// Result shape returned by the unified modifyBooking mutation (via useBookingStore).
export interface ModifyResult {
  success: boolean
  error?: string
  requiresPayment?: boolean
  topUpAmountCents?: number
  creditAppliedCents?: number
  credited?: boolean
  creditIssuedCents?: number
  priceDifferenceCents?: number
  droppedAthletes?: string[]
}

interface ModifyBookingModalProps {
  booking: Booking
  creditBalance: number
  onClose: () => void
  onModify: (opts: {
    newDate: string; newStartHour: number; newDuration: number;
    newLaneId?: string; newVariantId?: string;
    newAdditionalLaneIds?: string[]; newAccessCode?: string;
  }) => Promise<ModifyResult>
  isCoach: boolean
  // Coach bookings only: jump to the athlete allocation editor (closes this modal
  // and opens AthleteAllocationEditor for the same booking).
  onEditAllocation?: () => void
}

export default function ModifyBookingModal({ booking, creditBalance, onClose, onModify, isCoach, onEditAllocation }: ModifyBookingModalProps) {
  const originalLane = LANES.find(l => l.id === booking.laneId)
  const settings = getSettingsStore().get()

  const availableDates = useMemo(() => {
    if (isCoach) {
      const windowDays = settings.coachBookingWindowDays ?? 8
      return getCoachRolling7Days(windowDays)
    }
    const dates: Date[] = []
    const awstNow = getAWSTNow()
    awstNow.setHours(0, 0, 0, 0)
    for (let i = 0; i < 14; i++) {
      const d = new Date(awstNow)
      d.setDate(awstNow.getDate() + i)
      dates.push(d)
    }
    return dates
  }, [isCoach])

  const getDefaultStartHourForDate = (dateKey: string): number => {
    const { open, close } = getHoursForDate(settings, dateKey)
    if (isCoach) {
      const d = new Date(dateKey + 'T00:00:00')
      const validTimes = getValidCoachStartTimes(d).filter(h => h >= open && h < close)
      return validTimes[0] ?? open
    }
    return open
  }

  const [selectedDate, setSelectedDate] = useState<string>(booking.date)
  const [selectedLaneId, setSelectedLaneId] = useState<string>(booking.laneId)
  const [selectedVariantId, setSelectedVariantId] = useState<string | undefined>(booking.variantId ?? undefined)
  const [selectedStartHour, setSelectedStartHour] = useState<number>(booking.startHour)
  const [selectedDuration, setSelectedDuration] = useState<number>(booking.duration)
  const [step, setStep] = useState<'select' | 'confirm' | 'processing' | 'success'>('select')
  const [error, setError] = useState<string | null>(null)
  const [resultNote, setResultNote] = useState<string | null>(null)
  // SPEC_EMBEDDED_CHECKOUT — in-app payment overlay for the price-increase top-up.
  const [embeddedTopUp, setEmbeddedTopUp] = useState<{ clientSecret: string; bookingId: string } | null>(null)

  const selectedLane = LANES.find(l => l.id === selectedLaneId) ?? originalLane

  // COST-1 / FEA-6: availability is computed for the SELECTED target date only, so
  // fetch just that day via the indexed per-day query instead of subscribing to the
  // whole-table grid array. Every date the modal can move to is reachable here; the
  // server is authoritative on conflicts. listBookingsByDate returns the caller's own
  // bookings in full + others' scheduling fields (lane/time/duration) — exactly what
  // the availability helpers below need.
  const dayBookingsRaw = useQuery(api.queries.listBookingsByDate, { date: selectedDate })
  const otherBookings = useMemo(() =>
    (dayBookingsRaw ?? [])
      .filter((b: any) => String(b._id) !== booking.id && b.status !== 'cancelled')
      .map((b: any) => ({ ...b, id: String(b._id) }) as Booking),
    [dayBookingsRaw, booking.id]
  )

  const availableSlots = useMemo(() => {
    const slots: number[] = []
    const laneBookings = otherBookings.filter(b => bookingOccupiesLane(b, selectedLaneId) && b.date === selectedDate)
    const { open, close } = getHoursForDate(settings, selectedDate)
    const candidateHours: number[] = isCoach
      ? getValidCoachStartTimes(new Date(selectedDate + 'T00:00:00')).filter(h => h >= open && h < close)
      // Customers may only start on the whole hour (no half-hour starts in modify).
      : (() => { const t: number[] = []; for (let h = Math.ceil(open); h < close; h += 1) t.push(h); return t })()
    for (const h of candidateHours) {
      const occupied = laneBookings.some(b => { const e = b.startHour + b.duration / 60; return h >= b.startHour && h < e })
      if (!occupied) slots.push(h)
    }
    return slots
  }, [otherBookings, selectedLaneId, selectedDate, isCoach])

  const availableDurations = useMemo(() => {
    if (isCoach) return getCoachDurations(otherBookings, selectedLaneId, selectedDate, selectedStartHour)
    return getCustomerDurations(otherBookings, selectedLaneId, selectedDate, selectedStartHour)
  }, [otherBookings, selectedLaneId, selectedDate, selectedStartHour, isCoach])

  const effectiveDuration = availableDurations.includes(selectedDuration)
    ? selectedDuration
    : availableDurations[0] ?? 60

  const addlLaneIds = booking.additionalLaneIds ?? []
  const addlCount = addlLaneIds.length

  // Price preview (server is authoritative; this mirrors its computation).
  const newPrice = isCoach
    ? getCoachPrice(effectiveDuration)
    : (selectedLane ? getCustomerPrice(selectedLane, selectedVariantId ?? null, effectiveDuration) : 0)
      + addlCount * getCustomerPrice(selectedLane!, null, effectiveDuration)
  const originalPrice = booking.isCoachBooking
    ? (booking.coachPrice ?? getCoachPrice(booking.duration))
    : (originalLane ? getCustomerPrice(originalLane, booking.variantId ?? null, booking.duration) : 0)
      + addlCount * getCustomerPrice(originalLane!, null, booking.duration)
  const priceDiff = newPrice - originalPrice
  const creditToApply = !isCoach && priceDiff > 0 ? Math.min(creditBalance, priceDiff) : 0
  const estimatedTopUp = Math.max(0, priceDiff - creditToApply)
  // NI-3: on a decrease, credit only what was actually PAID (post-discount price),
  // pro-rata to the value removed — mirrors the server. Falls back to gross only if
  // the booking has no stored paid amount (legacy rows).
  const decreaseCredit = !isCoach && priceDiff < 0
    ? decreaseCreditCents(
        booking.priceInCents ?? Math.round(originalPrice * 100),
        Math.round(originalPrice * 100),
        Math.round(newPrice * 100)
      ) / 100
    : 0

  const hasChanges = selectedDate !== booking.date ||
    selectedStartHour !== booking.startHour ||
    effectiveDuration !== booking.duration ||
    selectedLaneId !== booking.laneId ||
    (selectedVariantId ?? null) !== (booking.variantId ?? null)

  const canSlotFit = canBookSlot(otherBookings, selectedLaneId, selectedDate, selectedStartHour, effectiveDuration)

  // Inside-the-cutoff carve-out banner (customers only). Server enforces; this informs.
  const insideWindowNote = useMemo(() => {
    if (isCoach) return null
    const [y, m, d] = booking.date.split('-').map(Number)
    const whole = Math.floor(booking.startHour)
    const mins = Math.round((booking.startHour - whole) * 60)
    const start = new Date(y, m - 1, d, whole, mins, 0)
    const hoursUntil = (start.getTime() - getAWSTNow().getTime()) / (1000 * 60 * 60)
    const cutoff = settings.customerCancellationHours ?? settings.cancellationHoursBefore ?? 2
    if (hoursUntil >= cutoff) return null
    const maxEarlier = settings.modifyMoveEarlierMaxHours ?? 1
    return `Within ${cutoff}h of your start time you can only move the start up to ${maxEarlier}h earlier, or extend the session (paying the difference). Other changes are locked.`
  }, [booking.date, booking.startHour, isCoach, settings])

  const handleConfirm = async () => {
    setError(null)
    setStep('processing')

    const res = await onModify({
      newDate: selectedDate,
      newStartHour: selectedStartHour,
      newDuration: effectiveDuration,
      newLaneId: selectedLaneId !== booking.laneId ? selectedLaneId : undefined,
      newVariantId: (selectedVariantId ?? null) !== (booking.variantId ?? null) ? selectedVariantId : undefined,
      newAdditionalLaneIds: booking.additionalLaneIds,
    })

    if (!res.success) {
      setError(res.error ?? 'Failed to modify the booking. Please try again.')
      setStep('confirm')
      return
    }

    // Customer price increase needs an online top-up → redirect to Stripe.
    if (res.requiresPayment && (res.topUpAmountCents ?? 0) > 0) {
      try {
        const { createTopUpCheckoutSession } = await import('../lib/stripe')
        const laneObj = LANES.find(l => l.id === selectedLaneId)
        const session = await createTopUpCheckoutSession({
          bookingId: booking.id,
          laneId: selectedLaneId,
          laneName: laneObj?.name ?? selectedLaneId,
          date: selectedDate,
          startHour: selectedStartHour,
          newDuration: effectiveDuration,
          customerName: booking.customerName,
          customerEmail: booking.customerEmail,
          topUpAmountCents: res.topUpAmountCents as number,
        })
        // SPEC_EMBEDDED_CHECKOUT — pay the difference in-app when available; else
        // hosted redirect (unchanged fallback). The modification is already applied
        // server-side (pending the top-up); the webhook confirms on payment.
        if (session?.clientSecret) { setEmbeddedTopUp({ clientSecret: session.clientSecret, bookingId: booking.id }); return }
        if (session?.url) { window.location.href = session.url; return }
        setError('Could not start checkout. Please try again.')
        setStep('confirm')
      } catch (err: any) {
        setError(getErrorMessage(err) ?? 'Could not start checkout. Please try again.')
        setStep('confirm')
      }
      return
    }

    // Applied immediately (coach / decrease / equal / credit-covered).
    const notes: string[] = []
    if ((res.creditAppliedCents ?? 0) > 0) notes.push(`$${((res.creditAppliedCents as number) / 100).toFixed(2)} account credit applied.`)
    if (res.credited && (res.creditIssuedCents ?? 0) > 0) notes.push(`$${((res.creditIssuedCents as number) / 100).toFixed(2)} credit added to your account.`)
    if ((res.droppedAthletes ?? []).length > 0) notes.push(`Removed (no longer fit): ${(res.droppedAthletes as string[]).join(', ')}.`)
    setResultNote(notes.join(' ') || null)
    setStep('success')
    setTimeout(() => onClose(), 3500)
  }

  const formatDate = (dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }
  const formatDuration = (mins: number) => {
    const h = Math.floor(mins / 60); const m = mins % 60
    if (h > 0 && m > 0) return `${h}hr ${m}min`
    if (h > 0) return `${h}hr`
    return `${mins}min`
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={step !== 'processing' ? onClose : undefined} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-lg overflow-hidden max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className={`p-5 text-white transition-all duration-500 ${
          step === 'success' ? 'bg-gradient-to-r from-green-500 to-emerald-500' :
          step === 'processing' ? 'bg-gradient-to-r from-blue-500 to-indigo-500' :
          'bg-gradient-to-r from-violet-500 to-purple-500'
        }`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">
                {step === 'success' ? '✓ Booking Updated' : step === 'processing' ? 'Saving…' : '✏️ Modify Booking'}
              </h3>
              <p className="text-white/80 text-sm mt-0.5">
                {step === 'success' ? 'Your changes are saved' :
                 step === 'processing' ? 'Please wait…' :
                 `${originalLane?.name ?? booking.laneId} — ${formatDate(booking.date)}`}
              </p>
            </div>
            {step !== 'processing' && step !== 'success' && (
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors">✕</button>
            )}
          </div>
        </div>

        {/* Processing */}
        {step === 'processing' && (
          <div className="p-8 flex flex-col items-center justify-center space-y-4">
            <div className="relative">
              <div className="w-16 h-16 border-4 border-blue-200 rounded-full" />
              <div className="absolute inset-0 w-16 h-16 border-4 border-transparent border-t-blue-500 rounded-full animate-spin" />
            </div>
            <p className="font-semibold text-gray-800 dark:text-gray-200">Updating your booking…</p>
          </div>
        )}

        {/* Success */}
        {step === 'success' && (
          <div className="p-8 flex flex-col items-center justify-center space-y-4">
            <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
            </div>
            <p className="font-bold text-lg text-gray-800 dark:text-gray-200">Booking Updated!</p>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 w-full space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Date</span><span className="font-medium text-gray-800 dark:text-gray-200">{formatDate(selectedDate)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Time</span><span className="font-medium text-gray-800 dark:text-gray-200">{formatTime(selectedStartHour)} - {formatTime(selectedStartHour + effectiveDuration / 60)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Lane</span><span className="font-medium text-gray-800 dark:text-gray-200">{selectedLane?.name}</span></div>
            </div>
            {resultNote && <p className="text-xs text-gray-500 text-center">{resultNote}</p>}
            <p className="text-xs text-gray-400 text-center">If your date, time, or lane changed, a new door access code has been issued.</p>
          </div>
        )}

        {/* Select Step */}
        {step === 'select' && (
          <div className="p-5 space-y-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 border border-gray-200 dark:border-gray-700">
              <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Current Booking</div>
              <div className="flex items-center gap-2 text-sm flex-wrap">
                <span>{originalLane?.icon ?? '🏏'}</span>
                <span className="font-medium text-gray-800 dark:text-gray-200">{originalLane?.name}</span>
                <span className="text-gray-400">·</span>
                <span className="text-gray-600 dark:text-gray-400">{formatDate(booking.date)}</span>
                <span className="text-gray-400">·</span>
                <span className="text-gray-600 dark:text-gray-400">{formatTime(booking.startHour)} - {formatTime(booking.startHour + booking.duration / 60)}</span>
              </div>
            </div>

            {insideWindowNote && (
              <div className="bg-amber-50 dark:bg-amber-900/10 rounded-xl p-3 border border-amber-200 dark:border-amber-800/50">
                <p className="text-xs text-amber-700 dark:text-amber-400">⏱️ {insideWindowNote}</p>
              </div>
            )}

            {/* Lane */}
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Lane</label>
              <div className="grid grid-cols-5 gap-2">
                {LANES.map(lane => (
                  <button key={lane.id} onClick={() => { setSelectedLaneId(lane.id); setSelectedVariantId(lane.variants?.[0]?.id) }}
                    className={`p-2 rounded-xl border-2 transition-all text-center ${
                      selectedLaneId === lane.id ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20 shadow-md' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                    }`}>
                    <div className="text-lg">{lane.icon}</div>
                    <div className="text-[10px] font-medium text-gray-700 dark:text-gray-300 mt-0.5">{lane.shortName}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Variant */}
            {selectedLane?.variants && selectedLane.variants.length > 0 && !isCoach && (
              <div>
                <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Machine Type</label>
                <div className="grid grid-cols-2 gap-3">
                  {selectedLane.variants.map(variant => (
                    <button key={variant.id} onClick={() => setSelectedVariantId(variant.id)}
                      className={`p-3 rounded-xl border-2 transition-all text-left ${
                        selectedVariantId === variant.id
                          ? variant.id.includes('truman') ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 shadow-md' : 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 shadow-md'
                          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                      }`}>
                      <div className="text-sm font-bold text-gray-800 dark:text-gray-200">{variant.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">${getCustomerPrice(selectedLane, variant.id, 60)}/hr</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Date */}
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Date</label>
              <div className="grid grid-cols-7 gap-1.5">
                {availableDates.map(d => {
                  const key = formatDateKey(d)
                  const dayName = d.toLocaleDateString('en-US', { weekday: 'short' })
                  const isSelected = key === selectedDate
                  const isOriginal = key === booking.date
                  return (
                    <button key={key} onClick={() => { setSelectedDate(key); setSelectedStartHour(getDefaultStartHourForDate(key)) }}
                      className={`p-1.5 rounded-lg border transition-all text-center ${
                        isSelected ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20 shadow-sm'
                          : isOriginal ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/10'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                      }`}>
                      <div className="text-[9px] font-medium text-gray-500">{dayName}</div>
                      <div className={`text-sm font-bold ${isSelected ? 'text-violet-700 dark:text-violet-400' : 'text-gray-800 dark:text-gray-200'}`}>{d.getDate()}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Time */}
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Time</label>
              {availableSlots.length === 0 ? (
                <div className="text-sm text-gray-500 bg-gray-50 dark:bg-gray-800 rounded-xl p-4 text-center">No available slots on this date for this lane.</div>
              ) : (
                <div className="grid grid-cols-4 gap-1.5 max-h-40 overflow-y-auto pr-1">
                  {availableSlots.map(h => {
                    const isSelected = h === selectedStartHour
                    const isOriginal = h === booking.startHour && selectedDate === booking.date
                    return (
                      <button key={h} onClick={() => setSelectedStartHour(h)}
                        className={`py-2 px-2 rounded-lg border text-xs font-medium transition-all ${
                          isSelected ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-400 shadow-sm'
                            : isOriginal ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-400'
                              : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300'
                        }`}>
                        {formatTime(h)}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Duration */}
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Duration</label>
              {isCoach ? (
                <select value={effectiveDuration} onChange={e => setSelectedDuration(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-sm">
                  {availableDurations.map(d => <option key={d} value={d}>{formatDuration(d)} — ${getCoachPrice(d)}</option>)}
                </select>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {availableDurations.map(d => (
                    <button key={d} onClick={() => setSelectedDuration(d)}
                      className={`p-3 rounded-xl border-2 transition-all text-left ${
                        effectiveDuration === d ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20 shadow-md' : 'border-gray-200 dark:border-gray-700'
                      }`}>
                      <div className="text-lg font-bold text-gray-800 dark:text-gray-200">${selectedLane ? getCustomerPrice(selectedLane, selectedVariantId ?? null, d) : 0}</div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">{formatDuration(d)}</div>
                      <div className="text-xs text-gray-500 mt-1">{formatTime(selectedStartHour)} - {formatTime(selectedStartHour + d / 60)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Coach: jump to the athlete allocation editor for this booking. */}
            {isCoach && booking.isCoachBooking && onEditAllocation && (
              <button
                type="button"
                onClick={onEditAllocation}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-emerald-500 text-emerald-700 dark:text-emerald-400 font-semibold hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all"
              >
                🏏 Edit Athlete Allocation
              </button>
            )}

            {/* Price comparison */}
            {hasChanges && (
              <div className="bg-violet-50 dark:bg-violet-900/10 rounded-xl p-3 border border-violet-200 dark:border-violet-800/50 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Original</span><span className="font-medium">${originalPrice.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">New</span><span className="font-medium">${newPrice.toFixed(2)}</span></div>
                {isCoach ? (
                  priceDiff !== 0 && (
                    <p className="text-[10px] text-violet-600 dark:text-violet-400 mt-1">Coach rate adjusted on your statement — no online payment.</p>
                  )
                ) : priceDiff > 0 ? (
                  <>
                    {creditToApply > 0 && <div className="flex justify-between"><span className="text-blue-500">Account credit</span><span className="font-medium text-blue-600">-${creditToApply.toFixed(2)}</span></div>}
                    <div className="flex justify-between border-t border-violet-200 dark:border-violet-700 pt-1"><span className="font-semibold">You pay</span><span className="font-bold text-red-600">${estimatedTopUp.toFixed(2)}</span></div>
                    {estimatedTopUp > 0 && <p className="text-[10px] text-gray-500 mt-1">You'll pay the difference securely with Stripe.</p>}
                  </>
                ) : priceDiff < 0 ? (
                  <div className="flex justify-between border-t border-violet-200 dark:border-violet-700 pt-1"><span className="font-semibold">Account credit added</span><span className="font-bold text-green-600">+${decreaseCredit.toFixed(2)}</span></div>
                ) : (
                  <p className="text-[10px] text-gray-500 mt-1">No change in price.</p>
                )}
              </div>
            )}

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
                <p className="text-sm text-red-700 dark:text-red-400">⚠️ {error}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={onClose} className="flex-1 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-all">Cancel</button>
              <button
                onClick={() => { setError(null); setStep('confirm') }}
                disabled={!hasChanges || !canSlotFit || availableSlots.length === 0 || availableDurations.length === 0}
                className="flex-[2] py-3 bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 text-white font-semibold rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                {!hasChanges ? 'No Changes' : !canSlotFit ? 'Slot Unavailable' : 'Review Changes →'}
              </button>
            </div>
          </div>
        )}

        {/* Confirm Step */}
        {step === 'confirm' && (
          <div className="p-5 space-y-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 space-y-3 text-sm">
              <h4 className="font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wider">Change Summary</h4>
              <div className="space-y-1">
                <div className="text-[10px] font-semibold text-red-500 uppercase">From</div>
                <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/10 rounded-lg p-2 flex-wrap">
                  <span>{originalLane?.icon}</span>
                  <span className="font-medium text-gray-700 dark:text-gray-300">{originalLane?.name}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600 dark:text-gray-400">{formatDate(booking.date)}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600 dark:text-gray-400">{formatTime(booking.startHour)} - {formatTime(booking.startHour + booking.duration / 60)}</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-[10px] font-semibold text-green-500 uppercase">To</div>
                <div className="flex items-center gap-2 bg-green-50 dark:bg-green-900/10 rounded-lg p-2 flex-wrap">
                  <span>{selectedLane?.icon}</span>
                  <span className="font-medium text-gray-700 dark:text-gray-300">{selectedLane?.name}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600 dark:text-gray-400">{formatDate(selectedDate)}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600 dark:text-gray-400">{formatTime(selectedStartHour)} - {formatTime(selectedStartHour + effectiveDuration / 60)}</span>
                </div>
              </div>
              {!isCoach && priceDiff > 0 && (
                <div className="flex justify-between items-center border-t border-gray-200 dark:border-gray-700 pt-2">
                  <span className="font-semibold">You pay {creditToApply > 0 ? '(after credit)' : ''}</span>
                  <span className="font-bold text-red-600">${estimatedTopUp.toFixed(2)}</span>
                </div>
              )}
              {!isCoach && priceDiff < 0 && (
                <div className="flex justify-between items-center border-t border-gray-200 dark:border-gray-700 pt-2">
                  <span className="font-semibold">Account credit added</span>
                  <span className="font-bold text-green-600">+${decreaseCredit.toFixed(2)}</span>
                </div>
              )}
            </div>

            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 border border-blue-200 dark:border-blue-800/50">
              <p className="text-xs text-blue-700 dark:text-blue-400">
                <strong>Note:</strong> if the date, time, or lane changes, a new door access code is issued and the old one stops working.
              </p>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
                <p className="text-sm text-red-700 dark:text-red-400">⚠️ {error}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => { setStep('select'); setError(null) }} className="flex-1 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-all">← Back</button>
              <button onClick={handleConfirm}
                className="flex-[2] py-3 bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 text-white font-semibold rounded-xl shadow-lg transition-all">
                {!isCoach && estimatedTopUp > 0 ? `Pay $${estimatedTopUp.toFixed(2)} & Confirm` : 'Confirm Changes'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
    {/* SPEC_EMBEDDED_CHECKOUT — in-app payment for the top-up. onComplete: the
        webhook confirms the modification. onClose (abandon): mirror the old
        cancel_url leg (cancelUnpaidCheckout) and return to the confirm step. */}
    {embeddedTopUp && (
      <EmbeddedCheckoutModal
        clientSecret={embeddedTopUp.clientSecret}
        onComplete={() => { setEmbeddedTopUp(null); setResultNote('Top-up paid — your booking is updated.'); setStep('success'); setTimeout(() => onClose(), 3000) }}
        onClose={() => {
          const ec = embeddedTopUp
          setEmbeddedTopUp(null)
          setStep('confirm')
          if (ec?.bookingId) { cancelUnpaidCheckout(ec.bookingId).catch(() => { /* backstops will catch it */ }) }
        }}
      />
    )}
    </>
  )
}
