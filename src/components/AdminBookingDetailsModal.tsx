import { useState, useMemo, useEffect } from 'react'
import { useMutation, useQuery, useConvex } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { getErrorMessage } from '../lib/errors'
import { LANES, formatTime, getCoachPrice, getCustomerPrice, canBookSlot, getAWSTNow, type Booking, type AthleteSlot } from '../lib/booking-data'
import { getSettingsStore, getHoursForDate } from '../lib/settings-store'
import { useBookingActions } from '../hooks/useBookingStore'
import { useAuth } from '../hooks/useAuth'
// SPEC_COACH_ALLOCATION — admin can allocate athletes to a coach's booking.
import AthleteAllocationEditor from './AthleteAllocationEditor'
// SPEC_ADMIN_TOPUP — admin sends a customer a Stripe payment link for the price
// difference after extending their booking.
import { createPaymentLink } from '../lib/stripe'
// G3 (SPEC_ADMIN_BOOKING_PARITY_2026-08): machine-type (variant) switch on an
// existing booking — options resolved per date/segment like the booking modals.
import { resolveLaneAt, variantLabel } from '../lib/lanes'
import { useLaneConfigState } from '../hooks/useLaneConfig'

interface Props {
  booking: Booking
  onClose: () => void
  onSave?: (newDate: string) => void
  // G5: open straight into the athlete-allocation editor (post-create bridge).
  openAthleteEditor?: boolean
}

const STATUS_OPTIONS = ['confirmed', 'cancelled']

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

