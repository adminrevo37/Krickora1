// SPEC_CUSTOMER_INSESSION_EXTEND_2026-08 — in-session "Extend session" modal.
// Opens from the customer booking card between session start and end + 7 min.
// Offers +30 min / +1 hr on the booking's OWN lanes first; when those aren't
// free, falls back to other free lanes (clearly labelled as a lane change,
// decision #7). Pays via the shared embedded Stripe checkout (or confirms
// instantly when account credit covers it). Availability here is a UI mirror —
// extendBookingLive is authoritative server-side.
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { getErrorMessage } from '../lib/errors'
import {
  LANES, formatTime, getAWSTNow, bookingOccupiesLane, type Booking,
} from '../lib/booking-data'
import { getSettingsStore, getHoursForDate } from '../lib/settings-store'
import {
  resolveLaneAt, segmentIsClosed, variantRatePerHour, normalizeVariant,
} from '../lib/lanes'
import { useLaneBlocks } from '../hooks/useLaneBlocks'
import { createCheckoutSession, cancelUnpaidCheckout } from '../lib/stripe'
import EmbeddedCheckoutModal from './EmbeddedCheckoutModal'

interface ExtendBookingModalProps {
  booking: Booking // the merged parent card booking (client-only `extensions` attached)
  creditBalance: number
  onClose: () => void
}

interface ExtendOption {
  key: string
  durationMinutes: 30 | 60
  laneIds: string[]
  laneNames: string[]
  priceCents: number
  partialMissing: string[] // own lanes NOT available (decision #6 warning)
  isFallback: boolean // a different-lane offer (decision #7)
}

