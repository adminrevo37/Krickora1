import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'

// SPEC_STATEMENTS_EDITING — compact admin manager for a subject's statement
// adjustment lines. Used in the customer EditUserModal (subjectType 'customer');
// coach adjustments are managed inline in CoachStatementTable instead.
type Props = {
  subjectType: 'coach' | 'customer'
  subjectId: string
}

function todayStr() {
  const n = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`
}

export default function StatementAdjustmentsManager({ subjectType, subjectId }: Props) {
  const adjustments = useQuery(
    (api as any).statements.listStatementAdjustments,
    subjectId ? ({ subjectType, subjectId } as any) : 'skip'
  ) as any[] | undefined
  const addAdjustment = useMutation((api as any).statements.addStatementAdjustment)
  const updateAdjustment = useMutation((api as any).statements.updateStatementAdjustment)
  const deleteAdjustment = useMutation((api as any).statements.deleteStatementAdjustment)

  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sign, setSign] = useState<'charge' | 'credit' | 'note'>('charge')
  const [amount, setAmount] = useState('')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(todayStr())

  const resetForm = () => { setEditId(null); setSign('charge'); setAmount(''); setLabel(''); setNote(''); setDate(todayStr()) }

  const startEdit = (a: any) => {
    setEditId(a._id)
    setSign((a.delta ?? 0) > 0 ? 'charge' : (a.delta ?? 0) < 0 ? 'credit' : 'note')
    setAmount(String(Math.abs(a.delta ?? 0) || ''))
    setLabel(a.label ?? '')
    setNote(a.note ?? '')
    setDate(a.date ?? todayStr())
    setOpen(true)
  }

  const submit = async () => {
    if (!label.trim()) { alert('Enter a label'); return }
    let delta = 0
    if (sign !== 'note') {
      const amt = parseFloat(amount)
      if (!amt || amt <= 0) { alert('Enter a valid amount'); return }
      delta = sign === 'charge' ? amt : -amt
    }
    setBusy(true)
    try {
      if (editId) {
        await updateAdjustment({ id: editId, delta, label: label.trim(), note: note.trim(), date } as any)
      } else {
        await addAdjustment({ subjectType, subjectId, delta, label: label.trim(), note: note.trim(), date } as any)
      }
      resetForm()
    } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to save adjustment') }
    finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this adjustment line? This cannot be undone.')) return
    setBusy(true)
    try { await deleteAdjustment({ id } as any) }
    catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to delete') }
    finally { setBusy(false) }
  }

  const list = adjustments ?? []

  return (
    <div className="bg-gray-50 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Statement adjustments</span>
        <button type="button" onClick={() => { resetForm(); setOpen(o => !o) }} className="text-xs font-semibold text-emerald-600 hover:underline">
          {open ? 'Close' : '+ Add line'}
        </button>
      </div>

      {list.length > 0 && (
        <div className="divide-y divide-gray-100">
          {[...list].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((a: any) => (
            <div key={a._id} className="py-1.5 flex items-center justify-between gap-2 text-xs">
              <span className="text-gray-600 truncate">
                <span className="text-gray-400">{a.date}</span> · {a.label}
                {a.note ? <span className="text-gray-400"> — {a.note}</span> : null}
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className={`font-semibold ${(a.delta ?? 0) > 0 ? 'text-amber-700' : (a.delta ?? 0) < 0 ? 'text-emerald-700' : 'text-gray-400'}`}>
                  {(a.delta ?? 0) === 0 ? 'note' : `${a.delta > 0 ? '+' : '−'}$${Math.abs(a.delta).toFixed(2)}`}
                </span>
                <button type="button" disabled={busy} onClick={() => startEdit(a)} className="text-blue-600 hover:underline disabled:opacity-50">Edit</button>
                <button type="button" disabled={busy} onClick={() => remove(a._id)} className="text-red-600 hover:underline disabled:opacity-50">Delete</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="space-y-2 border-t border-gray-100 pt-2">
          <div className="flex gap-2">
            <select value={sign} onChange={e => setSign(e.target.value as any)} className="px-2 py-2 border border-gray-200 rounded-lg text-sm bg-white">
              <option value="charge">Charge (+)</option>
              <option value="credit">Credit (−)</option>
              <option value="note">Note</option>
            </select>
            <input type="number" step="0.01" min="0" value={amount} disabled={sign === 'note'} onChange={e => setAmount(e.target.value)} placeholder="Amount" className="w-24 px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:bg-gray-100" />
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-2 py-2 border border-gray-200 rounded-lg text-sm" />
          </div>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={busy} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
              {busy ? 'Saving…' : editId ? 'Update line' : 'Add line'}
            </button>
            {editId && <button type="button" onClick={resetForm} className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancel edit</button>}
          </div>
        </div>
      )}
    </div>
  )
}