export default function AdminBookingDetailsModal({ booking, onClose, onSave, openAthleteEditor }: Props) {
  const { updateBooking, updateAthleteSlots } = useBookingActions()
  const { user } = useAuth()
  // SPEC_COACH_ALLOCATION — admin allocates athletes to a coach booking. The editor is
  // scoped to the BOOKING's coach (by email); fetch that coach's settings for the picker.
  // G5: openAthleteEditor pre-opens it (the create → allocate bridge).
  const [showAthleteEditor, setShowAthleteEditor] = useState(openAthleteEditor === true && booking.isCoachBooking)
  const coachRecord = useQuery(
    api.queries.getCustomerByEmail,
    booking.isCoachBooking && booking.customerEmail ? { email: booking.customerEmail } : 'skip'
  ) as any
  // SPEC_COACH_SPLIT_LANE_BOOKING — the other leg of a split (null when not a
  // split). Drives the split banner + the group-window allocation editor.
  const splitSibling = useQuery(
    (api.queries as any).getSplitSibling,
    booking.isCoachBooking ? { id: booking.id } : 'skip'
  ) as { id: string; laneId: string; laneNameSnapshot: string | null; startHour: number; duration: number; status: string; targetIsLeg2: boolean } | null | undefined
  // Whole-session window for a split CARRIER (allocation may span the lane change).
  const splitGroupDuration = splitSibling && !splitSibling.targetIsLeg2 && splitSibling.status !== 'cancelled'
    ? Math.round((splitSibling.startHour + splitSibling.duration / 60 - booking.startHour) * 60)
    : null
  const handleSaveAthleteSlots = async (
    slots: AthleteSlot[],
    opts?: { confirmedOverride?: boolean },
  ) => {
    const res = await updateAthleteSlots(booking.id, slots as any, user?.id ?? '', opts?.confirmedOverride)
    if (res.success) { setActionNote('Athlete allocations updated.'); setShowAthleteEditor(false) }
    return res
  }
  const cancelMut = useMutation(api.mutations.cancelBooking)
  const resendMut = useMutation((api.mutations as any).resendBookingConfirmation)
  const voidMut = useMutation((api.mutations as any).voidBookingCharge)
  // SPEC_CLUB_TEAM_BOOKINGS: mark an offline/club booking paid/unpaid.
  const setPaymentStatusMut = useMutation((api.mutations as any).adminSetBookingPaymentStatus)
  const [paymentStatusLocal, setPaymentStatusLocal] = useState<string | undefined>((booking as any).paymentStatus)
  const [savingPayment, setSavingPayment] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  // SPEC_ADMIN_MANUAL_POWERS — resend + in-app void
  const [actionNote, setActionNote] = useState<string | null>(null)
  const [showVoid, setShowVoid] = useState(false)
  const [voidMode, setVoidMode] = useState<'stripe' | 'credit' | 'waive'>('stripe')
  const [voidAmount, setVoidAmount] = useState('')

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
  // SPEC_TEAM_BOOKING_AUTODOOR_2026-07: toggle the roller-door auto-open tag.
  const [autoDoor, setAutoDoor] = useState(booking.autoDoor ?? false)
  // G3 — machine-type (variant) switch. Options come from the date/segment-resolved
  // lane config (the G6 pattern), NOT the static default layout. Matters physically:
  // the "(Truman)" token on the resynced calendar event drives HA's machine power.
  useLaneConfigState()
  const [variantId, setVariantId] = useState<string | null>(booking.variantId ?? null)
  const segVariants = useMemo(() => {
    try { return resolveLaneAt(laneId, date, startHour).segment.variants } catch { return [] as string[] }
  }, [laneId, date, startHour])
  // NO auto-snap: variantId changes ONLY on explicit admin interaction with the
  // select. (Review 2026-08-05: a mount-time snap silently rewrote any booking
  // whose stored variant isn't in the live segment — e.g. every legacy Truman
  // booking while the live layout offers no truman variant — so ANY unrelated
  // save would flip its machine type + resync the calendar/HA power token.)
  // If the stored variant isn't offered by the resolved segment, it's shown as
  // an extra option so the select never lies about the current value.
  const variantOptions = useMemo(
    () => (variantId != null && !segVariants.includes(variantId) ? [variantId, ...segVariants] : segVariants),
    [segVariants, variantId]
  )
  const variantChanged = !booking.isCoachBooking && (variantId ?? null) !== (booking.variantId ?? null)
  // SPEC_ADMIN_TOPUP — top-up payment link (customer bookings only).
  const [topUpAmount, setTopUpAmount] = useState('')
  const [topUpEmail, setTopUpEmail] = useState(false)
  const [generatingLink, setGeneratingLink] = useState(false)
  const [paymentLinkUrl, setPaymentLinkUrl] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)

  // FEA-6: conflict-check the EDITED target date via the indexed per-day query (admin
  // → full data) instead of the whole-table grid array. The server (updateBooking) is
  // authoritative on conflicts + holds; this is the client-side pre-check.
  const targetDayRaw = useQuery(api.queries.listBookingsByDate, { date })

  const displayLane = LANES.find(l => l.id === laneId)
  const hours = useMemo(() => generateHoursForDate(date), [date])
  // SPEC_CLUB_TEAM_BOOKINGS: club/team bookings are invoiced offline — never Stripe.
  // Used to hide the customer session-price + Stripe top-up blocks in the edit form
  // (offline paid/unpaid is handled by its own section in the view above).
  const isClub = (booking as any).isClubBooking === true

  // Auto-recalculate coach price when duration changes
  useEffect(() => {
    if (booking.isCoachBooking) {
      setCoachPrice(getCoachPrice(duration))
    }
  }, [duration, booking.isCoachBooking])

  // Duration options capped at the day's closing hour — but this admin-only modal
  // may extend an evening / team (club) booking past the public close up to the
  // after-hours 10pm ceiling (SPEC_ADMIN_AFTER_HOURS_BOOKING). updateBooking has no
  // close-check and the server accepts endHour ≤ 22:00 for admins.
  // Every 30-min step is offered up to the coach max (10hr) — an admin is deciding
  // deliberately, same ladder as AdminManualBookingModal. (The old hardcoded list
  // skipped 3.5hr/4.5hr/5.5hr and stopped at 6hr, so e.g. an evening booking could
  // not be extended to a 3.5hr end at the 10pm close, and a 7am–4pm coach block's
  // own 9hr length wasn't selectable.)
  const ADMIN_AFTER_HOURS_CLOSE = 22
  const durationOptions = useMemo(() => {
    const s = getSettingsStore().get()
    const { close } = getHoursForDate(s, date)
    const ceiling = Math.max(close, ADMIN_AFTER_HOURS_CLOSE)
    const maxMinutes = Math.min(
      Math.round((ceiling - startHour) * 60),
      s.coachMaxDurationMinutes ?? 600,
    )
    const out: number[] = []
    for (let d = 30; d <= maxMinutes; d += 30) out.push(d)
    return out
  }, [date, startHour])

  // Computed customer price — for display reference (payment already processed).
  // G3: priced at the EDITED variant so a machine-type switch shows its new price
  // (and the top-up default below becomes the delta to collect).
  const calculatedCustomerPrice = useMemo(() => {
    if (booking.isCoachBooking) return null
    const lane = LANES.find(l => l.id === laneId)
    if (!lane) return null
    return getCustomerPrice(lane, variantId ?? booking.variantId ?? null, duration)
  }, [booking.isCoachBooking, booking.variantId, variantId, laneId, duration])

  // SPEC_ADMIN_TOPUP — what the customer has paid (the stored price) vs the new
  // price at the edited duration; the balance is the top-up to collect.
  // G1: on a PAID booking priceInCents is the CASH settled; any redeemed account
  // credit (creditApplied) also covered value, so count it before flagging a
  // balance as "still owing" (else a credit-part-paid booking looks underbilled).
  const alreadyPaidDollars = ((booking as any).priceInCents ?? 0) / 100
  const creditCoveredDollars =
    (booking as any).paymentStatus === 'paid' ? (((booking as any).creditApplied ?? 0) as number) : 0
  const balanceDueDollars = useMemo(
    () => Math.max(0, (calculatedCustomerPrice ?? 0) - alreadyPaidDollars - creditCoveredDollars),
    [calculatedCustomerPrice, alreadyPaidDollars, creditCoveredDollars]
  )
  // Default the amount field to the live balance (re-fills when the duration changes).
  useEffect(() => {
    setTopUpAmount(balanceDueDollars > 0 ? balanceDueDollars.toFixed(2) : '')
    setPaymentLinkUrl(null)
    setLinkError(null)
  }, [balanceDueDollars])

  const handleGenerateTopUpLink = async () => {
    setLinkError(null); setPaymentLinkUrl(null); setLinkCopied(false)
    const amt = parseFloat(topUpAmount)
    if (!amt || amt <= 0) { setLinkError('Enter an amount greater than $0.'); return }
    if (!customerEmail) { setLinkError('This booking has no customer email to charge.'); return }
    setGeneratingLink(true)
    try {
      const variantName = displayLane?.variants?.find(v => v.id === booking.variantId)?.name
      const res = await createPaymentLink({
        laneId,
        laneName: displayLane?.name ?? laneId,
        variantName,
        date, startHour, duration,
        customerName, customerEmail,
        price: amt,
        bookingId: booking.id,
        topUp: true,
        emailToCustomer: topUpEmail,
      })
      setPaymentLinkUrl(res.url)
      if (topUpEmail) setActionNote(`Payment link emailed to ${customerEmail}.`)
    } catch (err: any) {
      setLinkError(getErrorMessage(err) ?? 'Could not create the payment link.')
    } finally {
      setGeneratingLink(false)
    }
  }

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

  // G4 (SPEC_ADMIN_BOOKING_PARITY_2026-08) — admin manages mates on the OWNER's
  // behalf. addMateToBooking/removeMateFromBooking already authorise an admin
  // caller and attribute the friendship + M1/M2 emails to the booking owner, so
  // this is a thin mirror of the customer /add-mate flow. Clubs excluded (no
  // login, fixed door code — mates make no sense there).
  const convex = useConvex()
  const addMateMut = useMutation(api.mates.addMateToBooking)
  const removeMateMut = useMutation(api.mates.removeMateFromBooking)
  const [matePhone, setMatePhone] = useState('')
  const [mateSearching, setMateSearching] = useState(false)
  const [mateMatch, setMateMatch] = useState<{ _id: string; displayName: string; isSelf?: boolean } | null | 'none'>(null)
  const [mateBusy, setMateBusy] = useState(false)
  const [mateMsg, setMateMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const maxMates = ((getSettingsStore().get() as any).maxMatesPerBooking ?? 2) as number
  // Owner's saved mates for one-tap adds (listSavedMates already supports the
  // admin forAccountId override; we resolve the owner's customers row by email).
  const mateOwnerRecord = useQuery(
    api.queries.getCustomerByEmail,
    !booking.isCoachBooking && !isClub && booking.customerEmail ? { email: booking.customerEmail } : 'skip'
  ) as any
  const ownerSavedMates = (useQuery(
    api.mates.listSavedMates,
    mateOwnerRecord?._id ? { forAccountId: mateOwnerRecord._id } : 'skip'
  ) ?? []) as Array<{ customerId: string; displayName: string; sharedCount: number }>
  // Adds are blocked server-side once the session has started (removals stay
  // allowed) — hide the add controls at that point.
  const mateSessionStarted = useMemo(() => {
    const start = new Date(booking.date + 'T00:00:00')
    start.setMinutes(start.getMinutes() + Math.round(booking.startHour * 60))
    return getAWSTNow() >= start
  }, [booking.date, booking.startHour])
  const handleMateSearch = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    setMateMsg(null); setMateMatch(null); setMateSearching(true)
    try {
      const res = await convex.mutation(api.mates.searchCustomerByMobile, {
        phone: matePhone,
        forBookingId: booking.id as Id<'bookings'>,
      })
      setMateMatch(res ?? 'none')
    } catch (err: any) {
      setMateMsg({ text: getErrorMessage(err) ?? 'Search failed.', ok: false })
    } finally { setMateSearching(false) }
  }
  const handleAddMate = async (mateCustomerId: string) => {
    setMateBusy(true); setMateMsg(null)
    try {
      await addMateMut({ bookingId: booking.id as Id<'bookings'>, mateCustomerId: mateCustomerId as any })
      setMateMatch(null); setMatePhone('')
      setMateMsg({ text: "Mate added — they've been emailed the session details + door code.", ok: true })
    } catch (err: any) {
      setMateMsg({ text: getErrorMessage(err) ?? 'Failed to add mate.', ok: false })
    } finally { setMateBusy(false) }
  }
  const handleRemoveMate = async (mateCustomerId: string, name: string) => {
    if (!window.confirm(`Remove ${name} from this booking?`)) return
    setMateBusy(true); setMateMsg(null)
    try {
      await removeMateMut({ bookingId: booking.id as Id<'bookings'>, mateCustomerId: mateCustomerId as any })
    } catch (err: any) {
      setMateMsg({ text: getErrorMessage(err) ?? 'Failed to remove mate.', ok: false })
    } finally { setMateBusy(false) }
  }

  // SPEC_PAYMENT_LINK_TRACKING_2026-07 — this booking's sent payment links
  // (reactive: a link flips to Paid the moment the Stripe webhook lands). Drives
  // the "⏳ top-up pending" badge so a part-paid booking is never mistaken for
  // underbilling. Full management (cancel / mark-paid-offline) lives on the
  // analytics "💳 Payment Links" tab.
  const bookingLinks = (useQuery(
    (api as any).paymentLinks.getLinksForBooking,
    booking.isCoachBooking ? 'skip' : { bookingId: booking.id },
  ) ?? []) as any[]
  const pendingLinkCents = bookingLinks
    .filter((l) => l.status === 'pending')
    .reduce((s, l) => s + (l.amountCents ?? 0), 0)

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
      const otherBookings = ((targetDayRaw ?? []) as any[])
        .map(b => ({ ...b, id: String(b._id) }))
        .filter(b => b.id !== booking.id)
      // Check EVERY lane the booking occupies (multi-lane team/club bookings span
      // additionalLaneIds too) — the old single-lane check missed a clash on an
      // additional lane. Server (updateBooking) remains authoritative.
      const occupiedLanes = [laneId, ...(((booking as any).additionalLaneIds ?? []) as string[])]
      const clashLane = occupiedLanes.find(l => !canBookSlot(otherBookings, l, date, startHour, duration))
      if (clashLane) {
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
        autoDoor, // SPEC_TEAM_BOOKING_AUTODOOR
        // G3 — send the variant only when actually changed (avoids needless
        // calendar resyncs; the mutation recomputes snapshots + updates the
        // event in place, carrying the "(Truman)" token HA's power gating reads).
        ...(variantChanged && variantId != null ? { variantId } : {}),
        ...(booking.isCoachBooking ? { coachPrice } : {}),
      } as any)
      // Auto-close and navigate calendar to the (possibly new) date
      onSave?.(date)
      onClose()
    } catch (e: any) {
      setError(getErrorMessage(e) ?? 'Failed to save changes.')
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
      setError(getErrorMessage(e) ?? 'Failed to cancel booking.')
      setSaving(false)
    }
  }

  // SPEC_ADMIN_MANUAL_POWERS — suggested CASH refund for the void panel.
  // G1 invariant: when paymentStatus==='paid', priceInCents already IS the cash
  // settled (Stripe webhook rewrites it; admin offline-with-credit stores net) —
  // subtracting credit again would understate. For unpaid/credit-only bookings
  // priceInCents is gross, so cash = gross − credit (usually $0).
  const suggestedRefund = useMemo(() => {
    const cents = (booking as any).priceInCents
    const credit = (booking as any).creditApplied ?? 0
    if (typeof cents === 'number') {
      if ((booking as any).paymentStatus === 'paid') return Math.max(0, Math.round(cents) / 100)
      return Math.max(0, Math.round(cents - credit * 100) / 100)
    }
    return calculatedCustomerPrice ?? 0
  }, [booking, calculatedCustomerPrice])

  const isRefunded = (booking as any).refunded === true

  const handleResend = async () => {
    setSaving(true); setError(null); setActionNote(null)
    try {
      const r: any = await resendMut({ bookingId: booking.id as any })
      setActionNote(r?.kind === 'allocation' ? 'Allocation email(s) resent to athletes.' : 'Confirmation + door code email resent.')
    } catch (e: any) {
      setError(getErrorMessage(e) ?? 'Failed to resend the confirmation.')
    } finally { setSaving(false) }
  }

  const handleVoid = async () => {
    setSaving(true); setError(null); setActionNote(null)
    try {
      let amt: number | undefined
      if (voidMode === 'credit') {
        amt = Math.round(parseFloat(voidAmount) * 100) / 100
        if (!amt || isNaN(amt) || amt <= 0) {
          setError('Enter a credit amount greater than $0.')
          setSaving(false)
          return
        }
      } else if (voidMode === 'stripe' && voidAmount.trim()) {
        const parsed = Math.round(parseFloat(voidAmount) * 100) / 100
        if (!isNaN(parsed) && parsed > 0) amt = parsed
      }
      const r: any = await voidMut({ bookingId: booking.id as any, mode: voidMode, amount: amt })
      setActionNote(voidMode === 'credit'
        ? `Charge voided — $${Number(r?.amountCredited ?? 0).toFixed(2)} account credit issued.`
        : voidMode === 'stripe'
          ? `Marked refunded via Stripe${amt ? ` — $${amt.toFixed(2)}` : ''}.`
          : 'Charge waived (written off). No money returned.')
      setShowVoid(false)
    } catch (e: any) {
      setError(getErrorMessage(e) ?? 'Failed to record the refund.')
    } finally { setSaving(false) }
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

          {/* SPEC_COACH_SPLIT_LANE_BOOKING — split-session awareness banner */}
          {splitSibling && (
            <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/50 rounded-lg p-3 text-xs text-indigo-700 dark:text-indigo-300">
              <span className="font-semibold">Split session — {splitSibling.targetIsLeg2 ? 'leg 2 of 2' : 'leg 1 of 2'}.</span>{' '}
              The other leg is {formatTime(splitSibling.startHour)}–{formatTime(splitSibling.startHour + splitSibling.duration / 60)} on {splitSibling.laneNameSnapshot ?? splitSibling.laneId}
              {splitSibling.status === 'cancelled' ? ' (cancelled)' : ''}. Cancel / Status→cancelled takes BOTH legs down; per-leg edits here are deliberate.
              {!splitSibling.targetIsLeg2 && ' Price, door code and athletes live on this leg.'}
            </div>
          )}

          {/* UI-2 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13) — extension awareness.
              Split bookings got a banner; extensions had none, so an extension row
              looked like an ordinary duplicate booking. An admin could cancel it,
              move it (breaking chain contiguity), or re-issue its door code —
              divorcing it from the parent's code while the customer is mid-session
              in the building. */}
          {(booking as any).extensionOfId && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-300">
              <span className="font-semibold">⏱ In-session extension.</span>{' '}
              This is the paid tail of an earlier booking and <span className="font-semibold">shares the parent's door code</span>.
              The customer may be in the building right now — changing the code, lane or time here affects a live session, and cancelling
              removes only this extension (the parent booking stays).
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
                    'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
                  }`}>{status}</span>
                } />
                <Field label="Date" value={new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} />
                <Field label="Time" value={`${formatTime(startHour)} – ${formatTime(startHour + duration / 60)}`} />
                <Field label="Duration" value={`${duration} min`} />
                <Field label="Type" value={booking.isCoachBooking ? '🏅 Coach' : '👤 Customer'} />
                {/* G3 — surface the machine type (was displayed nowhere). Prefers the
                    stored snapshot; falls back to the variant id's label. */}
                {!booking.isCoachBooking && ((booking as any).variantLabelSnapshot || variantId) && (
                  <Field label="Machine Type" value={(booking as any).variantLabelSnapshot ?? variantLabel(variantId)} />
                )}
                {booking.isCoachBooking && <Field label="Coach Price" value={`$${coachPrice.toFixed(2)}`} />}
                {!booking.isCoachBooking && calculatedCustomerPrice !== null && (
                  <Field label="Session Price" value={`$${(calculatedCustomerPrice as number).toFixed(2)}`} />
                )}
                {booking.accessCode && <Field label="Access Code" value={<code className="font-mono">{booking.accessCode}</code>} />}
                {booking.discountCode && <Field label="Discount" value={booking.discountCode} />}
              </div>

              {/* Admin: set/override the front-door code (per-booking + bulk). Writes
                  Krickora + pushes to Google Calendar (creates the event if missing). */}
              {status !== 'cancelled' && <DoorCodeEditor booking={booking} />}

              {/* SPEC_CLUB_TEAM_BOOKINGS: offline/club payment status + mark paid/unpaid.
                  Shown for confirmed offline bookings (club or admin paid-offline; never
                  Stripe or coach-statement bookings). */}
              {status !== 'cancelled' && !booking.isCoachBooking && !booking.stripeSessionId &&
               (booking.isClubBooking || paymentStatusLocal === 'paid' || paymentStatusLocal === 'unpaid') && (
                <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/60 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">Payment</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${paymentStatusLocal === 'unpaid' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'}`}>
                      {paymentStatusLocal === 'unpaid' ? 'Unpaid' : 'Paid'}
                    </span>
                    {booking.bookingGroupId && (
                      <span className="text-[10px] text-gray-400">· applies to the whole block</span>
                    )}
                  </div>
                  <button
                    disabled={savingPayment}
                    onClick={async () => {
                      setSavingPayment(true); setError(null); setActionNote(null)
                      try {
                        const nextPaid = paymentStatusLocal === 'unpaid'
                        const r: any = await setPaymentStatusMut({ bookingId: booking.id as any, paid: nextPaid })
                        setPaymentStatusLocal(r?.paymentStatus ?? (nextPaid ? 'paid' : 'unpaid'))
                        const n = r?.updatedCount ?? 1
                        setActionNote(`${n} session${n === 1 ? '' : 's'} marked ${nextPaid ? 'paid' : 'unpaid'}.`)
                      } catch (e: any) {
                        setError(getErrorMessage(e) ?? 'Failed to update payment status.')
                      } finally { setSavingPayment(false) }
                    }}
                    className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors disabled:opacity-50 ${paymentStatusLocal === 'unpaid' ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'}`}
                  >
                    {savingPayment ? 'Saving…' : paymentStatusLocal === 'unpaid' ? (booking.bookingGroupId ? '✓ Mark block paid' : '✓ Mark as paid') : (booking.bookingGroupId ? 'Mark block unpaid' : 'Mark as unpaid')}
                  </button>
                </div>
              )}

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

              {/* Athlete Allocations — coach bookings only. Admin can add/edit the
                  coach's athletes here (SPEC_COACH_ALLOCATION). */}
              {booking.isCoachBooking && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
                      🏏 Athlete Allocations ({(booking.athleteSlots ?? []).length})
                    </h4>
                    {/* SPEC_COACH_SPLIT_LANE_BOOKING: allocations live on the
                        CARRIER — editing them onto a leg-2 row would strand slots
                        the coach's merged card never shows (review 2026-08-12). */}
                    {status !== 'cancelled' && !splitSibling?.targetIsLeg2 && (
                      <button
                        onClick={() => setShowAthleteEditor(true)}
                        className="text-[11px] px-2.5 py-1 rounded-lg border border-orange-200 dark:border-orange-800 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 transition-colors font-semibold"
                      >
                        ✏️ Edit athletes
                      </button>
                    )}
                    {status !== 'cancelled' && splitSibling?.targetIsLeg2 && (
                      <span className="text-[10px] text-gray-400">managed on leg 1</span>
                    )}
                  </div>
                  {(booking.athleteSlots ?? []).length > 0 ? (
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
                  ) : (
                    <p className="text-xs text-gray-400 dark:text-gray-500">No athletes allocated yet — tap "Edit athletes" to add them to {booking.customerName}.</p>
                  )}
                </div>
              )}

              {/* Mates (SPEC_ADD_A_MATE + G4 admin management) — customer bookings.
                  Display names only (first name + last initial), same privacy model
                  as the customer flow. Admin add/remove acts ON THE OWNER'S BEHALF
                  (friendship + M1/M2 mate emails attribute to the owner). */}
              {!booking.isCoachBooking && (mates.length > 0 || (!isClub && status !== 'cancelled' && !mateSessionStarted)) && (
                <div>
                  <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                    👥 Mates ({mates.length}/{maxMates})
                  </h4>
                  {mates.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {mates.map((m: any) => (
                        <span
                          key={m.customerId}
                          className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50 text-blue-700 dark:text-blue-300"
                        >
                          {m.displayName}
                          {!isClub && status !== 'cancelled' && (
                            <button
                              type="button"
                              disabled={mateBusy}
                              onClick={() => handleRemoveMate(m.customerId, m.displayName)}
                              title={`Remove ${m.displayName} from this booking`}
                              className="text-blue-400 hover:text-rose-600 dark:hover:text-rose-400 font-bold leading-none"
                            >×</button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {!isClub && status !== 'cancelled' && !mateSessionStarted && mates.length < maxMates && (
                    <div className="space-y-2">
                      <form onSubmit={handleMateSearch} className="flex gap-2">
                        <input
                          type="tel"
                          value={matePhone}
                          onChange={e => { setMatePhone(e.target.value); setMateMatch(null) }}
                          placeholder="Mate's mobile number…"
                          className="flex-1 px-2.5 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg"
                        />
                        <button
                          type="submit"
                          disabled={mateSearching || matePhone.replace(/\D/g, '').length < 8}
                          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-500 text-white disabled:opacity-40"
                        >{mateSearching ? '…' : 'Search'}</button>
                      </form>
                      {mateMatch === 'none' && (
                        <div className="text-[11px] text-gray-400">No account matches that mobile — they need a Cricket Revolution account first.</div>
                      )}
                      {mateMatch && mateMatch !== 'none' && (
                        mateMatch.isSelf ? (
                          <div className="text-[11px] text-amber-600 dark:text-amber-400">That's the booking holder — they're already on this booking.</div>
                        ) : (
                          <div className="flex items-center gap-2 text-xs bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50 rounded-lg px-2.5 py-1.5">
                            <span className="flex-1 text-blue-800 dark:text-blue-200">Add <b>{mateMatch.displayName}</b> to this booking?</span>
                            <button
                              type="button"
                              disabled={mateBusy}
                              onClick={() => handleAddMate(mateMatch._id)}
                              className="px-2.5 py-1 font-semibold rounded-lg bg-emerald-500 text-white disabled:opacity-40"
                            >Add</button>
                          </div>
                        )
                      )}
                      {ownerSavedMates.filter(s => !mates.some((m: any) => m.customerId === s.customerId)).length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] uppercase font-semibold text-gray-400 tracking-wide">{customerName ? `${customerName.split(' ')[0]}'s` : "Owner's"} saved mates:</span>
                          {ownerSavedMates
                            .filter(s => !mates.some((m: any) => m.customerId === s.customerId))
                            .map(s => (
                              <button
                                key={s.customerId}
                                type="button"
                                disabled={mateBusy}
                                onClick={() => handleAddMate(s.customerId)}
                                title={`Add ${s.displayName} (${s.sharedCount} shared session${s.sharedCount === 1 ? '' : 's'})`}
                                className="text-xs px-2.5 py-1 rounded-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-40"
                              >+ {s.displayName}</button>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                  {!isClub && status !== 'cancelled' && !mateSessionStarted && mates.length >= maxMates && (
                    <div className="text-[11px] text-gray-400">Mate limit reached — owner + {maxMates} mate{maxMates === 1 ? '' : 's'} = {maxMates + 1} people max on a lane.</div>
                  )}
                  {mateMsg && (
                    <div className={`mt-1.5 text-[11px] ${mateMsg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{mateMsg.text}</div>
                  )}
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

              {/* SPEC_ADMIN_MANUAL_POWERS — resend confirmation + in-app void */}
              {actionNote && (
                <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 rounded-lg px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                  {actionNote}
                </div>
              )}
              {isRefunded && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-lg px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  💸 This charge has been voided/refunded{(booking as any).refundedAt ? ` · ${new Date((booking as any).refundedAt).toLocaleDateString()}` : ''}.
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleResend}
                  disabled={saving || status === 'cancelled'}
                  className="flex-1 px-3 py-2 rounded-lg border border-blue-200 dark:border-blue-800/50 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-sm font-semibold hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors disabled:opacity-50"
                >
                  📧 Resend confirmation
                </button>
                {!booking.isCoachBooking && !isRefunded && (
                  <button
                    onClick={() => { setShowVoid(v => !v); setVoidMode('stripe'); setVoidAmount(String(suggestedRefund)); setError(null) }}
                    disabled={saving}
                    className="flex-1 px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-sm font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors disabled:opacity-50"
                  >
                    💸 Refund / void
                  </button>
                )}
              </div>

              {showVoid && !isRefunded && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg p-4 space-y-3">
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Record a refund / void</p>
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">Card refunds are processed in Stripe directly — this records the outcome on Krickora. Does not cancel the booking.</p>
                  <div className="grid grid-cols-3 gap-2">
                    <button onClick={() => setVoidMode('stripe')} className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${voidMode === 'stripe' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700'}`}>Refunded via Stripe</button>
                    <button onClick={() => setVoidMode('credit')} className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${voidMode === 'credit' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700'}`}>Account credit</button>
                    <button onClick={() => setVoidMode('waive')} className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${voidMode === 'waive' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700'}`}>Waive</button>
                  </div>
                  {voidMode !== 'waive' && (
                    <label className="block">
                      <span className="text-[10px] uppercase font-semibold text-amber-700 dark:text-amber-400 tracking-wide">
                        {voidMode === 'credit' ? 'Credit amount ($)' : 'Amount refunded ($) — optional, for the record'}
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        value={voidAmount}
                        onChange={e => setVoidAmount(e.target.value)}
                        className="mt-1 w-full px-2.5 py-1.5 text-sm bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-800 rounded-lg outline-none text-gray-800 dark:text-gray-200"
                      />
                    </label>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => setShowVoid(false)} disabled={saving} className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-semibold hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50">Cancel</button>
                    <button onClick={handleVoid} disabled={saving} className="flex-1 px-3 py-2 rounded-lg bg-amber-500 text-white text-sm font-semibold hover:bg-amber-600 transition-colors disabled:opacity-50">
                      {saving ? 'Working…' : voidMode === 'credit' ? 'Issue credit' : voidMode === 'stripe' ? 'Mark refunded' : 'Waive charge'}
                    </button>
                  </div>
                </div>
              )}

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
                {/* G3 — machine-type switch (customer/club bookings on a multi-variant
                    segment). Price is NOT auto-adjusted — the delta shows in Session
                    Price below; collect/return it via the top-up link or void tools. */}
                {!booking.isCoachBooking && variantOptions.length > 1 && (
                  <div className="col-span-2">
                    <Select
                      label="Machine Type"
                      value={variantId ?? variantOptions[0]}
                      onChange={(v) => setVariantId(v)}
                      options={variantOptions}
                      optionLabels={variantOptions.map(v => variantLabel(v) + (!segVariants.includes(v) ? ' (not offered on this lane/date)' : ''))}
                    />
                    {variantChanged && (
                      <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                        Machine type will change on save (calendar + HA machine power follow automatically).
                        Price is not auto-adjusted — use the top-up link / void tools for any difference.
                      </div>
                    )}
                  </div>
                )}
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
                {!booking.isCoachBooking && !isClub && calculatedCustomerPrice !== null && (
                  <div className="col-span-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-200 dark:border-blue-800/40">
                    <div className="text-[10px] uppercase font-semibold text-blue-600 dark:text-blue-400 tracking-wide">Session Price</div>
                    <div className="text-sm font-bold text-blue-800 dark:text-blue-200 mt-0.5">
                      ${(calculatedCustomerPrice as number).toFixed(2)}{' '}
                      {/* Honest payment status (was a hardcoded "already charged" that was
                          wrong on an extended-but-not-topped-up booking). Reflects what
                          was ACTUALLY paid (priceInCents) vs the current price. */}
                      <span className={`text-[10px] font-normal ${balanceDueDollars > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-blue-500'}`}>
                        {(booking as any).paymentStatus === 'paid'
                          ? `· $${alreadyPaidDollars.toFixed(2)} paid${creditCoveredDollars > 0 ? ` + $${creditCoveredDollars.toFixed(2)} credit` : ''}${balanceDueDollars > 0 ? ` · $${balanceDueDollars.toFixed(2)} still owing` : ''}`
                          : '· not yet charged'}
                      </span>
                      {pendingLinkCents > 0 && (
                        <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                          ⏳ ${(pendingLinkCents / 100).toFixed(2)} payment link pending
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {/* SPEC_ADMIN_TOPUP — collect the difference after extending a customer booking.
                    Hidden for club/team bookings (offline invoice, no Stripe). */}
                {!booking.isCoachBooking && !isClub && calculatedCustomerPrice !== null && (
                  <div className="col-span-2 bg-amber-50 dark:bg-amber-900/15 rounded-lg px-3 py-2.5 border border-amber-200 dark:border-amber-800/40 space-y-2">
                    <div className="text-[10px] uppercase font-semibold text-amber-700 dark:text-amber-400 tracking-wide">💳 Top-up payment link</div>
                    <div className="text-[11px] text-gray-600 dark:text-gray-400">
                      Already paid <b>${alreadyPaidDollars.toFixed(2)}</b> · New price <b>${(calculatedCustomerPrice as number).toFixed(2)}</b> · Balance due <b>${balanceDueDollars.toFixed(2)}</b>
                    </div>
                    <p className="text-[10px] text-gray-400">Save the new duration first, then send this link to the customer to pay the difference.</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1">
                        <span className="text-sm text-gray-500">$</span>
                        <input type="number" step="0.01" min="0" value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)}
                          className="w-20 px-2 py-1 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-gray-800 dark:text-gray-200" />
                      </div>
                      <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400 cursor-pointer">
                        <input type="checkbox" checked={topUpEmail} onChange={(e) => setTopUpEmail(e.target.checked)} className="rounded" /> Email link to customer
                      </label>
                      <button onClick={handleGenerateTopUpLink} disabled={generatingLink}
                        className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-semibold disabled:opacity-50 transition-colors">
                        {generatingLink ? 'Generating…' : 'Generate link'}
                      </button>
                    </div>
                    {linkError && <p className="text-[11px] text-red-500">{linkError}</p>}
                    {paymentLinkUrl && (
                      <div className="flex items-center gap-2 bg-white dark:bg-gray-900 rounded-lg px-2 py-1.5 border border-amber-200 dark:border-amber-800/40">
                        <input readOnly value={paymentLinkUrl} onFocus={(e) => e.currentTarget.select()}
                          className="flex-1 min-w-0 text-[11px] bg-transparent outline-none text-gray-700 dark:text-gray-300" />
                        <button onClick={() => { navigator.clipboard?.writeText(paymentLinkUrl); setLinkCopied(true) }}
                          className="shrink-0 text-[11px] px-2 py-1 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-semibold">
                          {linkCopied ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                    )}
                    {/* SPEC_PAYMENT_LINK_TRACKING_2026-07 — this booking's sent links w/ live status. */}
                    {bookingLinks.length > 0 && (
                      <div className="space-y-1 pt-1.5 border-t border-amber-200/60 dark:border-amber-800/30">
                        <div className="text-[10px] uppercase font-semibold text-amber-700 dark:text-amber-400 tracking-wide">Sent links</div>
                        {bookingLinks.map((l: any) => (
                          <div key={l.id} className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="text-gray-600 dark:text-gray-400 truncate">
                              ${(l.amountCents / 100).toFixed(2)} · sent {new Date(l.createdAt).toLocaleDateString('en-AU')}
                              {l.sentToEmail ? ' · emailed' : ''}
                            </span>
                            {l.status === 'paid' ? (
                              <span className="shrink-0 font-semibold text-green-600 dark:text-green-400">
                                ✓ Paid{l.manualPaid ? ' (offline)' : ''}{l.paidAt ? ` ${new Date(l.paidAt).toLocaleDateString('en-AU')}` : ''}
                              </span>
                            ) : l.status === 'cancelled' ? (
                              <span className="shrink-0 text-gray-400">Cancelled</span>
                            ) : (
                              <span className="shrink-0 flex items-center gap-1.5">
                                <span className="font-semibold text-amber-600 dark:text-amber-400">⏳ Pending</span>
                                <button onClick={() => navigator.clipboard?.writeText(l.url)}
                                  className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-semibold">
                                  Copy
                                </button>
                              </span>
                            )}
                          </div>
                        ))}
                        <p className="text-[10px] text-gray-400">Cancel / mark-paid-offline: Analytics → 💳 Payment Links.</p>
                      </div>
                    )}
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
              {/* SPEC_TEAM_BOOKING_AUTODOOR_2026-07: roller-door auto-open (team booking). */}
              <label className="flex items-start gap-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl p-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoDoor}
                  onChange={(e) => setAutoDoor(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-purple-500 shrink-0"
                />
                <span className="text-xs text-gray-600 dark:text-gray-300">
                  <span className="font-semibold text-gray-800 dark:text-gray-200">🚪 Auto-open roller door (team booking)</span>
                  {' '}— door opens ~15 min before start, holds open, closes ~5 min after start.
                  Save at least 15 min before the session for HA to pick it up.
                </span>
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
      {/* SPEC_COACH_ALLOCATION — admin allocates athletes to the booking's coach. */}
      {showAthleteEditor && booking.isCoachBooking && !splitSibling?.targetIsLeg2 && (
        <AthleteAllocationEditor
          bookingStartHour={booking.startHour}
          bookingDuration={splitGroupDuration ?? booking.duration}
          currentSlots={booking.athleteSlots ?? []}
          coachId={booking.customerEmail}
          onSave={handleSaveAthleteSlots}
          onClose={() => setShowAthleteEditor(false)}
          defaultSessionDuration={coachRecord?.defaultSessionDuration ?? undefined}
          athleteCapacity={coachRecord?.athleteCapacity ?? undefined}
          coachesSimultaneously={coachRecord?.coachesSimultaneously ?? false}
        />
      )}
    </div>
  )
}

// Admin door-code editor — set a specific front-door PIN on this booking, or bulk
// across all of the customer's upcoming bookings. Writes Krickora's stored code AND
// pushes it to Google Calendar (so HA loads it); creates the calendar event if the
// booking never synced. Backend is admin-gated (adminSetBookingDoorCode / bulk).
function DoorCodeEditor({ booking }: { booking: Booking }) {
  const setCodeMut = useMutation((api.mutations as any).adminSetBookingDoorCode)
  const bulkMut = useMutation((api.mutations as any).adminBulkSetBookingDoorCode)
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState(booking.accessCode ?? '')
  const [applyAll, setApplyAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const upcoming = useQuery(
    (api.mutations as any).adminListCustomerUpcomingBookings,
    open && booking.customerEmail ? { email: booking.customerEmail } : 'skip',
  ) as Array<{ id: string; date: string; startHour: number; lane: string; accessCode: string | null }> | undefined

  const valid = /^\d{4,6}$/.test(code.trim())
  const count = upcoming?.length ?? 0
  const firstName = (booking.customerName ?? 'this customer').split(' ')[0]

  const save = async () => {
    setBusy(true); setErr(null); setMsg(null)
    try {
      if (applyAll && count > 0) {
        const r: any = await bulkMut({ bookingIds: (upcoming ?? []).map(u => u.id), code: code.trim() })
        setMsg(`Set to ${code.trim()} on ${r.updated} booking${r.updated === 1 ? '' : 's'}. Google Calendar is updating (a few seconds).`)
      } else {
        await setCodeMut({ bookingId: booking.id as any, code: code.trim() })
        setMsg(`Set to ${code.trim()}. Google Calendar is updating.`)
      }
    } catch (e: any) {
      setErr(getErrorMessage(e) ?? 'Failed to set the door code.')
    } finally { setBusy(false) }
  }

  return (
    <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase font-semibold text-indigo-700 dark:text-indigo-300 tracking-wide">🔑 Door code (admin)</span>
        {!open && (
          <button onClick={() => { setOpen(true); setCode(booking.accessCode ?? ''); setMsg(null); setErr(null) }} className="text-xs font-semibold text-indigo-600 dark:text-indigo-300 hover:underline">
            ✏️ Edit
          </button>
        )}
      </div>
      {open && (
        <>
          <div className="flex items-center gap-2">
            <input
              value={code}
              onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="4–6 digits"
              className="w-28 px-2.5 py-1.5 text-sm font-mono bg-white dark:bg-gray-800 border border-indigo-200 dark:border-indigo-800 rounded-lg outline-none text-gray-800 dark:text-gray-200"
            />
            <button onClick={save} disabled={!valid || busy} className="px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50">
              {busy ? 'Saving…' : 'Update'}
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
            <input type="checkbox" checked={applyAll} onChange={e => setApplyAll(e.target.checked)} />
            Apply to all of {firstName}'s upcoming bookings{upcoming ? ` (${count})` : '…'}
          </label>
          <p className="text-[10px] text-indigo-600/80 dark:text-indigo-300/70">
            Updates Krickora and pushes the code to Google Calendar (HA reads it). 4–6 digits, not a reserved staff code.
          </p>
        </>
      )}
      {msg && <div className="text-xs text-emerald-600 dark:text-emerald-400">{msg}</div>}
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
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
