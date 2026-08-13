// SPEC_PAYMENT_LINK_TRACKING_2026-07 — admin visibility for sent payment links
// (top-up + manual payment requests). Previously a link only became a record when
// PAID; sent-but-unpaid links were invisible, so a part-paid booking looked
// underbilled. Rows are live (reactive): a link flips to Paid the moment the
// Stripe webhook lands. Pending links can be copied, cancelled (deactivates the
// Stripe URL) or marked paid offline (cash/EFT — deactivates the URL first so it
// can never also be card-paid).
import { useState } from 'react'
import { useQuery, useAction } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { Section, Loading, Empty } from './shared'

type LinkRow = {
  id: string
  stripePaymentLinkId: string
  bookingId: string | null
  purpose: string
  amountCents: number
  currency: string
  status: string
  customerName: string | null
  customerEmail: string | null
  sentToEmail: string | null
  url: string
  description: string
  createdBy: string
  createdAt: number
  paidAt: number | null
  cancelledAt: number | null
  manualPaid: boolean
  receiptUrl: string | null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

// AWST (UTC+8, no DST) wall-clock.
function fmtTime(ms: number): string {
  const d = new Date(ms + 8 * 3600000)
  const h = d.getUTCHours()
  const h12 = (h % 12) || 12
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${h12}:${pad(d.getUTCMinutes())}${h >= 12 ? 'pm' : 'am'}`
}

const FILTERS = [
  { id: undefined, label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'paid', label: 'Paid' },
  { id: 'cancelled', label: 'Cancelled' },
] as const

function StatusChip({ row }: { row: LinkRow }) {
  if (row.status === 'paid')
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-800">
        ✓ Paid{row.manualPaid ? ' (offline)' : ''}{row.paidAt ? ` · ${fmtTime(row.paidAt)}` : ''}
      </span>
    )
  if (row.status === 'cancelled')
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-200 text-gray-600">
        Cancelled{row.cancelledAt ? ` · ${fmtTime(row.cancelledAt)}` : ''}
      </span>
    )
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800">
      ⏳ Pending
    </span>
  )
}

export default function PaymentLinksTab() {
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // UI-8: surfaces a failed clipboard write instead of falsely reporting success.
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = useQuery((api as any).paymentLinks.listPaymentLinks, { status, limit: 200 }) as
    | LinkRow[]
    | undefined
  const cancelLink = useAction((api as any).stripe.cancelPaymentLink)
  const markPaidManually = useAction((api as any).stripe.markPaymentLinkPaidManually)

  if (rows === undefined) return <Loading label="Loading payment links…" />

  const pendingTotal = rows.filter((r) => r.status === 'pending').reduce((s, r) => s + r.amountCents, 0)

  const doCancel = async (r: LinkRow) => {
    if (!window.confirm(`Cancel this ${r.purpose === 'topup' ? 'top-up' : 'payment'} link for $${(r.amountCents / 100).toFixed(2)}? The URL stops accepting payment.`)) return
    setBusyId(r.id); setError(null)
    try {
      await cancelLink({ linkId: r.id, stripePaymentLinkId: r.stripePaymentLinkId })
    } catch (e: any) {
      setError(e?.message ?? 'Failed to cancel the link.')
    } finally {
      setBusyId(null)
    }
  }

  const doMarkPaid = async (r: LinkRow) => {
    if (!window.confirm(`Mark this link PAID OFFLINE ($${(r.amountCents / 100).toFixed(2)} ${r.currency})? ${r.purpose === 'topup' ? 'The booking price will be bumped and a payment row recorded, exactly like a card payment.' : 'Only the link is marked paid (the booking keeps its own paid/unpaid state).'} The Stripe URL is deactivated first so it can't also be card-paid.`)) return
    setBusyId(r.id); setError(null)
    try {
      await markPaidManually({ linkId: r.id, stripePaymentLinkId: r.stripePaymentLinkId })
    } catch (e: any) {
      setError(e?.message ?? 'Failed to mark the link paid.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Section
      title="Payment links"
      subtitle="Admin-sent Stripe links (top-ups + manual payment requests) — pending links were previously invisible until paid."
      action={
        <span className="text-xs text-gray-500">
          {rows.length} shown{pendingTotal > 0 ? ` · $${(pendingTotal / 100).toFixed(2)} outstanding` : ''}
        </span>
      }
    >
      <div className="flex items-center gap-1 px-4 pt-3">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setStatus(f.id as string | undefined)}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
              status === f.id ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error && <div className="mx-4 mt-2 text-xs text-red-600">{error}</div>}
      {rows.length === 0 ? (
        <Empty label="No payment links yet — send one from a booking's details modal." />
      ) : (
        <div className="divide-y divide-gray-100">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-900">${(r.amountCents / 100).toFixed(2)}</span>
                  <span className="text-[11px] uppercase tracking-wide text-gray-400">{r.purpose === 'topup' ? 'Top-up' : 'Manual'}</span>
                  <StatusChip row={r} />
                </div>
                <div className="text-xs text-gray-600 truncate">
                  {r.customerName ?? r.customerEmail ?? 'Customer'} · {r.description}
                </div>
                <div className="text-[11px] text-gray-400">
                  Sent {fmtTime(r.createdAt)} by {r.createdBy}
                  {r.sentToEmail ? ` · emailed to ${r.sentToEmail}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {r.status === 'pending' && (
                  <>
                    {/* UI-8 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13): the write
                        promise was ignored and "Copied ✓" shown unconditionally, so
                        a denied-permission / insecure-context failure left the admin
                        believing the customer had a link that was never sent. */}
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(r.url)
                          setCopiedId(r.id)
                          setTimeout(() => setCopiedId(null), 1500)
                        } catch {
                          setCopyFailedId(r.id)
                          window.prompt('Copy the payment link:', r.url)
                          setTimeout(() => setCopyFailedId(null), 4000)
                        }
                      }}
                      className="px-2 py-1 rounded-lg text-xs font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200"
                    >
                      {copiedId === r.id ? 'Copied ✓' : copyFailedId === r.id ? 'Copy failed' : 'Copy link'}
                    </button>
                    <button
                      onClick={() => doMarkPaid(r)}
                      disabled={busyId === r.id}
                      className="px-2 py-1 rounded-lg text-xs font-semibold bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-50"
                    >
                      Mark paid
                    </button>
                    <button
                      onClick={() => doCancel(r)}
                      disabled={busyId === r.id}
                      className="px-2 py-1 rounded-lg text-xs font-semibold bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </>
                )}
                {r.status === 'paid' && r.receiptUrl && (
                  <a
                    href={r.receiptUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2 py-1 rounded-lg text-xs font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200"
                  >
                    Receipt ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}
