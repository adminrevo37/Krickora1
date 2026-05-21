import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useAuth } from '../hooks/useAuth'
import AdminBookingCalendar from '../components/AdminBookingCalendar'
import ClosureManager from '../components/ClosureManager'
import SettingsPanel from '../components/SettingsPanel'
import CoachStatementTable from '../components/CoachStatementTable'
import AdminAnalyticsDashboard from '../components/AdminAnalyticsDashboard'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/admin')({
  component: AdminPage,
})

type Tab = 'bookings' | 'customers' | 'coaches' | 'statements' | 'closures' | 'hours' | 'pricing' | 'settings' | 'analytics'

function AdminPage() {
  const { isAdmin, isLoading } = useAuth()
  const [tab, setTab] = useState<Tab>('bookings')
  const [selectedDate] = useState(new Date())

  if (isLoading) {
    return <div className="max-w-7xl mx-auto px-4 py-16 text-center text-gray-500">Loading...</div>
  }

  if (!isAdmin) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Admin Access Required</h2>
        <p className="text-gray-500">You don&apos;t have permission to view this page.</p>
      </div>
    )
  }

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'bookings', label: 'Bookings', icon: '📅' },
    { id: 'customers', label: 'Customers', icon: '👥' },
    { id: 'coaches', label: 'Coaches', icon: '🏏' },
    { id: 'statements', label: 'Statements', icon: '💰' },
    { id: 'closures', label: 'Closures', icon: '🚫' },
    { id: 'hours', label: 'Opening Hours', icon: '🕒' },
    { id: 'pricing', label: 'Pricing', icon: '💲' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
    { id: 'analytics', label: 'Analytics', icon: '📊' },
  ]

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Admin Panel</h1>
        <p className="text-gray-500 mt-1">Manage bookings, customers, coaches, closures, and settings</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-gray-200 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-emerald-500 text-emerald-600'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            <span className="mr-1.5">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      <div className="space-y-6">
        {tab === 'bookings' && <AdminBookingCalendar />}
        {tab === 'customers' && <CustomersTab />}
        {tab === 'coaches' && <CoachesTab />}
        {tab === 'statements' && <StatementsTab />}
        {tab === 'closures' && <ClosureManager selectedDate={selectedDate} />}
        {tab === 'hours' && <SettingsPanel />}
        {tab === 'pricing' && <SettingsPanel />}
        {tab === 'settings' && <SettingsPanel />}
        {tab === 'analytics' && <AdminAnalyticsDashboard />}
      </div>
    </div>
  )
}

