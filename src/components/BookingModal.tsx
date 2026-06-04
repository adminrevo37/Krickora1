import { useState, useMemo, useEffect } from 'react'
import { useQuery, useConvex } from 'convex/react'
import { getErrorMessage } from '../lib/errors'
import {
  LANES, canBookSlot, formatDateKey, formatTime, getCustomerPrice, getCoachPrice, getCoachPerHourRate,
  getCoachDurations, getCustomerDurations, getValidCoachStartTimes,
  generateGoogleCalendarUrl, roundCoachBookingDuration, getMinCoachDurationFromAthletes,
  type Booking, type Lane, type LaneVariant, type AthleteSlot,
} from '../lib/booking-data'
import { createCheckoutSession, type CheckoutSessionRequest } from '../lib/stripe'
import { getSettingsStore } from '../lib/settings-store'
import { useLaneConfigState } from '../hooks/useLaneConfig'
import { resolveLaneAt, getLaneWarning, variantLabel, variantRatePerHour } from '../lib/lanes'
import { useAuth } from '../hooks/useAuth'
import AuthModal from './AuthModal'
import { formatAccessCode } from '../lib/access-code'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'


// SPEC_COACH_SESSION_LENGTH: athlete allocation slot options {30,45,60,75,90} +
// a 30-min floor (mirrors AthleteAllocationEditor so the create + edit flows match).
const ALLOC_OPTIONS = [30, 45, 60, 75, 90]
const fitDurations = (maxMins: number): number[] => {
  const fit = ALLOC_OPTIONS.filter(m => m <= maxMins + 0.001)
  return fit.length ? fit : [30]
}
// Snap an arbitrary/legacy value to the largest option that fits ≤ value (≥30).
const snapDuration = (value: number, maxMins: number): number => {
  const fit = fitDurations(maxMins)
  const atOrBelow = fit.filter(o => o <= value + 0.001)
  return atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : fit[0]
}

interface BookingModalProps {
  lane: Lane; date: Date; startHour: number; existingBookings: Booking[]
  onClose: () => void; onConfirm: (booking: Booking) => void
}

