import { useState, useMemo } from 'react'
import {
  LANES, formatDateKey, formatTime, canBookSlot, getCustomerPrice, getCoachPrice,
  getCoachDurations, getCustomerDurations, CLOSING_HOUR, OPENING_HOUR,
  type Booking, type Lane,
} from '../lib/booking-data'
import { generateAccessCode, formatAccessCode } from '../lib/access-code'

interface RescheduleModalProps {
  booking: Booking
  allBookings: Booking[]
  onClose: () => void
  onReschedule: (opts: {
    newDate: string; newStartHour: number; newDuration: number;
    newLaneId?: string; newVariantId?: string;
    newAdditionalLaneIds?: string[]; newAccessCode?: string;
  }) => Promise<{ success: boolean; error?: string }>
  isCoach: boolean
}

export default function RescheduleModal({ booking, allBookings, onClose, onReschedule, isCoach }: RescheduleModalProps) {
  const originalLane = LANES.find(l => l.id === booking.laneId)

  // Generate next 14 days for date picker
  const availableDates = useMemo(() => {
    const dates: Date[] = []
    const now = new Date()
    const awstStr = now.toLocaleString('en-US', { timeZone: 'Australia/Perth' })
    const awstNow = new Date(awstStr)
    for (let i = 0; i < 14; i++) {
      const d = new Date(awstNow)
      d.setDate(awstNow.getDate() + i)
      d.setHours(0, 0, 0, 0)
      dates.push(d)
    }
    return dates
  }, [])

  const [selectedDate, setSelectedDate] = useState<string>(booking.date)
  const [selectedLaneId, setSelectedLaneId] = useState<string>(booking.laneId)
  const [selectedVariantId, setSelectedVariantId] = useState<string | undefined>(booking.variantId ?? undefined)
  const [selectedStartHour, setSelectedStartHour] = useState<number>(booking.startHour)
  const [selectedDuration, setSelectedDuration] = useState<number>(booking.duration)
  const [step, setStep] = useState<'select' | 'confirm' | 'processing' | 'success'>('select')
  const [error, setError] = useState<string | null>(null)

  const selectedLane = LANES.find(l => l.id === selectedLaneId) ?? originalLane

  // Filter out the current booking from conflict checks
  const otherBookings = useMemo(() =>
    allBookings.filter(b => b.id !== booking.id && b.status !== 'cancelled'),
    [allBookings, booking.id]
  )

  // Available time slots for the selected date + lane
  const availableSlots = useMemo(() => {
    const slots: number[] = []
    const laneBookings = otherBookings.filter(b => b.laneId === selectedLaneId && b.date === selectedDate)

    for (let h = OPENING_HOUR; h < CLOSING_HOUR; h += 0.5) {
      const isOccupied = laneBookings.some(b => {
        const bEnd = b.startHour + b.duration / 60
        return h >= b.startHour && h < bEnd
      })
      if (!isOccupied) slots.push(h)
    }
    return slots
  }, [otherBookings, selectedLaneId, selectedDate])

  // Available durations for the selected slot
  const availableDurations = useMemo(() => {
    if (isCoach) return getCoachDurations(otherBookings, selectedLaneId, selectedDate, selectedStartHour)
    return getCustomerDurations(otherBookings, selectedLaneId, selectedDate, selectedStartHour)
  }, [otherBookings, selectedLaneId, selectedDate, selectedStartHour, isCoach])

  // Auto-correct duration if not available
  const effectiveDuration = availableDurations.includes(selectedDuration)
    ? selectedDuration
    : availableDurations[0] ?? 60

  // Price calculation
  const newPrice = isCoach
    ? getCoachPrice(effectiveDuration)
    : selectedLane ? getCustomerPrice(selectedLane, selectedVariantId ?? null, effectiveDuration) : 0

  const originalPrice = booking.isCoachBooking
    ? (booking.coachPrice ?? getCoachPrice(booking.duration))
    : originalLane ? getCustomerPrice(originalLane, booking.variantId ?? null, booking.duration) : 0

  const priceDiff = newPrice - originalPrice

  // Check if anything actually changed
  const hasChanges = selectedDate !== booking.date ||
    selectedStartHour !== booking.startHour ||
    effectiveDuration !== booking.duration ||
    selectedLaneId !== booking.laneId

  const canSlotFit = canBookSlot(otherBookings, selectedLaneId, selectedDate, selectedStartHour, effectiveDuration)

  const handleConfirm = async () => {
    setError(null)
    setStep('processing')

    const newAccessCode = generateAccessCode()
    const result = await onReschedule({
      newDate: selectedDate,
      newStartHour: selectedStartHour,
      newDuration: effectiveDuration,
      newLaneId: selectedLaneId !== booking.laneId ? selectedLaneId : undefined,
      newVariantId: selectedVariantId !== booking.variantId ? selectedVariantId : undefined,
      newAccessCode: newAccessCode,
    })

    if (result.success) {
      setStep('success')
      setTimeout(() => onClose(), 3000)
    } else {
      setError(result.error ?? 'Failed to reschedule. Please try again.')
      setStep('confirm')
    }
  }

  const formatDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number)
    return new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  const formatDuration = (mins: number) => {
    const hrs = Math.floor(mins / 60)
    const m = mins % 60
    if (hrs > 0 && m > 0) return `${hrs}hr ${m}min`
    if (hrs > 0) return `${hrs}hr`
    return `${mins}min`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={step !== 'processing' ? onClose : undefined} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-lg overflow-hidden max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className={`p-5 text-white transition-all duration-500 ${
          step === 'success' ? 'bg-gradient-to-r from-green-500 to-emerald-500' :
          step === 'processing' ? 'bg-gradient-to-r from-blue-500 to-indigo-500' :
          'bg-gradient-to-r from-amber-500 to-orange-500'
        }`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">
                {step === 'success' ? '✓ Rescheduled!' : step === 'processing' ? 'Rescheduling...' : '📅 Reschedule Booking'}
              </h3>
              <p className="text-white/80 text-sm mt-0.5">
                {step === 'success' ? 'Your booking has been moved' :
                 step === 'processing' ? 'Please wait...' :
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
            <p className="font-semibold text-gray-800 dark:text-gray-200">Moving your booking...</p>
          </div>
        )}

        {/* Success */}
        {step === 'success' && (
          <div className="p-8 flex flex-col items-center justify-center space-y-4">
            <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
            </div>
            <p className="font-bold text-lg text-gray-800 dark:text-gray-200">Booking Rescheduled!</p>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 w-full space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">New Date</span><span className="font-medium text-gray-800 dark:text-gray-200">{formatDate(selectedDate)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">New Time</span><span className="font-medium text-gray-800 dark:text-gray-200">{formatTime(selectedStartHour)} - {formatTime(selectedStartHour + effectiveDuration / 60)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Lane</span><span className="font-medium text-gray-800 dark:text-gray-200">{selectedLane?.name}</span></div>
            </div>
            <p className="text-xs text-gray-500">A new door access code has been generated for your rescheduled session.</p>
          </div>
        )}

        {/* Select Step */}
        {step === 'select' && (
          <div className="p-5 space-y-4">
            {/* Current booking summary */}
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 border border-gray-200 dark:border-gray-700">
              <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Current Booking</div>
              <div className="flex items-center gap-2 text-sm">
                <span>{originalLane?.icon ?? '🏏'}</span>
                <span className="font-medium text-gray-800 dark:text-gray-200">{originalLane?.name}</span>
                <span className="text-gray-400">·</span>
                <span className="text-gray-600 dark:text-gray-400">{formatDate(booking.date)}</span>
                <span className="text-gray-400">·</span>
                <span className="text-gray-600 dark:text-gray-400">{formatTime(booking.startHour)} - {formatTime(booking.startHour + booking.duration / 60)}</span>
              </div>
            </div>

            {/* Lane selector */}
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Lane</label>
              <div className="grid grid-cols-5 gap-2">
                {LANES.map(lane => (
                  <button key={lane.id} onClick={() => { setSelectedLaneId(lane.id); setSelectedVariantId(lane.variants?.[0]?.id) }}
                    className={`p-2 rounded-xl border-2 transition-all text-center ${
                      selectedLaneId === lane.id
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20 shadow-md'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                    }`}>
                    <div className="text-lg">{lane.icon}</div>
                    <div className="text-[10px] font-medium text-gray-700 dark:text-gray-300 mt-0.5">{lane.shortName}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Variant selector */}
            {selectedLane?.variants && selectedLane.variants.length > 0 && (
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
                      <div className="text-xs text-gray-500 mt-0.5">${variant.pricePerHour}/hr</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Date picker */}
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">New Date</label>
              <div className="grid grid-cols-7 gap-1.5">
                {availableDates.map(d => {
                  const key = formatDateKey(d)
                  const dayName = d.toLocaleDateString('en-US', { weekday: 'short' })
                  const dayNum = d.getDate()
                  const isSelected = key === selectedDate
                  const isOriginal = key === booking.date
                  return (
                    <button key={key} onClick={() => { setSelectedDate(key); setSelectedStartHour(OPENING_HOUR) }}
                      className={`p-1.5 rounded-lg border transition-all text-center ${
                        isSelected
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20 shadow-sm'
                          : isOriginal
                            ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/10'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                      }`}>
                      <div className="text-[9px] font-medium text-gray-500">{dayName}</div>
                      <div className={`text-sm font-bold ${isSelected ? 'text-amber-700 dark:text-amber-400' : 'text-gray-800 dark:text-gray-200'}`}>{dayNum}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Time picker */}
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">New Time</label>
              {availableSlots.length === 0 ? (
                <div className="text-sm text-gray-500 bg-gray-50 dark:bg-gray-800 rounded-xl p-4 text-center">
                  No available slots on this date for this lane.
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-1.5 max-h-40 overflow-y-auto pr-1">
                  {availableSlots.map(h => {
                    const isSelected = h === selectedStartHour
                    const isOriginal = h === booking.startHour && selectedDate === booking.date
                    return (
                      <button key={h} onClick={() => setSelectedStartHour(h)}
                        className={`py-2 px-2 rounded-lg border text-xs font-medium transition-all ${
                          isSelected
                            ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 shadow-sm'
                            : isOriginal
                              ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-400'
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
                  {availableDurations.map(d => (
                    <option key={d} value={d}>{formatDuration(d)} — ${getCoachPrice(d)}</option>
                  ))}
                </select>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {availableDurations.map(d => (
                    <button key={d} onClick={() => setSelectedDuration(d)}
                      className={`p-3 rounded-xl border-2 transition-all text-left ${
                        effectiveDuration === d ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20 shadow-md' : 'border-gray-200 dark:border-gray-700'
                      }`}>
                      <div className="text-lg font-bold text-gray-800 dark:text-gray-200">
                        ${selectedLane ? getCustomerPrice(selectedLane, selectedVariantId ?? null, d) : 0}
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">{formatDuration(d)}</div>
                      <div className="text-xs text-gray-500 mt-1">{formatTime(selectedStartHour)} - {formatTime(selectedStartHour + d / 60)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Price comparison */}
            {hasChanges && (
              <div className="bg-amber-50 dark:bg-amber-900/10 rounded-xl p-3 border border-amber-200 dark:border-amber-800/50 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Original</span><span className="font-medium">${originalPrice}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">New</span><span className="font-medium">${newPrice}</span></div>
                {priceDiff !== 0 && (
                  <div className="flex justify-between border-t border-amber-200 dark:border-amber-700 pt-1">
                    <span className="font-semibold">{priceDiff > 0 ? 'Difference' : 'Savings'}</span>
                    <span className={`font-bold ${priceDiff > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {priceDiff > 0 ? '+' : '-'}${Math.abs(priceDiff)}
                    </span>
                  </div>
                )}
                {!isCoach && priceDiff > 0 && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
                    Price difference will be handled at the facility. No additional online payment required.
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
                <p className="text-sm text-red-700 dark:text-red-400">⚠️ {error}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button onClick={onClose}
                className="flex-1 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-all">
                Cancel
              </button>
              <button
                onClick={() => { setError(null); setStep('confirm') }}
                disabled={!hasChanges || !canSlotFit || availableSlots.length === 0 || availableDurations.length === 0}
                className="flex-[2] py-3 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                {!hasChanges ? 'No Changes' : !canSlotFit ? 'Slot Unavailable' : 'Review Changes →'}
              </button>
            </div>
          </div>
        )}

        {/* Confirm Step */}
        {step === 'confirm' && (
          <div className="p-5 space-y-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 space-y-3 text-sm">
              <h4 className="font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wider">Reschedule Summary</h4>

              {/* From */}
              <div className="space-y-1">
                <div className="text-[10px] font-semibold text-red-500 uppercase">From</div>
                <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/10 rounded-lg p-2">
                  <span>{originalLane?.icon}</span>
                  <span className="font-medium text-gray-700 dark:text-gray-300">{originalLane?.name}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600 dark:text-gray-400">{formatDate(booking.date)}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600 dark:text-gray-400">{formatTime(booking.startHour)} - {formatTime(booking.startHour + booking.duration / 60)}</span>
                </div>
              </div>

              {/* To */}
              <div className="space-y-1">
                <div className="text-[10px] font-semibold text-green-500 uppercase">To</div>
                <div className="flex items-center gap-2 bg-green-50 dark:bg-green-900/10 rounded-lg p-2">
                  <span>{selectedLane?.icon}</span>
                  <span className="font-medium text-gray-700 dark:text-gray-300">{selectedLane?.name}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600 dark:text-gray-400">{formatDate(selectedDate)}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600 dark:text-gray-400">{formatTime(selectedStartHour)} - {formatTime(selectedStartHour + effectiveDuration / 60)}</span>
                </div>
              </div>

              {priceDiff !== 0 && (
                <div className="flex justify-between items-center border-t border-gray-200 dark:border-gray-700 pt-2">
                  <span className="font-semibold">Price {priceDiff > 0 ? 'Increase' : 'Decrease'}</span>
                  <span className={`font-bold ${priceDiff > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {priceDiff > 0 ? '+' : '-'}${Math.abs(priceDiff)}
                  </span>
                </div>
              )}
            </div>

            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 border border-blue-200 dark:border-blue-800/50">
              <p className="text-xs text-blue-700 dark:text-blue-400">
                <strong>Note:</strong> A new door access code will be generated for your rescheduled session. Your old code will no longer work.
              </p>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
                <p className="text-sm text-red-700 dark:text-red-400">⚠️ {error}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => { setStep('select'); setError(null) }}
                className="flex-1 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-all">
                ← Back
              </button>
              <button onClick={handleConfirm}
                className="flex-[2] py-3 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold rounded-xl shadow-lg transition-all">
                Confirm Reschedule
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