function StatementsTab() {
  const { user } = useAuth()
  const customers = useQuery(api.queries.listCustomers) ?? []
  const coaches = (customers as any[]).filter(c => c.role === 'coach')
  const [viewCoach, setViewCoach] = useState<any | null>(null)
  const allPayments = useQuery((api.queries as any).listPayments) ?? []
  const createPayment = useMutation((api.mutations as any).createPayment)
  const deletePayment = useMutation((api.mutations as any).deletePayment)
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({ coachId: '', amount: '', dateReceived: today, method: 'bank_transfer', description: '' })
  const [busy, setBusy] = useState(false)
  const [filterCoach, setFilterCoach] = useState<string>('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.coachId) { alert('Select a coach'); return }
    const amt = parseFloat(form.amount)
    if (!amt || amt <= 0) { alert('Enter a valid amount'); return }
    setBusy(true)
    try {
      await createPayment({
        coachId: form.coachId,
        amount: amt,
        dateReceived: form.dateReceived,
        method: form.method,
        description: form.description,
        note: form.description,
        createdBy: (user as any)?._id ?? (user as any)?.id ?? 'admin',
      } as any)
      setForm({ coachId: '', amount: '', dateReceived: today, method: 'bank_transfer', description: '' })
    } catch (err: any) { alert(err?.message ?? 'Failed') }
    finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this payment?')) return
    try { await deletePayment({ id } as any) } catch (err: any) { alert(err?.message ?? 'Failed') }
  }

  const coachName = (id: string) => {
    const c = (customers as any[]).find(x => x._id === id)
    return c?.name || c?.email || 'Unknown'
  }

  const list = (allPayments as any[])
    .filter(p => !filterCoach || p.coachId === filterCoach)
    .slice()
    .sort((a, b) => (b.dateReceived || '').localeCompare(a.dateReceived || ''))
  const total = list.reduce((s, p) => s + (p.amount || 0), 0)

  if (viewCoach) {
    return (
      <div className="space-y-4">
        <button onClick={() => setViewCoach(null)} className="text-sm text-emerald-600 hover:underline">← Back to all coaches</button>
        <CoachStatementTable coachId={viewCoach._id} coachEmail={viewCoach.email} coachName={viewCoach.name} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-800">Coach Statements</h3>
            <p className="text-sm text-gray-500 mt-1">Click a coach to view their lifetime statement.</p>
          </div>
          <span className="text-xs text-gray-500">{coaches.length} coaches</span>
        </div>
        {coaches.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">No coaches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold">Coach</th>
                  <th className="text-left px-5 py-2 font-semibold">Email</th>
                  <th className="text-left px-5 py-2 font-semibold">Tier</th>
                  <th className="px-5 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {coaches.map((c: any) => (
                  <tr key={c._id} className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => setViewCoach(c)}>
                    <td className="px-5 py-3 font-medium text-gray-900">{c.name || '—'}</td>
                    <td className="px-5 py-3 text-gray-600">{c.email}</td>
                    <td className="px-5 py-3 text-gray-600">{c.coachTier || '—'}</td>
                    <td className="px-5 py-3 text-right"><span className="text-emerald-600 text-xs font-semibold">View Statement →</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">Record Coach Payment</h3>
          <p className="text-sm text-gray-500 mt-1">Enter a payment received by a coach. Coaches can view their own statements.</p>
        </div>
        <form onSubmit={submit} className="p-6 grid grid-cols-1 sm:grid-cols-6 gap-3">
          <select required value={form.coachId} onChange={e => setForm({ ...form, coachId: e.target.value })} className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm">
            <option value="">Select coach…</option>
            {coaches.map((c: any) => (
              <option key={c._id} value={c._id}>{c.name || c.email}</option>
            ))}
          </select>
          <input required type="number" step="0.01" min="0" placeholder="Amount" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          <input required type="date" value={form.dateReceived} onChange={e => setForm({ ...form, dateReceived: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm">
            <option value="bank_transfer">Bank Transfer</option>
            <option value="cash">Cash</option>
            <option value="stripe">Stripe</option>
            <option value="other">Other</option>
          </select>
          <input placeholder="Description / notes" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} className="sm:col-span-6 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          <button disabled={busy} className="sm:col-span-6 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
            {busy ? 'Saving…' : 'Record Payment'}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-lg font-bold text-gray-800">Payment History ({list.length})</h3>
            <p className="text-sm text-gray-500">Total: <span className="font-semibold text-gray-800">${total.toFixed(2)}</span></p>
          </div>
          <select value={filterCoach} onChange={e => setFilterCoach(e.target.value)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm">
            <option value="">All coaches</option>
            {coaches.map((c: any) => (
              <option key={c._id} value={c._id}>{c.name || c.email}</option>
            ))}
          </select>
        </div>
        {list.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">No payments recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold">Date</th>
                  <th className="text-left px-5 py-2 font-semibold">Coach</th>
                  <th className="text-left px-5 py-2 font-semibold">Method</th>
                  <th className="text-left px-5 py-2 font-semibold">Description</th>
                  <th className="text-right px-5 py-2 font-semibold">Amount</th>
                  <th className="px-5 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {list.map((p: any) => (
                  <tr key={p._id} className="border-t border-gray-100">
                    <td className="px-5 py-3 text-gray-700">{p.dateReceived || '—'}</td>
                    <td className="px-5 py-3 text-gray-700">{coachName(p.coachId)}</td>
                    <td className="px-5 py-3 text-gray-600">{p.method || p.paymentMethod || '—'}</td>
                    <td className="px-5 py-3 text-gray-600">{p.description || p.note || '—'}</td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-900">${(p.amount || 0).toFixed(2)}</td>
                    <td className="px-5 py-3 text-right"><button onClick={() => remove(p._id)} className="text-xs text-red-600 hover:underline">Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function EditUserModal({ user, onClose, isCoach }: { user: any; onClose: () => void; isCoach?: boolean }) {
  const updateProfile = useMutation((api.users as any).adminUpdateUserProfile)
  const deleteUser = useMutation((api.users as any).adminDeleteUser)
  const [name, setName] = useState(user.name || '')
  const [phone, setPhone] = useState(user.phone || '')
  const [coachTier, setCoachTier] = useState(user.coachTier || 'L1')
  const [color, setColor] = useState(user.color || '')
  const [role, setRole] = useState(user.role || 'user')
  const [busy, setBusy] = useState(false)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const args: any = { email: user.email, name, phone, role }
      if (isCoach || role === 'coach') { args.coachTier = coachTier; args.color = color }
      await updateProfile(args)
      onClose()
    } catch (err: any) { alert(err?.message ?? 'Failed') }
    finally { setBusy(false) }
  }

  const remove = async () => {
    if (!confirm(`Delete ${user.email}? This cannot be undone.`)) return
    setBusy(true)
    try { await deleteUser({ email: user.email }); onClose() }
    catch (err: any) { alert(err?.message ?? 'Failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={e => e.stopPropagation()} onSubmit={save} className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">Edit {isCoach ? 'Coach' : 'User'}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <div className="text-xs text-gray-500">{user.email}</div>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Full name</span>
          <input value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Phone</span>
          <input value={phone} onChange={e => setPhone(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Role</span>
          <select value={role} onChange={e => setRole(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
            <option value="user">User</option>
            <option value="customer">Customer</option>
            <option value="coach">Coach</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        {(isCoach || role === 'coach') && (
          <>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Coach level</span>
              <select value={coachTier} onChange={e => setCoachTier(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                <option value="L1">L1</option>
                <option value="L2">L2</option>
                <option value="Bowling">Bowling</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Calendar color</span>
              <div className="flex gap-2 items-center mt-1">
                <input type="color" value={color || '#10b981'} onChange={e => setColor(e.target.value)} className="h-10 w-14 border border-gray-200 rounded-lg" />
                <input value={color} onChange={e => setColor(e.target.value)} placeholder="#10b981" className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
            </label>
          </>
        )}
        <div className="flex items-center justify-between gap-2 pt-2">
          <button type="button" onClick={remove} disabled={busy} className="text-sm text-red-600 hover:underline disabled:opacity-50">Delete user</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
            <button disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </form>
    </div>
  )
}

function CustomersTab() {
  const customers = useQuery(api.queries.listCustomers) ?? []
  const list = (customers as any[]).filter(c => c.role !== 'admin' && c.role !== 'coach')
  const [editing, setEditing] = useState<any | null>(null)
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-lg font-bold text-gray-800">Customers ({list.length})</h3>
      </div>
      <div className="divide-y divide-gray-100">
        {list.length === 0 && <div className="p-6 text-sm text-gray-500">No customers yet.</div>}
        {list.map((c: any) => (
          <div key={c._id} className="px-6 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium text-gray-900 truncate">{c.name || c.email}</div>
              <div className="text-sm text-gray-500 truncate">{c.email}{c.phone ? ` · ${c.phone}` : ''}</div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {c.creditBalance ? (
                <div className="text-sm text-emerald-600 font-semibold">${c.creditBalance.toFixed(2)} credit</div>
              ) : null}
              <button onClick={() => setEditing(c)} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 font-medium">Edit</button>
            </div>
          </div>
        ))}
      </div>
      {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function CoachesTab() {
  const { user } = useAuth()
  const customers = useQuery(api.queries.listCustomers) ?? []
  const coaches = (customers as any[]).filter(c => c.role === 'coach')
  const [editingCoach, setEditingCoach] = useState<any | null>(null)
  const invites = useQuery(api.queries.listCoachInvites) ?? []
  const createInvite = useMutation(api.mutations.createCoachInvite)
  const createCoach = useMutation((api.mutations as any).createCoach)
  const setPassword = useAction((api as any).adminPassword.adminSetPassword)
  const [form, setForm] = useState({ name: '', email: '', phone: '' })
  const [coachForm, setCoachForm] = useState({ name: '', email: '', phone: '', coachTier: 'L1', password: '' })
  const [busy, setBusy] = useState(false)
  const [busyAdd, setBusyAdd] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createInvite) { alert('Coach invites not available'); return }
    setBusy(true)
    try {
      const token = (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)
      await createInvite({ token, name: form.name.trim(), email: form.email.toLowerCase().trim(), phone: form.phone, createdBy: (user as any)?._id ?? (user as any)?.id ?? 'admin' })
      setForm({ name: '', email: '', phone: '' })
    } catch (err: any) { alert(err?.message ?? 'Failed') }
    finally { setBusy(false) }
  }

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createCoach) { alert('Add coach not available'); return }
    setBusyAdd(true)
    try {
      const email = coachForm.email.toLowerCase().trim()
      if (!coachForm.password || coachForm.password.length < 8) {
        alert('Password must be at least 8 characters')
        setBusyAdd(false)
        return
      }
      await createCoach({ name: coachForm.name.trim(), email, phone: coachForm.phone, coachTier: coachForm.coachTier })
      try {
        await setPassword({ email, password: coachForm.password })
      } catch (err: any) {
        alert('Coach created, but failed to set password: ' + (err?.message ?? 'unknown'))
      }
      setCoachForm({ name: '', email: '', phone: '', coachTier: 'L1', password: '' })
    } catch (err: any) { alert(err?.message ?? 'Failed') }
    finally { setBusyAdd(false) }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">Active Coaches ({coaches.length})</h3>
        </div>
        {coaches.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">No coaches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold">Name</th>
                  <th className="text-left px-5 py-2 font-semibold">Email</th>
                  <th className="text-left px-5 py-2 font-semibold">Phone</th>
                  <th className="text-left px-5 py-2 font-semibold">Tier</th>
                  <th className="px-5 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {coaches.map((c: any) => (
                  <tr key={c._id} className="border-t border-gray-100">
                    <td className="px-5 py-3 font-medium text-gray-900">{c.name || '—'}</td>
                    <td className="px-5 py-3 text-gray-600">{c.email}</td>
                    <td className="px-5 py-3 text-gray-600">{c.phone || '—'}</td>
                    <td className="px-5 py-3 text-gray-600"><span className="inline-flex items-center gap-2">{c.color && <span className="w-3 h-3 rounded-full border border-gray-200" style={{ background: c.color }} />}{c.coachTier || '—'}</span></td>
                    <td className="px-5 py-3 text-right"><button onClick={() => setEditingCoach(c)} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 font-medium">Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingCoach && <EditUserModal user={editingCoach} onClose={() => setEditingCoach(null)} isCoach />}

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">Add New Coach</h3>
          <p className="text-sm text-gray-500 mt-1">Manually create a coach account immediately (no invite email).</p>
        </div>
        <form onSubmit={submitAdd} className="p-6 grid grid-cols-1 sm:grid-cols-6 gap-3">
          <input required placeholder="Full name" value={coachForm.name} onChange={e => setCoachForm({ ...coachForm, name: e.target.value })} className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          <input required type="email" placeholder="Email" value={coachForm.email} onChange={e => setCoachForm({ ...coachForm, email: e.target.value })} className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          <input placeholder="Phone" value={coachForm.phone} onChange={e => setCoachForm({ ...coachForm, phone: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          <select value={coachForm.coachTier} onChange={e => setCoachForm({ ...coachForm, coachTier: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm">
            <option value="L1">L1</option>
            <option value="L2">L2</option>
            <option value="Bowling">Bowling</option>
          </select>
          <input required type="text" placeholder="Password (min 8)" value={coachForm.password} onChange={e => setCoachForm({ ...coachForm, password: e.target.value })} minLength={8} className="sm:col-span-6 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          <button disabled={busyAdd} className="sm:col-span-6 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
            {busyAdd ? 'Adding…' : 'Add Coach'}
          </button>
        </form>
      </div>

      {(
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-lg font-bold text-gray-800">Invite New Coach</h3>
          </div>
          <form onSubmit={submit} className="p-6 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <input required placeholder="Full name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <input required type="email" placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <input placeholder="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <button disabled={busy} className="sm:col-span-4 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
              {busy ? 'Creating…' : 'Create Invite'}
            </button>
          </form>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">Pending Invites ({(invites as any[]).filter(i => !i.used).length})</h3>
        </div>
        <div className="divide-y divide-gray-100">
          {(invites as any[]).length === 0 && <div className="p-6 text-sm text-gray-500">No invites yet.</div>}
          {(invites as any[]).map((inv: any) => (
            <div key={inv._id} className="px-6 py-3 flex items-center justify-between">
              <div>
                <div className="font-medium text-gray-900">{inv.name}</div>
                <div className="text-sm text-gray-500">{inv.email}</div>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full font-semibold ${inv.used ? 'bg-gray-100 text-gray-500' : 'bg-amber-100 text-amber-700'}`}>
                {inv.used ? 'Used' : 'Pending'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