export default function ExtendBookingModal({ booking, creditBalance, onClose }: ExtendBookingModalProps) {
  const settings = getSettingsStore().get()

  // The extend target is the LAST row in the chain: the parent itself, or its
  // newest absorbed extension (chained extends hang off the newest row).
  const lastRow = useMemo(() => {
    const exts = booking.extensions ?? []
    if (exts.length === 0) {
      return {
        id: booking.id,
        laneId: booking.laneId,
        additionalLaneIds: booking.additionalLaneIds,
        variantId: booking.variantId ?? null,
        startHour: booking.startHour,
        duration: booking.duration,
      }
    }
    return exts[exts.length - 1]
  }, [booking])

  const extStart = lastRow.startHour + lastRow.duration / 60
  const ownLanes = useMemo(
    () => [lastRow.laneId, ...(lastRow.additionalLaneIds ?? [])],
    [lastRow]
  )
  const lastVariant = lastRow.variantId ?? null

  const dayBookingsRaw = useQuery(api.queries.listBookingsByDate, { date: booking.date })
  const dayBookings = useMemo(
    () =>
      (dayBookingsRaw ?? [])
        .filter((b: any) => b.status !== 'cancelled')
        .map((b: any) => ({ ...b, id: String(b._id) }) as Booking),
    [dayBookingsRaw]
  )
  const { blocks, getBlocksForLaneDate } = useLaneBlocks()

  const laneDisplayName = (laneId: string) => resolveLaneAt(laneId, booking.date, extStart).name

  // UI-1 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13) — rows belonging to THIS
  // booking's own chain must never count as a conflict against itself. Without
  // this, a failed checkout leaves the just-created pending extension row in the
  // reactive day list; it occupies the very window we're offering, so every option
  // disappears and the modal claims "the lanes are booked after your session" —
  // hiding the real error and the retry. Covers the parent, every absorbed
  // extension, and any not-yet-absorbed (pending) row hanging off the chain.
  const chainIds = useMemo(() => {
    const ids = new Set<string>([String(booking.id)])
    for (const e of booking.extensions ?? []) ids.add(String(e.id))
    return ids
  }, [booking])
  const isOwnChainRow = (b: Booking) =>
    chainIds.has(String(b.id)) ||
    (!!b.extensionOfId && chainIds.has(String(b.extensionOfId)))

  // Availability mirror of extendBookingLive §3: within close, open segment, no
  // boundary cross, variant still offered (own primary lane), no booking
  // conflict, no service block. Slot holds are server-only — a held window
  // surfaces as a clear server error on Confirm.
  const laneFreeFor = (laneId: string, durationMinutes: number): boolean => {
    const extEnd = extStart + durationMinutes / 60
    const { close } = getHoursForDate(settings, booking.date)
    if (extEnd > close + 1e-9) return false
    const resolved = resolveLaneAt(laneId, booking.date, extStart)
    if (segmentIsClosed(resolved.segment)) return false
    if (extEnd > resolved.segment.endHour + 1e-9) return false
    if (laneId === lastRow.laneId && lastVariant) {
      const offered = resolved.segment.variants.map((v: string) => normalizeVariant(v))
      if (!offered.includes(normalizeVariant(lastVariant))) return false
    }
    const conflict = dayBookings.some((b) => {
      if (isOwnChainRow(b)) return false // UI-1: never conflict with our own chain
      if (!bookingOccupiesLane(b, laneId)) return false
      const bEnd = b.startHour + b.duration / 60
      return extStart < bEnd && extEnd > b.startHour
    })
    if (conflict) return false
    const blocked = getBlocksForLaneDate(laneId, booking.date).some((blk) => {
      const blkEnd = blk.startHour + blk.duration / 60
      return extStart < blkEnd && extEnd > blk.startHour
    })
    return !blocked
  }

  const priceCentsFor = (laneIds: string[], durationMinutes: number): number =>
    laneIds.reduce(
      (sum, l) =>
        sum +
        Math.round(
          variantRatePerHour(l === lastRow.laneId ? lastVariant : null, settings) *
            (durationMinutes / 60) *
            100
        ),
      0
    )

  // Options per duration: own lanes first; different-lane fallback ONLY when no
  // own lane is free (each fallback lane offered individually).
  const options = useMemo<ExtendOption[]>(() => {
    const out: ExtendOption[] = []
    for (const durationMinutes of [30, 60] as const) {
      const ownAvail = ownLanes.filter((l) => laneFreeFor(l, durationMinutes))
      if (ownAvail.length > 0) {
        out.push({
          // SYNC-9: include the lane set in the key. With a duration-only key the
          // SAME option could silently swap to fewer lanes (and a lower price) when
          // another booking landed mid-selection — the selection stayed "valid" but
          // now meant something different from what the user read.
          key: `own-${durationMinutes}-${ownAvail.join('+')}`,
          durationMinutes,
          laneIds: ownAvail,
          laneNames: ownAvail.map(laneDisplayName),
          priceCents: priceCentsFor(ownAvail, durationMinutes),
          partialMissing: ownLanes.filter((l) => !ownAvail.includes(l)).map(laneDisplayName),
          isFallback: false,
        })
      } else {
        for (const lane of LANES.map((l) => l.id).filter((l) => !ownLanes.includes(l))) {
          if (!laneFreeFor(lane, durationMinutes)) continue
          out.push({
            key: `alt-${durationMinutes}-${lane}`,
            durationMinutes,
            laneIds: [lane],
            laneNames: [laneDisplayName(lane)],
            priceCents: priceCentsFor([lane], durationMinutes),
            partialMissing: [],
            isFallback: true,
          })
        }
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayBookings, blocks, ownLanes, extStart, booking.date])

  // U21 — when there are no options, say WHY. `laneFreeFor` fails for closing
  // time and segment limits just as readily as for a booked lane, so the old
  // blanket "the lanes are booked after your session" was often simply untrue:
  // at closing time every lane is free, there is just no night left.
  const closesBeforeShortestExtend = useMemo(() => {
    const { close } = getHoursForDate(settings, booking.date)
    return extStart + 0.5 > close + 1e-9
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, booking.date, extStart])
  const closingTimeLabel = formatTime(getHoursForDate(settings, booking.date).close)

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [applyCredit, setApplyCredit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'select' | 'success'>('select')
  // Captured at confirm time — `options` recompute reactively once the extension
  // row lands, so the selected option can vanish mid-success.
  const [confirmedEndHour, setConfirmedEndHour] = useState<number | null>(null)
  const [embeddedPay, setEmbeddedPay] = useState<{ clientSecret: string; bookingId: string } | null>(null)

  const selected = options.find((o) => o.key === selectedKey) ?? null
  const creditCents = Math.max(0, Math.round(creditBalance * 100))
  const dueCentsPreview = selected
    ? Math.max(0, selected.priceCents - (applyCredit ? Math.min(creditCents, selected.priceCents) : 0))
    : 0
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`

  // Amber timing note when < 5 min to end (or already past end): the building
  // automation (door code window / machine power) can take 1–2 min to follow.
  // UI-9 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13): tick so the "automation takes
  // 1–2 minutes" warning actually appears while the modal sits open. It was
  // evaluated once per render with nothing driving a re-render, so a user who
  // opened the modal 6 minutes out and deliberated past the 5-minute threshold
  // never saw it. 30s matches MyBookings' extend-window tick.
  const [, setNowTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const nowMs = getAWSTNow().getTime()
  const [y, m, d] = booking.date.split('-').map(Number)
  const endWallMs = new Date(y, m - 1, d, 0, 0, 0).getTime() + extStart * 3600_000
  const showTimingWarning = nowMs > endWallMs - 5 * 60_000

  const extendLive = useMutation(api.mutations.extendBookingLive)

  const handleConfirm = async () => {
    if (!selected || busy) return
    setBusy(true)
    setError(null)
    setConfirmedEndHour(extStart + selected.durationMinutes / 60)
    // UI-1: tracked so the catch can release an extension row that was created but
    // never reached checkout.
    let createdId: string | null = null
    try {
      const res: any = await extendLive({
        parentId: lastRow.id as Id<'bookings'>,
        durationMinutes: selected.durationMinutes,
        laneIds: selected.laneIds,
        applyCredit: applyCredit || undefined,
      })
      createdId = res?.id ? String(res.id) : null
      if (res.status === 'confirmed') {
        setStep('success')
        return
      }
      // Balance due — pay in-app via the shared embedded checkout (the server
      // recomputes the amount authoritatively from the extension row).
      const primary = selected.laneIds[0]
      const session = await createCheckoutSession({
        laneId: primary,
        laneName: laneDisplayName(primary),
        variantId: primary === lastRow.laneId ? (lastVariant ?? null) : null,
        variantName: null,
        date: booking.date,
        startHour: extStart,
        duration: selected.durationMinutes,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        price: res.dueCents / 100,
        additionalLanes: selected.laneIds.slice(1).map(laneDisplayName),
        bookingId: res.id,
      })
      if (session.clientSecret) {
        setEmbeddedPay({ clientSecret: session.clientSecret, bookingId: res.id })
        return
      }
      if (session.url) {
        window.location.assign(session.url)
        return
      }
      throw new Error('Could not start the payment — please try again.')
    } catch (e) {
      setError(getErrorMessage(e) ?? 'Something went wrong — please try again.')
      // UI-1: if the extension row was created but checkout never opened, release
      // it. Otherwise it sits `pending_payment` — blocking this booking's own
      // retry and showing the customer an unexplained "Awaiting payment" card —
      // until the ~30-min checkout-hold backstop expires.
      if (createdId && !embeddedPay) {
        cancelUnpaidCheckout(createdId).catch(() => { /* backstops will catch it */ })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 shadow-xl p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">⏱ Extend session</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Current session ends {formatTime(extStart)} — same door code carries over.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none" aria-label="Close">×</button>
        </div>

        {step === 'success' ? (
          <div className="py-4">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 mb-1.5">
              ✅ Extension confirmed
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-300">
              Your session now runs until{' '}
              {confirmedEndHour != null ? formatTime(confirmedEndHour) : ''} — keep using door code{' '}
              <span className="font-mono font-semibold">{booking.accessCode}</span>.
            </p>
            {showTimingWarning && (
              <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                Heads up — the door code and machine can take 1–2 minutes to update after payment.
              </p>
            )}
            <button
              onClick={onClose}
              className="mt-4 w-full rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-semibold py-2"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* UI-1: the error lives OUTSIDE the options branch. It used to render
                only when options existed, so a failure that also emptied the
                options list took the message and the retry button down with it. */}
            {error && (
              <div className="mb-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3">
                <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
                <button
                  onClick={handleConfirm}
                  disabled={!selected || busy}
                  className="mt-2 text-xs font-semibold text-red-800 dark:text-red-200 underline disabled:opacity-50"
                >
                  Try again
                </button>
              </div>
            )}
            {dayBookingsRaw === undefined ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 py-4">Checking lane availability…</p>
            ) : options.length === 0 ? (
              <p className="text-sm text-gray-600 dark:text-gray-300 py-4">
                {closesBeforeShortestExtend
                  ? `The facility closes at ${closingTimeLabel} — there's no time left to extend tonight.`
                  : 'Extension not available — the lanes are booked after your session.'}
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  {options.map((o) => (
                    <label
                      key={o.key}
                      className={`block rounded-xl border-2 p-3 cursor-pointer transition-colors ${
                        selectedKey === o.key
                          ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/10'
                          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="extend-option"
                            checked={selectedKey === o.key}
                            onChange={() => setSelectedKey(o.key)}
                          />
                          <span className="text-sm font-semibold text-gray-900 dark:text-white">
                            +{o.durationMinutes === 60 ? '1 hour' : '30 min'}
                            {o.isFallback ? ` on ${o.laneNames.join(', ')}` : ''}
                          </span>
                        </div>
                        <span className="text-sm font-bold text-gray-900 dark:text-white">{fmt(o.priceCents)}</span>
                      </div>
                      {o.isFallback && (
                        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                          Your lane is booked next — continue on {o.laneNames.join(', ')} instead (same door code).
                        </p>
                      )}
                      {o.partialMissing.length > 0 && (
                        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                          ⚠️ {o.laneNames.join(', ')} only — {o.partialMissing.join(', ')}{' '}
                          {o.partialMissing.length === 1 ? 'is' : 'are'} not available after {formatTime(extStart)}.
                        </p>
                      )}
                    </label>
                  ))}
                </div>

                {creditCents > 0 && (
                  <label className="mt-3 flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <input type="checkbox" checked={applyCredit} onChange={(e) => setApplyCredit(e.target.checked)} />
                    Use account credit (${creditBalance.toFixed(2)} available)
                  </label>
                )}

                {selected && (
                  <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                    To pay now: <span className="font-semibold">{fmt(dueCentsPreview)}</span>
                    {applyCredit && dueCentsPreview < selected.priceCents ? ' after credit' : ''}
                  </p>
                )}

                {showTimingWarning && (
                  <p className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
                    Heads up — the door code and machine can take 1–2 minutes to update after payment.
                  </p>
                )}

                {/* UI-1: error now rendered above, outside the options branch. */}

                <button
                  onClick={handleConfirm}
                  disabled={!selected || busy}
                  className="mt-3 w-full rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-semibold py-2.5"
                >
                  {busy ? 'Working…' : dueCentsPreview > 0 ? `Extend & pay ${fmt(dueCentsPreview)}` : 'Confirm extension'}
                </button>
              </>
            )}
          </>
        )}

        {embeddedPay && (
          <EmbeddedCheckoutModal
            clientSecret={embeddedPay.clientSecret}
            onComplete={() => {
              setEmbeddedPay(null)
              setStep('success')
            }}
            onClose={() => {
              const ep = embeddedPay
              setEmbeddedPay(null)
              // Abandoned mid-payment: release the pending extension row + hold.
              if (ep?.bookingId) { cancelUnpaidCheckout(ep.bookingId).catch(() => { /* backstops will catch it */ }) }
            }}
          />
        )}
      </div>
    </div>
  )
}