export default function BookingModal({ lane, date, startHour, existingBookings, onClose, onConfirm }: BookingModalProps) {
  const { user, isCoach, getCreditBalance, customerRecord } = useAuth()
  useLaneConfigState() // SPEC_RECONFIGURABLE_LANES: react to layout changes
  // Resolve the lane's segment for THIS (date, startHour): drives variant options,
  // the duration cap (a booking may not cross a segment boundary, §2.14), the
  // date-resolved display name + icon, and the auto warning.
  const dkForSeg = formatDateKey(date)
  const resolvedLane = resolveLaneAt(lane.id, dkForSeg, startHour)
  const seg = resolvedLane.segment
  const resolvedLaneName = resolvedLane.name
  const resolvedLaneIcon = resolvedLane.icon
  const laneWarning = getLaneWarning(lane.id, dkForSeg, startHour)
  const laneNm = (id: string) => resolveLaneAt(id, dkForSeg, startHour).name
  const settingsForPrice = getSettingsStore().get()
  const variantOptions = useMemo<LaneVariant[]>(
    () => seg.variants.map((vid) => ({
      id: vid,
      name: variantLabel(vid, seg.variants.length === 1 && seg.mode === 'BM'),
      pricePerHour: variantRatePerHour(vid, settingsForPrice),
      price90Min: 0,
      description: '',
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seg.variants.join(','), seg.mode, settingsForPrice.customerPricePerHour, settingsForPrice.trumanPricePerHour]
  )
  const hasVariantChoice = !isCoach && variantOptions.length > 1
  const [selectedVariant, setSelectedVariant] = useState<LaneVariant | null>(variantOptions[0] ?? null)
  const [additionalLanes, setAdditionalLanes] = useState<string[]>([])

  const availableDurations = useMemo(() => {
    const base = isCoach
      ? getCoachDurations(existingBookings, lane.id, dkForSeg, startHour)
      : getCustomerDurations(existingBookings, lane.id, dkForSeg, startHour)
    // Cap so the booking can't cross into the next segment (§2.14).
    return base.filter((d) => startHour + d / 60 <= seg.endHour + 1e-9)
  }, [existingBookings, lane.id, dkForSeg, startHour, isCoach, seg.endHour])

  const [duration, setDuration] = useState<number>(() => availableDurations.length > 0 ? availableDurations[0] : 60)
  const validCoachStarts = useMemo(() => getValidCoachStartTimes(date), [date])
  const isValidCoachStart = !isCoach || validCoachStarts.includes(startHour)

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [step, setStep] = useState<'details' | 'confirm' | 'processing' | 'success'>('details')
  const [error, setError] = useState<string | null>(null)
  const [confirmedBooking, setConfirmedBooking] = useState<Booking | null>(null)
  const [showAuth, setShowAuth] = useState(false)
  const [applyCredit, setApplyCredit] = useState(false)

  // Discount code state
  const [discountCode, setDiscountCode] = useState('')
  const [appliedDiscount, setAppliedDiscount] = useState<{ code: string; discount: number; type: string; amountOff: number; label: string; bypassStripe: boolean } | null>(null)
  const [discountError, setDiscountError] = useState<string | null>(null)
  const [pendingDiscountCode, setPendingDiscountCode] = useState<string | null>(null)
  const [discountValidating, setDiscountValidating] = useState(false)

  // Live validation of discount code against Convex (fires only when pendingDiscountCode is set)
  const discountQueryResult = useQuery(
    api.queries.validateDiscountCode,
    pendingDiscountCode !== null ? { code: pendingDiscountCode, customerEmail: user?.email ?? undefined } : 'skip'
  )
  useEffect(() => {
    if (pendingDiscountCode === null) return
    if (discountQueryResult === undefined) { setDiscountValidating(true); return }
    setDiscountValidating(false)
    if (!discountQueryResult) {
      setDiscountError('Invalid or expired discount code.')
      setPendingDiscountCode(null)
    } else {
      setAppliedDiscount({ code: pendingDiscountCode, ...discountQueryResult })
      setDiscountError(null)
      setPendingDiscountCode(null)
    }
  }, [discountQueryResult, pendingDiscountCode])

  // Coach athlete tracking
  const [athleteSlots, setAthleteSlots] = useState<AthleteSlot[]>([])
  const [selectedAthleteId, setSelectedAthleteId] = useState('')
  const [newAthleteStart, setNewAthleteStart] = useState(startHour)
  // Default the new-athlete slot to the coach's preferred session length (clamped ≤90).
  const [newAthleteDuration, setNewAthleteDuration] = useState(() => Math.min((customerRecord as any)?.defaultSessionDuration ?? 60, 90))
  const [athleteDropdownOpen, setAthleteDropdownOpen] = useState(false)
  const [athleteSearchQuery, setAthleteSearchQuery] = useState('')

  // Rounding notice for coach
  const [roundingNotice, setRoundingNotice] = useState<string | null>(null)

  // Fetch coach's assigned athletes from Convex
  const coachIdForQuery = customerRecord?._id ?? user?.email ?? ''
  const coachAthletes = useQuery(
    api.queries.listAthletesByCoach,
    isCoach && coachIdForQuery ? { coachId: coachIdForQuery } : "skip"
  )

  const dateKey = formatDateKey(date)
  const endHour = startHour + duration / 60
  const price = isCoach ? getCoachPrice(duration) : getCustomerPrice(lane, selectedVariant?.id ?? null, duration)
  const creditBalance = user ? getCreditBalance(user.id) : 0
  const customerName = user?.name ?? ''
  const customerEmail = user?.email ?? ''
  const createBookingForStripe = useMutation(api.mutations.createBooking)
  const convex = useConvex()
  // C3: the door code is generated SERVER-SIDE. After the booking persists, read
  // the real code back (the booking is inserted synchronously, so it's there).
  const fetchServerCode = async (id: string): Promise<string | undefined> => {
    for (let i = 0; i < 6; i++) {
      const bk: any = await convex.query(api.queries.getBooking, { id: id as any }).catch(() => null)
      if (bk?.accessCode) return bk.accessCode as string
      await new Promise(r => setTimeout(r, 250))
    }
    return undefined
  }

  const otherLanes = LANES.filter(l => l.id !== lane.id)
  const availableAdditionalLanes = otherLanes.filter(l => canBookSlot(existingBookings, l.id, dateKey, startHour, duration))

  // Multi-lane cap (SPEC_BOOKING_WINDOW #4) — customers only; coaches uncapped.
  // Cap counts the primary lane, so the max number of ADDITIONAL lanes is cap - 1.
  const maxLanesPerBooking = getSettingsStore().get().customerMaxLanesPerBooking ?? 3
  const maxAdditionalLanes = isCoach ? Infinity : Math.max(0, maxLanesPerBooking - 1)

  const toggleAdditionalLane = (laneId: string) => {
    setAdditionalLanes(prev => {
      if (prev.includes(laneId)) return prev.filter(id => id !== laneId)
      if (prev.length >= maxAdditionalLanes) return prev // cap reached
      return [...prev, laneId]
    })
  }

  const additionalLanePrice = additionalLanes.reduce((sum, lid) => {
    const l = LANES.find(la => la.id === lid)
    if (!l) return sum
    return sum + (isCoach ? getCoachPrice(duration) : getCustomerPrice(l, null, duration))
  }, 0)

  // Pricing order MUST mirror the server (convex/mutations.ts createBooking +
  // getCheckoutAmountCents): the discount applies to the GROSS (base + additional
  // lanes), THEN account credit reduces the post-discount total. Keeping this
  // identical means this preview equals what Stripe actually charges (SSOT/R1).
  const priceBeforeDiscount = price + additionalLanePrice

  const discountAmount = appliedDiscount
    ? appliedDiscount.type === 'fixed'
      ? Math.min(priceBeforeDiscount, appliedDiscount.amountOff)
      : Math.round(priceBeforeDiscount * appliedDiscount.discount / 100)
    : 0
  const afterDiscount = Math.max(0, priceBeforeDiscount - discountAmount)

  const creditToApply = applyCredit ? Math.min(creditBalance, afterDiscount) : 0
  const totalPrice = Math.max(0, afterDiscount - creditToApply)

  const handleApplyDiscount = () => {
    setDiscountError(null)
    const code = discountCode.trim().toLowerCase()
    if (!code) { setDiscountError('Please enter a discount code.'); return }
    setPendingDiscountCode(code)
  }

  const handleRemoveDiscount = () => {
    setAppliedDiscount(null)
    setDiscountCode('')
    setDiscountError(null)
    setPendingDiscountCode(null)
    setDiscountValidating(false)
  }

  // Resync duration when available durations change (e.g. after bookings load)
  useEffect(() => {
    if (availableDurations.length > 0 && !availableDurations.includes(duration)) {
      setDuration(availableDurations[0])
    }
  }, [availableDurations])

  // Keep the selected variant valid for the resolved segment (SPEC_RECONFIGURABLE_LANES)
  useEffect(() => {
    if (variantOptions.length && !variantOptions.some((v) => v.id === selectedVariant?.id)) {
      setSelectedVariant(variantOptions[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantOptions])

  // Auto-round duration when athlete slots change
  useEffect(() => {
    if (!isCoach || athleteSlots.length === 0) {
      setRoundingNotice(null)
      return
    }
    const minDuration = getMinCoachDurationFromAthletes(startHour, athleteSlots)
    const rawDuration = roundCoachBookingDuration(startHour, athleteSlots)

    let hasQuarterEnd = false
    for (const slot of athleteSlots) {
      const slotEndHour = slot.startHour + slot.durationMinutes / 60
      const endMinutes = Math.round((slotEndHour - Math.floor(slotEndHour)) * 60)
      if (endMinutes === 15 || endMinutes === 45) {
        hasQuarterEnd = true
        break
      }
    }

    if (hasQuarterEnd && rawDuration > duration) {
      const validDuration = availableDurations.find(d => d >= rawDuration) ?? rawDuration
      if (availableDurations.includes(validDuration)) {
        setDuration(validDuration)
        const roundedEnd = startHour + validDuration / 60
        setRoundingNotice(`Booking rounded up to ${formatTime(roundedEnd)} to cover athlete sessions ending on :15 or :45`)
      }
    } else if (minDuration > duration) {
      const validDuration = availableDurations.find(d => d >= minDuration) ?? minDuration
      if (availableDurations.includes(validDuration)) {
        setDuration(validDuration)
      }
      setRoundingNotice(null)
    } else {
      setRoundingNotice(null)
    }
  }, [athleteSlots, startHour, isCoach, availableDurations])

  // Get athletes already allocated (to exclude from dropdown)
  const allocatedAthleteNames = useMemo(() => {
    return new Set(athleteSlots.map(s => s.athleteName.toLowerCase().trim()).filter(Boolean))
  }, [athleteSlots])

  // Filter athletes for dropdown
  const availableAthletes = useMemo(() => {
    const all = coachAthletes ?? []
    const filtered = all.filter(a => !allocatedAthleteNames.has(a.name.toLowerCase().trim()))
    if (!athleteSearchQuery.trim()) return filtered
    return filtered.filter(a =>
      a.name.toLowerCase().includes(athleteSearchQuery.toLowerCase()) ||
      a.email.toLowerCase().includes(athleteSearchQuery.toLowerCase())
    )
  }, [coachAthletes, allocatedAthleteNames, athleteSearchQuery])

  const addAthleteSlot = (athlete: { _id: string; name: string }) => {
    if (!athlete.name.trim()) return
    const bookingEnd = startHour + duration / 60
    const slotEnd = newAthleteStart + newAthleteDuration / 60
    if (slotEnd > bookingEnd) {
      const neededDuration = Math.ceil((slotEnd - startHour) * 60 / 30) * 30
      if (availableDurations.includes(neededDuration)) {
        setDuration(neededDuration)
      } else {
        return
      }
    }
    const newSlot: AthleteSlot = {
      athleteId: athlete._id,
      athleteName: athlete.name.trim(),
      startHour: newAthleteStart,
      durationMinutes: effNewAthleteDuration,
    }
    setAthleteSlots(prev => [...prev, newSlot])
    setSelectedAthleteId('')
    setAthleteDropdownOpen(false)
    setAthleteSearchQuery('')
  }

  const removeAthleteSlot = (idx: number) => setAthleteSlots(prev => prev.filter((_, i) => i !== idx))

  const updateAthleteSlot = (idx: number, field: 'startHour' | 'durationMinutes', value: number) => {
    setAthleteSlots(prev => prev.map((s, i) => {
      if (i !== idx) return s
      if (field === 'startHour') {
        const bookingEnd = startHour + duration / 60
        const maxDur = Math.round((bookingEnd - value) * 60)
        return { ...s, startHour: value, durationMinutes: snapDuration(s.durationMinutes, maxDur) }
      }
      return { ...s, durationMinutes: value }
    }))
  }

  const getSlotStartOptions = (_slotIdx?: number) => {
    const opts: number[] = []
    const end = startHour + duration / 60
    for (let h = startHour; h < end; h += 0.25) opts.push(Math.round(h * 100) / 100)
    return opts
  }

  const getSlotDurationOptions = (slotStart: number) => {
    const maxMins = Math.round((startHour + duration / 60 - slotStart) * 60)
    return fitDurations(maxMins)
  }

  const athleteStartOptions = useMemo(() => {
    const opts: number[] = []
    for (let h = startHour; h < startHour + duration / 60; h += 0.25) opts.push(h)
    return opts
  }, [startHour, duration])

  const athleteDurationOptions = useMemo(() => {
    const maxMins = Math.round((startHour + duration / 60 - newAthleteStart) * 60)
    return fitDurations(maxMins)
  }, [startHour, duration, newAthleteStart])

  // Keep the new-athlete duration valid for the chosen start (snap if it no longer fits).
  const effNewAthleteDuration = useMemo(
    () => athleteDurationOptions.includes(newAthleteDuration)
      ? newAthleteDuration
      : athleteDurationOptions[athleteDurationOptions.length - 1] ?? 30,
    [athleteDurationOptions, newAthleteDuration],
  )

  const formatTimeDetailed = (h: number): string => {
    const whole = Math.floor(h)
    const mins = Math.round((h - whole) * 60)
    const period = whole >= 12 ? 'pm' : 'am'
    const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole
    return mins > 0 ? `${display}:${mins.toString().padStart(2, '0')}${period}` : `${display}${period}`
  }

  const handleContinueToPayment = () => {
    if (!user) { setShowAuth(true); return }
    if (isCoach) { handleCoachBooking(); return }
    // Nothing left to charge (a discount and/or account credit covers the full
    // amount) → confirm directly, skip Stripe (SPEC_PAYMENTS_AND_CREDIT #1).
    if (totalPrice === 0) {
      handleDiscountBooking()
      return
    }
    setStep('confirm')
  }

  const handleDiscountBooking = async () => {
    if (!user) return
    setIsSubmitting(true); setError(null); setStep('processing')

    try {
      // Bug N-8: persist FIRST (awaited) and only show the success screen + door
      // code once the server confirms the write. Previously this path showed
      // success immediately and deferred the insert to the parent's onConfirm
      // (4s later, error swallowed by `catch {}`), so any server rejection —
      // email-verify gate, lead-time, horizon — produced a phantom "Booking
      // Confirmed" that never saved. Mirrors the Stripe path's persist-first flow.
      const id = await createBookingForStripe({
        laneId: lane.id,
        variantId: selectedVariant?.id ?? undefined,
        date: dateKey,
        startHour,
        duration,
        customerName,
        customerEmail,
        customerPhone: user.phone,
        userId: user.id,
        status: 'confirmed',
        isCoachBooking: false,
        additionalLaneIds: additionalLanes.length > 0 ? additionalLanes : undefined,
        discountCode: appliedDiscount?.code,
        // Credit is deducted server-side at confirmation (createBooking) via the
        // credit ledger — do NOT deduct client-side (avoids double-spend).
        creditApplied: creditToApply > 0 ? creditToApply : undefined,
      })
      const serverCode = await fetchServerCode(id as string)
      const booking: Booking = {
        id: id as string, laneId: lane.id, variantId: selectedVariant?.id ?? null,
        date: dateKey, startHour, duration, customerName, customerEmail, customerPhone: user.phone,
        userId: user.id, status: 'confirmed', isCoachBooking: false,
        additionalLaneIds: additionalLanes.length > 0 ? additionalLanes : undefined,
        accessCode: serverCode,
        discountCode: appliedDiscount?.code,
        creditApplied: creditToApply > 0 ? creditToApply : undefined,
      }
      setConfirmedBooking(booking); setStep('success')
      setTimeout(() => onConfirm(booking), 4000)
      // Email is sent by createBooking mutation — no client-side duplicate
    } catch (err: any) {
      setError(getErrorMessage(err) ?? 'Could not confirm your booking. Please try again.')
      setStep('details')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCoachBooking = async () => {
    if (!user) return
    setIsSubmitting(true); setError(null); setStep('processing')

    let finalDuration = duration
    if (athleteSlots.length > 0) {
      const minRequired = getMinCoachDurationFromAthletes(startHour, athleteSlots)
      if (minRequired > finalDuration) {
        finalDuration = minRequired
      }
    }

    try {
      // Bug N-8: persist FIRST (awaited); show success only after the write lands.
      const id = await createBookingForStripe({
        laneId: lane.id,
        variantId: selectedVariant?.id ?? undefined,
        date: dateKey,
        startHour,
        duration: finalDuration,
        customerName,
        customerEmail,
        customerPhone: user.phone,
        userId: user.id,
        status: 'confirmed',
        isCoachBooking: true,
        coachPrice: getCoachPrice(finalDuration),
        additionalLaneIds: additionalLanes.length > 0 ? additionalLanes : undefined,
        athleteSlots: (athleteSlots.length > 0 ? athleteSlots : undefined) as any,
      })
      const serverCode = await fetchServerCode(id as string)
      const displaySlots = athleteSlots.length > 0
        ? athleteSlots.map(s => ({ ...s, accessCode: serverCode, codeGeneratedAt: new Date().toISOString() }))
        : undefined
      const booking: Booking = {
        id: id as string, laneId: lane.id, variantId: selectedVariant?.id ?? null,
        date: dateKey, startHour, duration: finalDuration, customerName, customerEmail, customerPhone: user.phone,
        userId: user.id, status: 'confirmed', isCoachBooking: true, coachPrice: getCoachPrice(finalDuration),
        additionalLaneIds: additionalLanes.length > 0 ? additionalLanes : undefined,
        athleteSlots: displaySlots,
        accessCode: serverCode,
      }
      setConfirmedBooking(booking); setStep('success')
      setTimeout(() => onConfirm(booking), 4000)
      // Email is sent by createBooking mutation — no client-side duplicate
    } catch (err: any) {
      setError(getErrorMessage(err) ?? 'Could not confirm your booking. Please try again.')
      setStep('details')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleStripeCheckout = async () => {
    if (!user) return
    setIsSubmitting(true); setError(null); setStep('processing')
    try {
      // Create the booking in Convex FIRST with "pending_payment" status.
      // The Stripe webhook needs bookingId in the session metadata to confirm it.
      const bookingId = await createBookingForStripe({
        laneId: lane.id,
        variantId: selectedVariant?.id ?? undefined,
        date: dateKey,
        startHour,
        duration,
        customerName,
        customerEmail,
        customerPhone: user.phone,
        userId: user.id,
        status: 'pending_payment',
        isCoachBooking: false,
        additionalLaneIds: additionalLanes.length > 0 ? additionalLanes : undefined,
        creditApplied: creditToApply > 0 ? creditToApply : undefined,
        discountCode: appliedDiscount?.code,
      })

      const checkoutReq: CheckoutSessionRequest = {
        laneId: lane.id, laneName: resolvedLaneName, variantId: selectedVariant?.id ?? null,
        variantName: selectedVariant?.name ?? null, date: dateKey, startHour, duration,
        customerName, customerEmail, price: totalPrice,
        additionalLanes: additionalLanes.map(lid => laneNm(lid)),
        bookingId: bookingId as string,
      }
      const session = await createCheckoutSession(checkoutReq)

      if (session.url) {
        // Credit is deducted server-side when the Stripe webhook confirms the
        // booking (confirmBookingPayment) — NOT here. If the customer abandons
        // checkout, the slot is released and no credit is spent.
        window.location.assign(session.url)
        return
      }

      setError('Could not create checkout session. Please try again.')
      setStep('confirm')
      setIsSubmitting(false)
    } catch (err: any) {
      setError(getErrorMessage(err) ?? 'Payment failed. Please try again.')
      setStep('confirm')
      setIsSubmitting(false)
    }
  }

  const googleCalUrl = confirmedBooking ? generateGoogleCalendarUrl({
    laneName: resolvedLaneName, variantName: selectedVariant?.name, date: confirmedBooking.date,
    startHour: confirmedBooking.startHour, duration: confirmedBooking.duration,
    customerName: confirmedBooking.customerName,
    additionalLanes: additionalLanes.map(lid => laneNm(lid)),
    accessCode: confirmedBooking.accessCode,
  }) : null

  if (showAuth) return <AuthModal onClose={() => setShowAuth(false)} onSuccess={() => { setShowAuth(false); setStep('confirm') }} />

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={step !== 'processing' && step !== 'success' ? onClose : undefined} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-md overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className={`p-5 text-white transition-all duration-500 ${step === 'success' ? 'bg-gradient-to-r from-green-500 to-emerald-500' : step === 'processing' ? (isCoach ? 'bg-gradient-to-r from-orange-500 to-amber-500' : totalPrice === 0 ? 'bg-gradient-to-r from-purple-500 to-indigo-500' : 'bg-gradient-to-r from-blue-500 to-indigo-500') : isCoach ? 'bg-gradient-to-r from-orange-500 to-amber-500' : 'bg-gradient-to-r from-emerald-500 to-green-500'}`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">{step === 'success' ? 'Booking Confirmed!' : step === 'processing' ? (totalPrice === 0 ? 'Confirming Booking...' : 'Redirecting to Payment...') : 'Book a Session'}</h3>
              <p className="text-white/80 text-sm mt-0.5">{step === 'success' ? 'Your session is booked' : step === 'processing' ? 'Please wait...' : date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
              {isCoach && step === 'details' && <span className="inline-block mt-1 text-[10px] bg-white/20 px-2 py-0.5 rounded-full font-semibold">🏅 Coach Rate &middot; Rolling 8-Day Window</span>}
            </div>
            {step !== 'processing' && step !== 'success' && (
              <button onClick={onClose} aria-label="Close" className="w-10 h-10 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors">✕</button>
            )}
          </div>
        </div>

        {/* Processing */}
        {step === 'processing' && (
          <div className="p-8 flex flex-col items-center justify-center space-y-4">
            <div className="relative"><div className={`w-16 h-16 border-4 ${isCoach ? 'border-orange-200' : totalPrice === 0 ? 'border-purple-200' : 'border-blue-200'} rounded-full`} /><div className={`absolute inset-0 w-16 h-16 border-4 border-transparent ${isCoach ? 'border-t-orange-500' : totalPrice === 0 ? 'border-t-purple-500' : 'border-t-blue-500'} rounded-full animate-spin`} /></div>
            <p className="font-semibold text-gray-800 dark:text-gray-200">{isCoach ? 'Confirming booking...' : totalPrice === 0 ? 'Confirming booking...' : 'Redirecting to Stripe...'}</p>
            {!isCoach && totalPrice !== 0 && <p className="text-xs text-gray-500 dark:text-gray-400">You will be redirected to Stripe to complete your payment securely.</p>}
          </div>
        )}

        {/* Success */}
        {step === 'success' && (
          <div className="p-8 flex flex-col items-center justify-center space-y-4">
            <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
            </div>
            <p className="font-bold text-lg text-gray-800 dark:text-gray-200">Session Booked!</p>
            {appliedDiscount && (
              <div className="w-full bg-gradient-to-br from-purple-50 to-indigo-50 dark:from-purple-900/30 dark:to-indigo-900/30 rounded-xl p-3 border border-purple-200 dark:border-purple-700 text-center">
                <span className="text-xs font-semibold text-purple-600 dark:text-purple-400">🎟️ Discount code &quot;{appliedDiscount.code}&quot; applied — {appliedDiscount.label}</span>
              </div>
            )}
            {confirmedBooking?.accessCode && (
              <div className="w-full bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/30 dark:to-indigo-900/30 rounded-xl p-4 border-2 border-blue-200 dark:border-blue-700 text-center">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <span className="text-lg">🔑</span>
                  <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Door Access Code</span>
                </div>
                <div className="text-3xl font-mono font-bold tracking-[0.3em] text-blue-800 dark:text-blue-200">{formatAccessCode(confirmedBooking.accessCode)}</div>
                <p className="text-[10px] text-blue-500 dark:text-blue-400 mt-2">Enter this code at the facility door keypad. Valid for your session time only.</p>
              </div>
            )}
            {confirmedBooking?.athleteSlots && confirmedBooking.athleteSlots.length > 0 && (
              <div className="w-full bg-gradient-to-br from-orange-50 to-amber-50 dark:from-orange-900/20 dark:to-amber-900/20 rounded-xl p-4 border border-orange-200 dark:border-orange-700 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-orange-600 dark:text-orange-400 text-center mb-2">🏏 Assigned Athletes</div>
                {confirmedBooking.athleteSlots.map((s, i) => (
                  <div key={i} className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-lg px-3 py-2 border border-orange-100 dark:border-orange-800/30">
                    <div>
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{s.athleteName}</div>
                      <div className="text-[10px] text-gray-500">{formatTime(s.startHour)} – {formatTime(s.startHour + s.durationMinutes / 60)} ({s.durationMinutes}min)</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 w-full space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Lane</span><span className="font-medium text-gray-800 dark:text-gray-200">{resolvedLaneName}{selectedVariant ? ` (${selectedVariant.name})` : ''}</span></div>
              {additionalLanes.length > 0 && <div className="flex justify-between"><span className="text-gray-500">+ Lanes</span><span className="font-medium text-gray-800 dark:text-gray-200">{additionalLanes.map(lid => laneNm(lid)).join(', ')}</span></div>}
              <div className="flex justify-between"><span className="text-gray-500">Time</span><span className="font-medium text-gray-800 dark:text-gray-200">{formatTime(startHour)} - {formatTime(startHour + (confirmedBooking?.duration ?? duration) / 60)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Total</span><span className="font-bold text-emerald-600 dark:text-emerald-400">{confirmedBooking?.isCoachBooking ? `$${getCoachPrice(confirmedBooking.duration)}` : totalPrice === 0 ? 'FREE' : `$${totalPrice}`}</span></div>
            </div>
            {googleCalUrl && (
              <a href={googleCalUrl} target="_blank" rel="noopener noreferrer" className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700 rounded-xl hover:border-blue-400 hover:shadow-md transition-all">
                📅 <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Add to Google Calendar</span>
              </a>
            )}
          </div>
        )}

        {/* Details Step */}
        {step === 'details' && (
          <div className="p-5 space-y-4">
            {/* Bug N-8: surface a failed booking write (e.g. email-verify gate,
                lead-time, slot taken) instead of the old silent swallow. */}
            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
                <p className="text-sm text-red-700 dark:text-red-400">⚠️ {error}</p>
              </div>
            )}
            {/* SPEC_RECONFIGURABLE_LANES: lane set up differently than usual today */}
            {laneWarning && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-300 dark:border-red-800/60">
                <p className="text-sm font-medium text-red-700 dark:text-red-400">{laneWarning}</p>
              </div>
            )}
            {isCoach && (
              <div className="flex items-center gap-3 bg-orange-50 dark:bg-orange-900/20 rounded-xl p-3 border border-orange-200 dark:border-orange-800/50">
                <div className="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center text-white text-sm font-bold">🏅</div>
                <div><div className="text-sm font-semibold text-orange-800 dark:text-orange-300">Coach Booking</div><div className="text-xs text-orange-600 dark:text-orange-400">${getCoachPerHourRate()}/hr &middot; 1 hour minimum &middot; No payment required</div></div>
              </div>
            )}
            {!isValidCoachStart && isCoach && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50">
                <p className="text-xs text-red-700 dark:text-red-400">⚠️ Coach bookings must start on the hour (or 3:30pm on weekdays).</p>
              </div>
            )}

            {roundingNotice && (
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 border border-blue-200 dark:border-blue-800/50">
                <p className="text-xs text-blue-700 dark:text-blue-400">⏰ {roundingNotice}</p>
              </div>
            )}

            <div className="flex items-center gap-3 bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <div className="w-10 h-10 bg-white dark:bg-gray-700 rounded-lg flex items-center justify-center text-lg shadow-sm">{resolvedLaneIcon}</div>
              <div><div className="font-semibold text-gray-800 dark:text-gray-200">{resolvedLaneName}</div><div className="text-xs text-gray-500">{formatTime(startHour)} start</div></div>
            </div>

            {user && (
              <div className={`flex items-center gap-3 rounded-xl p-3 border ${isCoach ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800/50' : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/50'}`}>
                <div className={`w-8 h-8 ${isCoach ? 'bg-orange-500' : 'bg-emerald-500'} rounded-full flex items-center justify-center text-white text-sm font-bold`}>{user.name.charAt(0).toUpperCase()}</div>
                <div><div className="text-sm font-semibold text-gray-800 dark:text-gray-200">{user.name}</div><div className="text-xs text-gray-500">{user.email}</div></div>
                {creditBalance > 0 && !isCoach && <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400">💰 ${creditBalance} credit</span>}
              </div>
            )}

            {/* Variant Selection (segment-resolved; only when >1 option) */}
            {hasVariantChoice && (
              <div>
                <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Machine Type</label>
                <div className="grid grid-cols-2 gap-3">
                  {variantOptions.map((variant) => (
                    <button key={variant.id} onClick={() => setSelectedVariant(variant)}
                      className={`p-3 rounded-xl border-2 transition-all text-left ${selectedVariant?.id === variant.id ? variant.id.includes('truman') ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 shadow-md' : 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 shadow-md' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}`}>
                      <div className="text-base font-bold text-gray-800 dark:text-gray-200">{variant.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">${getCustomerPrice(lane, variant.id, 60)}/hr</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Duration */}
            <div>
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Duration</label>
              {isCoach ? (
                <>
                  <select value={duration} onChange={e => setDuration(Number(e.target.value))} className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-sm">
                    {availableDurations.map(d => {
                      const hrs = Math.floor(d / 60); const mins = d % 60
                      const label = hrs > 0 ? `${hrs}hr${mins > 0 ? ` ${mins}min` : ''}` : `${mins}min`
                      const halfHours = d / 30
                      return <option key={d} value={d}>{label} — ${getCoachPrice(d)} (${getCoachPerHourRate()}/hr)</option>
                    })}
                  </select>
                  <div className="mt-2 text-[11px] text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 rounded-lg px-3 py-2 border border-orange-200 dark:border-orange-800/30">
                    <span className="font-semibold">Coach rate:</span> ${getCoachPerHourRate()} per hour &middot; Selected: <span className="font-bold">${getCoachPrice(duration)}</span> for {duration >= 60 ? `${Math.floor(duration/60)}hr${duration%60>0?` ${duration%60}min`:''}` : `${duration}min`}
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {availableDurations.map(d => (
                    <button key={d} onClick={() => setDuration(d)}
                      className={`p-3 rounded-xl border-2 transition-all text-left ${duration === d ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 shadow-md' : 'border-gray-200 dark:border-gray-700'}`}>
                      <div className="text-lg font-bold text-gray-800 dark:text-gray-200">${getCustomerPrice(lane, selectedVariant?.id ?? null, d)}</div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">{d === 60 ? '1 Hour' : d === 120 ? '2 Hours' : d === 180 ? '3 Hours' : `${Math.floor(d / 60)}hr${d % 60 > 0 ? ` ${d % 60}min` : ''}`}</div>
                      <div className="text-xs text-gray-500 mt-1">{formatTime(startHour)} - {formatTime(startHour + d / 60)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Multi-lane */}
            {availableAdditionalLanes.length > 0 && maxAdditionalLanes > 0 && (
              <div>
                <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Add More Lanes <span className="text-xs font-normal text-gray-400">{isCoach ? '(optional)' : `(optional · up to ${maxLanesPerBooking} lanes total)`}</span></label>
                <div className="flex flex-wrap gap-2">
                  {availableAdditionalLanes.map(l => {
                    const selected = additionalLanes.includes(l.id)
                    const capReached = !selected && additionalLanes.length >= maxAdditionalLanes
                    return (
                      <button key={l.id} onClick={() => toggleAdditionalLane(l.id)} disabled={capReached}
                        className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${selected ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 font-semibold' : capReached ? 'border-gray-200 dark:border-gray-700 text-gray-300 dark:text-gray-600 cursor-not-allowed' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300'}`}>
                        {laneNm(l.id)} {selected ? '✓' : '+'}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Coach: Athlete Tracking — Dropdown from Convex */}
            {isCoach && (
              <div>
                <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Assign Athletes <span className="text-xs font-normal text-gray-400">(min 30min &middot; auto-rounds booking)</span></label>
                
                {/* Existing athlete slots */}
                {athleteSlots.map((slot, idx) => {
                  const slotEndHour = slot.startHour + slot.durationMinutes / 60
                  const endMins = Math.round((slotEndHour - Math.floor(slotEndHour)) * 60)
                  const isQuarterEnd = endMins === 15 || endMins === 45
                  return (
                    <div key={idx} className={`mb-1.5 rounded-lg px-3 py-2 ${isQuarterEnd ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50' : 'bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800/30'}`}>
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 bg-orange-500 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0">{slot.athleteName.charAt(0).toUpperCase()}</div>
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-medium text-gray-800 dark:text-gray-200">{slot.athleteName}</span>
                          <div className="text-[10px] text-gray-500">{formatTimeDetailed(slot.startHour)} - {formatTimeDetailed(slotEndHour)} ({slot.durationMinutes}min)</div>
                        </div>
                        {slot.accessCode && (
                          <span className="text-[10px] font-mono font-bold text-orange-600 dark:text-orange-400 bg-orange-100 dark:bg-orange-900/30 px-1.5 py-0.5 rounded">🔑 {formatAccessCode(slot.accessCode)}</span>
                        )}
                        {isQuarterEnd && <span className="text-[9px] text-blue-600 dark:text-blue-400 font-medium">⏰</span>}
                        <button onClick={() => removeAthleteSlot(idx)} className="text-red-400 hover:text-red-600 text-xs shrink-0">✕</button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <select value={slot.startHour} onChange={e => updateAthleteSlot(idx, 'startHour', Number(e.target.value))}
                          className="w-full text-[11px] px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200">
                          {getSlotStartOptions(idx).map(h => <option key={h} value={h}>{formatTimeDetailed(h)}</option>)}
                        </select>
                        <select value={slot.durationMinutes} onChange={e => updateAthleteSlot(idx, 'durationMinutes', Number(e.target.value))}
                          className="w-full text-[11px] px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200">
                          {getSlotDurationOptions(slot.startHour).map(d => <option key={d} value={d}>{d}min</option>)}
                        </select>
                      </div>
                    </div>
                  )
                })}

                {/* Add new athlete — dropdown selector */}
                {coachAthletes === undefined ? (
                  <div className="flex items-center justify-center py-3 gap-2 text-xs text-gray-400">
                    <span className="animate-spin">⏳</span> Loading athletes...
                  </div>
                ) : coachAthletes.length === 0 ? (
                  <div className="bg-amber-50 dark:bg-amber-900/10 rounded-lg p-3 border border-amber-200 dark:border-amber-800/30 text-center">
                    <p className="text-xs text-gray-500 dark:text-gray-400">No athletes assigned. Athletes need to select you as their coach in their profile.</p>
                  </div>
                ) : availableAthletes.length > 0 || athleteSlots.length === 0 ? (
                  <div className="space-y-2 mt-2">
                    {/* Time/duration for next athlete — set BEFORE selecting */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 block uppercase tracking-wider">Start Time</label>
                        <select value={newAthleteStart} onChange={e => setNewAthleteStart(Number(e.target.value))}
                          className="w-full text-xs px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200">
                          {athleteStartOptions.map(h => <option key={h} value={h}>{formatTimeDetailed(h)}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 block uppercase tracking-wider">Duration</label>
                        <select value={effNewAthleteDuration} onChange={e => setNewAthleteDuration(Number(e.target.value))}
                          className="w-full text-xs px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200">
                          {athleteDurationOptions.map(d => <option key={d} value={d}>{d}min</option>)}
                        </select>
                      </div>
                    </div>
                    {/* Athlete dropdown */}
                    <div className="relative">
                      <button
                        onClick={() => { setAthleteDropdownOpen(!athleteDropdownOpen); setAthleteSearchQuery('') }}
                        className="w-full px-3 py-2.5 text-sm bg-white dark:bg-gray-800 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-400 hover:border-orange-400 hover:text-orange-500 dark:hover:border-orange-500 dark:hover:text-orange-400 transition-all text-left flex items-center gap-2"
                      >
                        <span className="text-base">👤</span>
                        {availableAthletes.length > 0 ? `Select athlete (${availableAthletes.length} available)...` : 'All athletes allocated'}
                      </button>

                      {athleteDropdownOpen && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-30 max-h-52 flex flex-col overflow-hidden">
                          <div className="p-2 border-b border-gray-100 dark:border-gray-800">
                            <div className="relative">
                              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
                              <input
                                type="text"
                                value={athleteSearchQuery}
                                onChange={e => setAthleteSearchQuery(e.target.value)}
                                placeholder="Search athletes..."
                                className="w-full pl-8 pr-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none text-gray-800 dark:text-gray-200 placeholder-gray-400"
                                autoFocus
                              />
                            </div>
                          </div>
                          <div className="overflow-y-auto flex-1">
                            {availableAthletes.length === 0 ? (
                              <div className="p-4 text-center text-xs text-gray-400">
                                {athleteSearchQuery ? 'No athletes match your search' : 'All athletes allocated'}
                              </div>
                            ) : (
                              availableAthletes.map(athlete => (
                                <button
                                  key={athlete._id}
                                  onClick={() => addAthleteSlot(athlete)}
                                  className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-colors text-left group"
                                >
                                  <div className="w-7 h-7 bg-emerald-500 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 group-hover:scale-105 transition-transform">
                                    {athlete.name.charAt(0).toUpperCase()}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{athlete.name}</div>
                                    <div className="text-[10px] text-gray-400 truncate">{athlete.email}</div>
                                  </div>
                                  <span className="text-orange-500 opacity-0 group-hover:opacity-100 transition-opacity text-xs">+ Add</span>
                                </button>
                              ))
                            )}
                          </div>
                          <div className="p-1.5 border-t border-gray-100 dark:border-gray-800">
                            <button onClick={() => { setAthleteDropdownOpen(false); setAthleteSearchQuery('') }}
                              className="w-full py-1.5 text-xs text-gray-500 hover:text-gray-700 font-medium transition-colors rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">Close</button>
                          </div>
                        </div>
                      )}
                    </div>


                  </div>
                ) : (
                  <div className="text-center text-xs text-gray-400 py-1 mt-1">All athletes have been allocated</div>
                )}
              </div>
            )}

            {/* Discount Code */}
            {!isCoach && (
              <div>
                <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 block">Discount Code <span className="text-xs font-normal text-gray-400">(optional)</span></label>
                {appliedDiscount ? (
                  <div className="flex items-center gap-3 bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-900/20 dark:to-indigo-900/20 rounded-xl p-3 border-2 border-purple-300 dark:border-purple-700">
                    <div className="w-8 h-8 bg-purple-500 rounded-full flex items-center justify-center text-white text-sm">🎟️</div>
                    <div className="flex-1">
                      <div className="text-sm font-bold text-purple-800 dark:text-purple-300 uppercase tracking-wide">{appliedDiscount.code}</div>
                      <div className="text-xs text-purple-600 dark:text-purple-400">{appliedDiscount.label}</div>
                    </div>
                    <button onClick={handleRemoveDiscount} className="text-xs text-red-500 hover:text-red-700 font-semibold px-2 py-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">Remove</button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      value={discountCode}
                      onChange={e => { setDiscountCode(e.target.value); setDiscountError(null) }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleApplyDiscount() } }}
                      placeholder="Enter code"
                      className="flex-1 text-sm px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 placeholder:text-gray-400"
                    />
                    <button onClick={handleApplyDiscount} disabled={discountValidating} className="px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl transition-colors">{discountValidating ? 'Checking...' : 'Apply'}</button>
                  </div>
                )}
                {discountError && <p className="text-xs text-red-500 mt-1.5">{discountError}</p>}
              </div>
            )}

            {/* Credit */}
            {!isCoach && creditBalance > 0 && user && (
              <label className="flex items-center gap-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 border border-blue-200 dark:border-blue-800/50 cursor-pointer">
                <input type="checkbox" checked={applyCredit} onChange={e => setApplyCredit(e.target.checked)} className="rounded" />
                <div><div className="text-sm font-medium text-blue-800 dark:text-blue-300">Apply account credit</div><div className="text-xs text-blue-600 dark:text-blue-400">Available: ${creditBalance} &middot; Saves ${creditToApply}</div></div>
              </label>
            )}

            {/* Total */}
            {(additionalLanes.length > 0 || creditToApply > 0 || appliedDiscount) && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Primary lane</span><span className="font-medium">${price}</span></div>
                {additionalLanes.map(lid => {
                  const l = LANES.find(la => la.id === lid)
                  const lp = isCoach ? getCoachPrice(duration) : getCustomerPrice(l!, null, duration)
                  return <div key={lid} className="flex justify-between"><span className="text-gray-500">+ {laneNm(lid)}</span><span className="font-medium">${lp}</span></div>
                })}
                {creditToApply > 0 && <div className="flex justify-between"><span className="text-blue-500">Credit</span><span className="font-medium text-blue-600">-${creditToApply}</span></div>}
                {appliedDiscount && discountAmount > 0 && (
                  <div className="flex justify-between"><span className="text-purple-500">🎟️ Discount ({appliedDiscount.code})</span><span className="font-medium text-purple-600">-${discountAmount}</span></div>
                )}
                <div className="border-t border-gray-200 dark:border-gray-700 pt-1 flex justify-between"><span className="font-semibold">Total</span><span className="font-bold text-emerald-600">{totalPrice === 0 ? 'FREE' : `$${totalPrice}`}</span></div>
              </div>
            )}

            <button onClick={handleContinueToPayment} disabled={availableDurations.length === 0 || (isCoach && !isValidCoachStart)}
              className={`w-full py-3 font-semibold rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white ${isCoach ? 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600' : totalPrice === 0 ? 'bg-gradient-to-r from-purple-500 to-indigo-500 hover:from-purple-600 hover:to-indigo-600' : 'bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600'}`}>
              {!user ? 'Sign In to Book →' : isCoach ? `Confirm — $${totalPrice} →` : totalPrice === 0 ? 'Confirm Free Booking →' : `Continue to Payment — $${totalPrice} →`}
            </button>
          </div>
        )}

        {/* Confirm Step */}
        {step === 'confirm' && !isCoach && (
          <div className="p-5 space-y-4">
            {error && <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 border border-red-200 dark:border-red-800/50"><p className="text-sm text-red-700 dark:text-red-400">⚠️ {error}</p></div>}
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 space-y-2 text-sm">
              <h4 className="font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wider">Booking Summary</h4>
              <div className="flex justify-between"><span className="text-gray-500">Lane</span><span className="font-medium text-gray-800 dark:text-gray-200">{resolvedLaneName}{selectedVariant ? ` (${selectedVariant.name})` : ''}</span></div>
              {additionalLanes.length > 0 && <div className="flex justify-between"><span className="text-gray-500">+ Lanes</span><span className="font-medium">{additionalLanes.map(lid => laneNm(lid)).join(', ')}</span></div>}
              <div className="flex justify-between"><span className="text-gray-500">Time</span><span className="font-medium">{formatTime(startHour)} - {formatTime(endHour)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Duration</span><span className="font-medium">{duration >= 60 ? `${Math.floor(duration / 60)}hr${duration % 60 > 0 ? ` ${duration % 60}min` : ''}` : `${duration}min`}</span></div>
              {creditToApply > 0 && <div className="flex justify-between"><span className="text-blue-500">Credit Applied</span><span className="font-medium text-blue-600">-${creditToApply}</span></div>}
              {appliedDiscount && discountAmount > 0 && (
                <div className="flex justify-between"><span className="text-purple-500">🎟️ Discount ({appliedDiscount.code})</span><span className="font-medium text-purple-600">-${discountAmount}</span></div>
              )}
              <div className="border-t border-gray-200 dark:border-gray-700 pt-2"><div className="flex justify-between items-center"><span className="font-semibold">Total</span><span className="text-xl font-bold text-emerald-600">{totalPrice === 0 ? 'FREE' : `$${totalPrice}`}</span></div></div>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 border border-blue-200 dark:border-blue-800/50">
              <p className="text-xs text-blue-700 dark:text-blue-400"><strong>Cancellation Policy:</strong> Cancel {getSettingsStore().get().customerCancellationHours ?? getSettingsStore().get().cancellationHoursBefore ?? 2}+ hours before for account credit.</p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setStep('details'); setError(null) }} className="flex-1 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-all">← Back</button>
              <button onClick={handleStripeCheckout} disabled={isSubmitting}
                className="flex-[2] py-3 bg-[#635BFF] hover:bg-[#5851e0] text-white font-semibold rounded-xl shadow-lg transition-all disabled:opacity-70 flex items-center justify-center gap-2">
                {isSubmitting ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Redirecting...</> : <>Pay ${totalPrice} with Stripe</>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
