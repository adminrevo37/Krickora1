import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'

type DiscountDoc = {
  _id: string
  code: string
  discount: number
  discountType?: string  // 'percent' | 'fixed' | 'free' — absent = 'percent'
  amountOff?: number
  label: string
  bypassStripe?: boolean  // optional — old docs may not have this field
  active: boolean
  expiresAt?: string
  usageLimit?: number
  perCustomerLimit?: number
  usedCount?: number  // optional — old docs may not have this field
  createdAt: string
}

const EMPTY_FORM = {
  code: '',
  discountType: 'percent',
  discount: 100,
  amountOff: '',
  label: '',
  bypassStripe: false,
  active: true,
  expiresAt: '',
  usageLimit: '',
  perCustomerLimit: '',
}

export default function AdminDiscountCodesTab() {
  const codes = (useQuery(api.queries.listDiscountCodes) ?? []) as DiscountDoc[]
  const createMut = useMutation(api.mutations.createDiscountCode)
  const updateMut = useMutation(api.mutations.updateDiscountCode)
  const deleteMut = useMutation(api.mutations.deleteDiscountCode)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resetForm = () => {
    setForm({ ...EMPTY_FORM })
    setEditingId(null)
    setShowForm(false)
    setError(null)
  }

  const startEdit = (doc: DiscountDoc) => {
    setForm({
      code: doc.code,
      discountType: doc.discountType ?? 'percent',
      discount: doc.discount,
      amountOff: doc.amountOff !== undefined ? String(doc.amountOff) : '',
      label: doc.label,
      bypassStripe: doc.bypassStripe ?? false,
      active: doc.active,
      expiresAt: doc.expiresAt ?? '',
      usageLimit: doc.usageLimit !== undefined ? String(doc.usageLimit) : '',
      perCustomerLimit: doc.perCustomerLimit !== undefined ? String(doc.perCustomerLimit) : '',
    })
    setEditingId(doc._id)
    setShowForm(true)
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const isFree = form.discountType === 'free'
      const isFixed = form.discountType === 'fixed'
      const payload = {
        discountType: form.discountType,
        discount: isFree ? 100 : Number(form.discount),
        amountOff: isFixed && form.amountOff !== '' ? Number(form.amountOff) : undefined,
        label: form.label.trim(),
        bypassStripe: isFree ? true : form.bypassStripe,
        active: form.active,
        expiresAt: form.expiresAt || undefined,
        usageLimit: form.usageLimit !== '' ? Number(form.usageLimit) : undefined,
        perCustomerLimit: form.perCustomerLimit !== '' ? Number(form.perCustomerLimit) : undefined,
      }
      if (editingId) {
        await updateMut({ id: editingId as any, ...payload })
      } else {
        await createMut({ code: form.code.trim(), ...payload })
      }
      resetForm()
    } catch (err: any) {
      setError(getErrorMessage(err) ?? 'Failed to save discount code.')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (doc: DiscountDoc) => {
    if (!confirm(`Delete discount code "${doc.code}"? This cannot be undone.`)) return
    setBusy(true)
    try {
      await deleteMut({ id: doc._id as any })
    } catch (err: any) {
      setError(getErrorMessage(err) ?? 'Failed to delete discount code.')
    } finally {
      setBusy(false)
    }
  }

  const handleToggleActive = async (doc: DiscountDoc) => {
    try {
      await updateMut({ id: doc._id as any, active: !doc.active })
    } catch (err: any) {
      setError(getErrorMessage(err) ?? 'Failed to update code.')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Discount Codes</h2>
          <p className="text-sm text-gray-500 mt-0.5">Create and manage promotional discount codes for customer bookings</p>
        </div>
        {!showForm && (
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            + New Code
          </button>
        )}
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-emerald-50">
            <h3 className="text-base font-bold text-gray-800">
              {editingId ? '✏️ Edit Discount Code' : '➕ New Discount Code'}
            </h3>
          </div>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Code <span className="text-gray-400 font-normal">(lowercase, no spaces)</span></span>
                <input
                  required
                  disabled={!!editingId}
                  value={form.code}
                  onChange={e => setForm(f => ({ ...f, code: e.target.value.toLowerCase().replace(/\s/g, '') }))}
                  placeholder="e.g. julian"
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:bg-gray-50 disabled:text-gray-400"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Label <span className="text-gray-400 font-normal">(shown to customer)</span></span>
                <input
                  required
                  value={form.label}
                  onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                  placeholder="e.g. 100% Off — Complimentary"
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Type</span>
                <select
                  value={form.discountType}
                  onChange={e => setForm(f => ({ ...f, discountType: e.target.value }))}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                >
                  <option value="percent">Percent off (%)</option>
                  <option value="fixed">Fixed amount off ($)</option>
                  <option value="free">100% free (skip payment)</option>
                </select>
              </label>
              {form.discountType === 'percent' && (
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Discount (%)</span>
                  <input
                    required
                    type="number"
                    min={1}
                    max={100}
                    value={form.discount}
                    onChange={e => setForm(f => ({ ...f, discount: Number(e.target.value) }))}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                </label>
              )}
              {form.discountType === 'fixed' && (
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Amount off ($)</span>
                  <input
                    required
                    type="number"
                    min={1}
                    step="0.01"
                    value={form.amountOff}
                    onChange={e => setForm(f => ({ ...f, amountOff: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                </label>
              )}
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Expires on <span className="text-gray-400 font-normal">(optional)</span></span>
                <input
                  type="date"
                  value={form.expiresAt}
                  onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Total usage limit <span className="text-gray-400 font-normal">(optional — blank = unlimited)</span></span>
                <input
                  type="number"
                  min={1}
                  value={form.usageLimit}
                  onChange={e => setForm(f => ({ ...f, usageLimit: e.target.value }))}
                  placeholder="Unlimited"
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Per-customer limit <span className="text-gray-400 font-normal">(optional — blank = unlimited)</span></span>
                <input
                  type="number"
                  min={1}
                  value={form.perCustomerLimit}
                  onChange={e => setForm(f => ({ ...f, perCustomerLimit: e.target.value }))}
                  placeholder="Unlimited"
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <div className="flex flex-col gap-3 pt-1">
                {form.discountType !== 'free' && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.bypassStripe}
                      onChange={e => setForm(f => ({ ...f, bypassStripe: e.target.checked }))}
                      className="w-4 h-4 accent-emerald-500"
                    />
                    <span className="text-sm font-medium text-gray-700">Skip Stripe payment</span>
                  </label>
                )}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={e => setForm(f => ({ ...f, active: e.target.checked }))}
                    className="w-4 h-4 accent-emerald-500"
                  />
                  <span className="text-sm font-medium text-gray-700">Active</span>
                </label>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={resetForm}
                disabled={busy}
                className="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex-1 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
              >
                {busy ? 'Saving...' : editingId ? '💾 Save Changes' : '➕ Create Code'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Codes table */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {codes.length === 0 ? (
          <div className="p-12 text-center">
            <div className="text-4xl mb-3">🏷️</div>
            <p className="text-gray-500">No discount codes yet. Create one above.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Discount</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Label</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Usage</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Expires</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {codes.map(doc => (
                  <tr key={doc._id} className={`hover:bg-gray-50 transition-colors ${!doc.active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <code className="bg-gray-100 px-2 py-0.5 rounded text-xs font-mono font-bold text-gray-800">{doc.code}</code>
                      {doc.bypassStripe && (
                        <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-semibold">FREE</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-semibold text-emerald-600">
                      {doc.discountType === 'fixed'
                        ? `$${doc.amountOff ?? 0}`
                        : doc.discountType === 'free'
                          ? 'Free'
                          : `${doc.discount}%`}
                    </td>
                    <td className="px-4 py-3 text-gray-700 max-w-[200px] truncate">{doc.label}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {doc.usedCount ?? 0}
                      {doc.usageLimit !== undefined && <span className="text-gray-400"> / {doc.usageLimit}</span>}
                      {doc.perCustomerLimit !== undefined && (
                        <span className="block text-[10px] text-gray-400">max {doc.perCustomerLimit}/customer</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{doc.expiresAt ?? <span className="text-gray-400">Never</span>}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggleActive(doc)}
                        className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors ${
                          doc.active
                            ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                      >
                        {doc.active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => startEdit(doc)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(doc)}
                          disabled={busy}
                          className="text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {error && !showForm && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}
    </div>
  )
}
