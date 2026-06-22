import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import { buildCoachLedger, todayAndMonthStart, type LedgerRow } from '../lib/statementLedger'

type Props = {
  coachId: string
  coachEmail?: string
  coachName?: string
  /** Admin context → show edit/delete controls + add-adjustment form. */
  editable?: boolean
}

export default function CoachStatementTable({ coachId, coachEmail, coachName, editable = false }: Props) {
  const payments = useQuery(api.queries.listPaymentsByCoach, coachId ? { coachId } : 'skip')
  const bookings = useQuery(
    api.queries.listBookingsByEmail,
    coachEmail ? { email: coachEmail } : 'skip'
  )
  const adjustments = useQuery(
    (api as any).statements.listStatementAdjustments,
    coachId ? ({ subjectType: 'coach', subjectId: coachId } as any) : 'skip'
  )

  const updatePayment = useMutation((api.mutations as any).updatePayment)
  const deletePayment = useMutation((api.mutations as any).deletePayment)
  const addAdjustment = useMutation((api as any).statements.addStatementAdjustment)
  const updateAdjustment = useMutation((api as any).statements.updateStatementAdjustment)
  const deleteAdjustment = useMutation((api as any).statements.deleteStatementAdjustment)
  const setCoachPrice = useMutation((api.mutations as any).adminSetCoachPrice)
  const setBookingExcluded = useMutation((api.mutations as any).adminSetBookingStatementExcluded)

  const { todayStr, monthStart } = todayAndMonthStart()
  const ledger = buildCoachLedger({
    bookings: bookings ?? [],
    payments: payments ?? [],
    adjustments: adjustments ?? [],
    todayStr,
    monthStart,
  })

  const loading = payments === undefined || bookings === undefined || adjustments === undefined

  // ── Row edit state ──────────────────────────────────────────────────────
  const [editKey, setEditKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const savePaymentEdit = async (id: string, amount: number, dateReceived: string, method: string, description: string) => {
    setBusy(true)
    try {
      await updatePayment({ id, amount, dateReceived, method, description } as any)
      setEditKey(null)
    } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to update payment') }
    finally { setBusy(false) }
  }
  const removePayment = async (id: string) => {
    if (!confirm('Delete this payment? This cannot be undone.')) return
    setBusy(true)
    try { await deletePayment({ id } as any) }
    catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to delete payment') }
    finally { setBusy(false) }
  }
  const saveAdjustEdit = async (id: string, delta: number, label: string, note: string, date: string) => {
    setBusy(true)
    try {
      await updateAdjustment({ id, delta, label, note, date } as any)
      setEditKey(null)
    } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to update adjustment') }
    finally { setBusy(false) }
  }
  const removeAdjust = async (id: string) => {
    if (!confirm('Delete this adjustment line? This cannot be undone.')) return
    setBusy(true)
    try { await deleteAdjustment({ id } as any) }
    catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to delete adjustment') }
    finally { setBusy(false) }
  }
  const saveChargeEdit = async (bookingId: string, coachPrice: number) => {
    setBusy(true)
    try {
      await setCoachPrice({ bookingId, coachPrice } as any)
      setEditKey(null)
    } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to update charge') }
    finally { setBusy(false) }
  }
  const removeBooking = async (bookingId: string) => {
    if (!confirm('Remove this session\'s charge from the statement? It won\'t count toward the balance. You can restore it later.')) return
    setBusy(true)
    try { await setBookingExcluded({ bookingId, excluded: true } as any) }
    catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to remove charge') }
    finally { setBusy(false) }
  }
  const restoreBooking = async (bookingId: string) => {
    setBusy(true)
    try { await setBookingExcluded({ bookingId, excluded: false } as any) }
    catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to restore charge') }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-gray-800">
          {coachName || coachEmail || 'Coach'} — Lifetime Statement
        </h3>
        <p className="text-sm text-gray-500">{coachEmail}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Booked (Month)</div>
          <div className="text-2xl font-bold text-gray-900">${ledger.monthBooked.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Paid (Month)</div>
          <div className="text-2xl font-bold text-gray-900">${ledger.monthPaid.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="text-xs uppercase font-semibold text-gray-500 mb-1">Lifetime Booked</div>
          <div className="text-2xl font-bold text-gray-900">${ledger.totalBooked.toFixed(2)}</div>
        </div>
        <div className={`border rounded-xl p-5 ${ledger.balance > 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <div className="text-xs uppercase font-semibold text-gray-600 mb-1">Outstanding</div>
          <div className={`text-2xl font-bold ${ledger.balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
            ${ledger.balance.toFixed(2)}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            ${ledger.totalBooked.toFixed(2)}
            {ledger.totalAdjust !== 0 && (
              <> {ledger.totalAdjust >= 0 ? '+' : '−'} ${Math.abs(ledger.totalAdjust).toFixed(2)} adj</>
            )}
            {' '}− ${ledger.totalPaid.toFixed(2)}
          </div>
        </div>
      </div>

      {editable && (
        <AddAdjustmentForm
          today={todayStr}
          busy={busy}
          onAdd={async (delta, label, note, date) => {
            setBusy(true)
            try {
              await addAdjustment({ subjectType: 'coach', subjectId: coachId, delta, label, note, date } as any)
            } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to add adjustment') }
            finally { setBusy(false) }
          }}
        />
      )}

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <h4 className="font-semibold text-gray-800">Activity Ledger</h4>
          <span className="text-xs text-gray-500">
            {ledger.pastCount} entries{ledger.futureCount > 0 ? ` + ${ledger.futureCount} upcoming` : ''}
          </span>
        </div>
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : ledger.displayRows.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No activity yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold">Date</th>
                  <th className="text-left px-5 py-2 font-semibold">Type</th>
                  <th className="text-left px-5 py-2 font-semibold">Description</th>
                  <th className="text-right px-5 py-2 font-semibold">Charge</th>
                  <th className="text-right px-5 py-2 font-semibold">Payment</th>
                  <th className="text-right px-5 py-2 font-semibold">Balance</th>
                  {editable && <th className="px-5 py-2" />}
                </tr>
              </thead>
              <tbody>
                {ledger.displayRows.map((r, i) => (
                  <LedgerTableRow
                    key={(r.raw?._id ?? i) + ':' + r.kind}
                    r={r}
                    editable={editable}
                    busy={busy}
                    isEditing={editKey === (r.raw?._id ?? '')}
                    onEdit={() => setEditKey(r.raw?._id ?? null)}
                    onCancelEdit={() => setEditKey(null)}
                    onSavePayment={savePaymentEdit}
                    onDeletePayment={removePayment}
                    onSaveAdjust={saveAdjustEdit}
                    onDeleteAdjust={removeAdjust}
                    onSaveCharge={saveChargeEdit}
                    onRemoveBooking={removeBooking}
                    onRestoreBooking={restoreBooking}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Add-adjustment form (admin) ────────────────────────────────────────────
function AddAdjustmentForm({
  today, busy, onAdd,
}: {
  today: string
  busy: boolean
  onAdd: (delta: number, label: string, note: string, date: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [sign, setSign] = useState<'charge' | 'credit' | 'note'>('charge')
  const [amount, setAmount] = useState('')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(today)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim()) { alert('Enter a label'); return }
    let delta = 0
    if (sign !== 'note') {
      const amt = parseFloat(amount)
      if (!amt || amt <= 0) { alert('Enter a valid amount'); return }
      delta = sign === 'charge' ? amt : -amt
    }
    await onAdd(delta, label.trim(), note.trim(), date)
    setAmount(''); setLabel(''); setNote(''); setSign('charge'); setDate(today); setOpen(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-semibold text-emerald-600 hover:underline">
        + Add adjustment line
      </button>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-gray-800">Add Adjustment Line</h3>
          <p className="text-sm text-gray-500 mt-0.5">A charge owed, a credit/discount, or a note on this statement</p>
        </div>
        <button onClick={() => setOpen(false)} className="text-sm text-gray-400 hover:text-gray-600">Cancel</button>
      </div>
      <form onSubmit={submit} className="p-6 grid grid-cols-1 sm:grid-cols-5 gap-3">
        <select value={sign} onChange={e => setSign(e.target.value as any)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
          <option value="charge">Charge (+)</option>
          <option value="credit">Credit (−)</option>
          <option value="note">Note (no $)</option>
        </select>
        <input type="number" step="0.01" min="0" placeholder="Amount ($)" value={amount} disabled={sign === 'note'} onChange={e => setAmount(e.target.value)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:bg-gray-100" />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        <input required placeholder="Label" value={label} onChange={e => setLabel(e.target.value)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        <input placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        <button disabled={busy} className="sm:col-span-5 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors">
          {busy ? 'Saving…' : 'Add Line'}
        </button>
      </form>
    </div>
  )
}

// ── One ledger row (with optional inline editor) ───────────────────────────
function LedgerTableRow({
  r, editable, busy, isEditing, onEdit, onCancelEdit,
  onSavePayment, onDeletePayment, onSaveAdjust, onDeleteAdjust,
  onSaveCharge, onRemoveBooking, onRestoreBooking,
}: {
  r: LedgerRow
  editable: boolean
  busy: boolean
  isEditing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSavePayment: (id: string, amount: number, dateReceived: string, method: string, description: string) => Promise<void>
  onDeletePayment: (id: string) => Promise<void>
  onSaveAdjust: (id: string, delta: number, label: string, note: string, date: string) => Promise<void>
  onDeleteAdjust: (id: string) => Promise<void>
  onSaveCharge: (bookingId: string, coachPrice: number) => Promise<void>
  onRemoveBooking: (bookingId: string) => Promise<void>
  onRestoreBooking: (bookingId: string) => Promise<void>
}) {
  const isFuture = r.future === true
  const isExcluded = r.excluded === true
  // Booking charge lines are editable too (change the $) and removable (reversible).
  const canEdit = editable && (r.kind === 'payment' || r.kind === 'adjustment' || r.kind === 'booking')

  if (isEditing && r.kind === 'payment') {
    return <PaymentEditRow r={r} busy={busy} onCancel={onCancelEdit} onSave={onSavePayment} />
  }
  if (isEditing && r.kind === 'adjustment') {
    return <AdjustmentEditRow r={r} busy={busy} onCancel={onCancelEdit} onSave={onSaveAdjust} />
  }
  if (isEditing && r.kind === 'booking') {
    return <BookingChargeEditRow r={r} busy={busy} onCancel={onCancelEdit} onSave={onSaveCharge} />
  }

  const typeBadge =
    r.kind === 'payment' ? <span className="inline-flex px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">Payment</span>
    : r.kind === 'adjustment' ? <span className="inline-flex px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 text-xs font-medium">{r.isNote ? 'Note' : 'Adjustment'}</span>
    : isFuture ? <span className="inline-flex px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs font-medium">Upcoming</span>
    : <span className="inline-flex px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">Booking</span>

  const desc =
    r.kind === 'booking' ? `${r.lane} • ${r.label}`
    : r.kind === 'payment' ? `${r.label} (${r.method})`
    : r.raw?.note ? `${r.label} — ${r.raw.note}` : r.label

  const origCharge = Number(r.raw?.coachPrice || 0)
  return (
    <tr className={`border-t border-gray-100 ${isFuture ? 'opacity-50' : ''} ${isExcluded ? 'bg-gray-50' : ''}`}>
      <td className="px-5 py-3 text-gray-700 whitespace-nowrap">{r.date || '—'}</td>
      <td className="px-5 py-3">
        {typeBadge}
        {isExcluded && <span className="ml-2 inline-flex px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-xs font-medium">Removed</span>}
      </td>
      <td className={`px-5 py-3 ${isExcluded ? 'text-gray-400 line-through' : 'text-gray-700'}`}>{desc}</td>
      <td className="px-5 py-3 text-right text-gray-900">
        {isExcluded ? (origCharge > 0 ? <span className="text-gray-400 line-through">${origCharge.toFixed(2)}</span> : '')
          : r.charge > 0 ? `$${r.charge.toFixed(2)}` : ''}
      </td>
      <td className="px-5 py-3 text-right text-emerald-700">{r.payment > 0 ? `−$${r.payment.toFixed(2)}` : ''}</td>
      <td className={`px-5 py-3 text-right font-semibold ${isFuture ? 'text-gray-400' : r.balance > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
        {isFuture ? '—' : `$${r.balance.toFixed(2)}`}
      </td>
      {editable && (
        <td className="px-5 py-3 text-right whitespace-nowrap">
          {canEdit && (
            r.kind === 'booking' ? (
              isExcluded ? (
                <button disabled={busy} onClick={() => onRestoreBooking(r.raw._id)} className="text-xs text-blue-600 hover:underline disabled:opacity-50">Restore</button>
              ) : (
                <span className="inline-flex gap-3">
                  <button disabled={busy} onClick={onEdit} className="text-xs text-blue-600 hover:underline disabled:opacity-50">Edit</button>
                  <button disabled={busy} onClick={() => onRemoveBooking(r.raw._id)} className="text-xs text-red-600 hover:underline disabled:opacity-50">Remove</button>
                </span>
              )
            ) : (
              <span className="inline-flex gap-3">
                <button disabled={busy} onClick={onEdit} className="text-xs text-blue-600 hover:underline disabled:opacity-50">Edit</button>
                <button disabled={busy} onClick={() => r.kind === 'payment' ? onDeletePayment(r.raw._id) : onDeleteAdjust(r.raw._id)} className="text-xs text-red-600 hover:underline disabled:opacity-50">Delete</button>
              </span>
            )
          )}
        </td>
      )}
    </tr>
  )
}

function PaymentEditRow({
  r, busy, onCancel, onSave,
}: {
  r: LedgerRow
  busy: boolean
  onCancel: () => void
  onSave: (id: string, amount: number, dateReceived: string, method: string, description: string) => Promise<void>
}) {
  const [amount, setAmount] = useState(String(r.raw.amount ?? ''))
  const [date, setDate] = useState(r.raw.dateReceived ?? '')
  const [method, setMethod] = useState(r.raw.method ?? 'bank_transfer')
  const [description, setDescription] = useState(r.raw.description ?? r.raw.note ?? '')
  return (
    <tr className="border-t border-gray-100 bg-blue-50/40">
      <td className="px-5 py-2"><input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-2 py-1 border border-gray-200 rounded text-xs w-full" /></td>
      <td className="px-5 py-2">
        <select value={method} onChange={e => setMethod(e.target.value)} className="px-2 py-1 border border-gray-200 rounded text-xs bg-white">
          <option value="bank_transfer">Bank Transfer</option>
          <option value="cash">Cash</option>
          <option value="stripe">Stripe</option>
          <option value="other">Other</option>
        </select>
      </td>
      <td className="px-5 py-2"><input value={description} onChange={e => setDescription(e.target.value)} placeholder="Notes" className="px-2 py-1 border border-gray-200 rounded text-xs w-full" /></td>
      <td className="px-5 py-2" />
      <td className="px-5 py-2 text-right"><input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} className="px-2 py-1 border border-gray-200 rounded text-xs w-24 text-right" /></td>
      <td className="px-5 py-2" />
      <td className="px-5 py-2 text-right whitespace-nowrap">
        <span className="inline-flex gap-3">
          <button disabled={busy} onClick={() => { const amt = parseFloat(amount); if (!amt || amt <= 0) { alert('Enter a valid amount'); return } onSave(r.raw._id, amt, date, method, description) }} className="text-xs text-emerald-600 font-semibold hover:underline disabled:opacity-50">Save</button>
          <button disabled={busy} onClick={onCancel} className="text-xs text-gray-500 hover:underline disabled:opacity-50">Cancel</button>
        </span>
      </td>
    </tr>
  )
}

function AdjustmentEditRow({
  r, busy, onCancel, onSave,
}: {
  r: LedgerRow
  busy: boolean
  onCancel: () => void
  onSave: (id: string, delta: number, label: string, note: string, date: string) => Promise<void>
}) {
  const initSign = (r.raw.delta ?? 0) > 0 ? 'charge' : (r.raw.delta ?? 0) < 0 ? 'credit' : 'note'
  const [sign, setSign] = useState<'charge' | 'credit' | 'note'>(initSign)
  const [amount, setAmount] = useState(String(Math.abs(r.raw.delta ?? 0) || ''))
  const [label, setLabel] = useState(r.raw.label ?? '')
  const [note, setNote] = useState(r.raw.note ?? '')
  const [date, setDate] = useState(r.raw.date ?? '')
  return (
    <tr className="border-t border-gray-100 bg-purple-50/40">
      <td className="px-5 py-2"><input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-2 py-1 border border-gray-200 rounded text-xs w-full" /></td>
      <td className="px-5 py-2">
        <select value={sign} onChange={e => setSign(e.target.value as any)} className="px-2 py-1 border border-gray-200 rounded text-xs bg-white">
          <option value="charge">Charge (+)</option>
          <option value="credit">Credit (−)</option>
          <option value="note">Note</option>
        </select>
      </td>
      <td className="px-5 py-2">
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label" className="px-2 py-1 border border-gray-200 rounded text-xs w-full mb-1" />
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)" className="px-2 py-1 border border-gray-200 rounded text-xs w-full" />
      </td>
      <td className="px-5 py-2" />
      <td className="px-5 py-2 text-right"><input type="number" step="0.01" min="0" value={amount} disabled={sign === 'note'} onChange={e => setAmount(e.target.value)} className="px-2 py-1 border border-gray-200 rounded text-xs w-24 text-right disabled:bg-gray-100" /></td>
      <td className="px-5 py-2" />
      <td className="px-5 py-2 text-right whitespace-nowrap">
        <span className="inline-flex gap-3">
          <button disabled={busy} onClick={() => {
            if (!label.trim()) { alert('Enter a label'); return }
            let delta = 0
            if (sign !== 'note') { const amt = parseFloat(amount); if (!amt || amt <= 0) { alert('Enter a valid amount'); return } delta = sign === 'charge' ? amt : -amt }
            onSave(r.raw._id, delta, label.trim(), note.trim(), date)
          }} className="text-xs text-emerald-600 font-semibold hover:underline disabled:opacity-50">Save</button>
          <button disabled={busy} onClick={onCancel} className="text-xs text-gray-500 hover:underline disabled:opacity-50">Cancel</button>
        </span>
      </td>
    </tr>
  )
}

// SPEC_STATEMENTS_EDITING — inline editor for a coach BOOKING-charge line (admin
// changes the $ charged for that session). Date/description are read-only; 0 is
// a valid charge (waives the session while keeping the line).
function BookingChargeEditRow({
  r, busy, onCancel, onSave,
}: {
  r: LedgerRow
  busy: boolean
  onCancel: () => void
  onSave: (bookingId: string, coachPrice: number) => Promise<void>
}) {
  const [amount, setAmount] = useState(String(Number(r.raw?.coachPrice ?? 0) || ''))
  return (
    <tr className="border-t border-gray-100 bg-blue-50/40">
      <td className="px-5 py-2 text-gray-700 whitespace-nowrap text-xs">{r.date || '—'}</td>
      <td className="px-5 py-2"><span className="inline-flex px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">Booking</span></td>
      <td className="px-5 py-2 text-gray-600 text-xs">{r.lane} • {r.label}</td>
      <td className="px-5 py-2 text-right"><input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} className="px-2 py-1 border border-gray-200 rounded text-xs w-24 text-right" /></td>
      <td className="px-5 py-2" />
      <td className="px-5 py-2" />
      <td className="px-5 py-2 text-right whitespace-nowrap">
        <span className="inline-flex gap-3">
          <button disabled={busy} onClick={() => { const amt = parseFloat(amount); if (isNaN(amt) || amt < 0) { alert('Enter a valid charge ($0 or more)'); return } onSave(r.raw._id, amt) }} className="text-xs text-emerald-600 font-semibold hover:underline disabled:opacity-50">Save</button>
          <button disabled={busy} onClick={onCancel} className="text-xs text-gray-500 hover:underline disabled:opacity-50">Cancel</button>
        </span>
      </td>
    </tr>
  )
}
