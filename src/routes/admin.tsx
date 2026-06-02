import React, { useState } from 'react'
import { createFileRoute, useNavigate, Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useAuth } from '../hooks/useAuth'
import { getAWSTNow } from '../lib/booking-data'
import { getErrorMessage } from '../lib/errors'
import { sendPasswordReset } from '../lib/auth-client'
import { useImpersonation } from '../hooks/useImpersonation'
import AdminBookingCalendar from '../components/AdminBookingCalendar'
import ClosureManager from '../components/ClosureManager'
import SettingsPanel from '../components/SettingsPanel'
import CoachStatementTable from '../components/CoachStatementTable'
import StatementAdjustmentsManager from '../components/StatementAdjustmentsManager'
import AdminDiscountCodesTab from '../components/AdminDiscountCodesTab'
import AdminFaultInbox from '../components/AdminFaultInbox'
import WaitlistAdmin from '../components/WaitlistAdmin'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'

// ---------------------------------------------------------------------------
// Route — section tracked in URL search params for bookmarkable navigation
// ---------------------------------------------------------------------------

type Section =
  | 'bookings' | 'closures'
  | 'customers' | 'coaches'
  | 'statements' | 'discounts'
  | 'faults' | 'waitlist' | 'settings'

const VALID_SECTIONS: Section[] = [
  'bookings', 'closures', 'customers', 'coaches',
  'statements', 'discounts', 'faults', 'waitlist', 'settings',
]

export const Route = createFileRoute('/admin')({
  component: AdminPage,
  validateSearch: (search: Record<string, unknown>) => ({
    section: (VALID_SECTIONS.includes(search.section as Section)
      ? search.section
      : 'bookings') as Section,
  }),
})

// ---------------------------------------------------------------------------
// Sidebar navigation definition
// ---------------------------------------------------------------------------

const NAV_GROUPS: Array<{
  label: string
  items: Array<{ id: Section; label: string; icon: string; href?: string }>
}> = [
  {
    label: 'Operations',
    items: [
      { id: 'bookings',   label: 'Bookings',   icon: '📅' },
      { id: 'closures',   label: 'Closures',   icon: '🚫' },
    ],
  },
  {
    label: 'People',
    items: [
      { id: 'customers',  label: 'Customers',  icon: '👥' },
      { id: 'coaches',    label: 'Coaches',    icon: '🏏' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { id: 'statements', label: 'Statements', icon: '💰' },
      { id: 'discounts',  label: 'Discounts',  icon: '🏷️' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { id: 'faults',     label: 'Fault Reports', icon: '🛠️' },
      { id: 'waitlist',   label: 'Waitlist',      icon: '🎟️' },
    ],
  },
  {
    label: 'Configure',
    items: [
      { id: 'settings',   label: 'Settings',   icon: '⚙️' },
    ],
  },
]

const SECTION_TITLES: Record<Section, string> = {
  bookings:   'Bookings',
  closures:   'Closures',
  customers:  'Customers',
  coaches:    'Coaches',
  statements: 'Statements',
  discounts:  'Discounts',
  faults:     'Fault Reports',
  waitlist:   'Waitlist',
  settings:   'Settings',
}

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

function Sidebar({
  active,
  onSelect,
  onClose,
}: {
  active: Section
  onSelect: (s: Section) => void
  onClose?: () => void
}) {
  return (
    <nav className="flex flex-col h-full">
      {/* Brand / title */}
      <div className="px-4 py-5 border-b border-gray-100">
        <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Admin Panel</p>
      </div>

      {/* Nav groups */}
      <div className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
        {NAV_GROUPS.map(group => (
          <div key={group.label}>
            <p className="px-2 mb-1 text-[10px] font-bold uppercase tracking-widest text-gray-400">
              {group.label}
            </p>
            {group.items.map(item => {
              const isActive = active === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => { onSelect(item.id); onClose?.() }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  <span className="text-base leading-none">{item.icon}</span>
                  <span>{item.label}</span>
                  {isActive && (
                    <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Analytics — own page */}
      <div className="px-2 pb-4 border-t border-gray-100 pt-3">
        <Link
          to="/admin/analytics"
          onClick={onClose}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
        >
          <span className="text-base leading-none">📊</span>
          <span>Analytics</span>
          <svg className="ml-auto w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </Link>
      </div>
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function AdminPage() {
  const { isAdmin, isLoading } = useAuth()
  const { section } = Route.useSearch()
  const navigate = useNavigate()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  // Admin second-factor gate (SPEC_SECURITY_HARDENING #2). Inert unless
  // adminGateEnabled is set in settings. expiresAt comes from the server; the
  // client decides if the unlock is still valid (queries can't read the clock).
  const gate = useQuery((api as any).adminGate.getAdminGateStatus)
  const [localUnlocked, setLocalUnlocked] = useState(false)
  // BUG-6: Detect child routes (e.g. /admin/analytics) to render <Outlet /> instead of section panels
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isChildRoute = pathname.startsWith('/admin/') && pathname.length > '/admin/'.length

  const setSection = (s: Section) => {
    navigate({ to: '/admin', search: { section: s }, replace: true })
    setMobileSidebarOpen(false)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400 text-sm">
        Loading…
      </div>
    )
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

  // Second-factor gate: when enabled and not unlocked, require the admin to
  // re-enter their own password before showing the panel.
  const gateLocked =
    gate?.enabled === true &&
    !localUnlocked &&
    !(gate?.expiresAt && Date.now() < gate.expiresAt)
  if (gateLocked) {
    return <AdminUnlock onUnlocked={() => setLocalUnlocked(true)} />
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] bg-gray-50">

      {/* ── Mobile overlay backdrop ── */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* ── Mobile slide-in sidebar ── */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-white border-r border-gray-200 pt-16 shadow-xl transition-transform duration-200 md:hidden ${
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar active={section} onSelect={setSection} onClose={() => setMobileSidebarOpen(false)} />
      </aside>

      {/* ── Desktop sidebar (sticky) ── */}
      <aside className="hidden md:flex md:flex-col w-52 shrink-0 sticky top-16 h-[calc(100vh-4rem)] bg-white border-r border-gray-200 overflow-y-auto">
        <Sidebar active={section} onSelect={setSection} />
      </aside>

      {/* ── Content area ── */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 md:hidden">
          <button
            onClick={() => setMobileSidebarOpen(true)}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600"
            aria-label="Open menu"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="text-base font-semibold text-gray-800">{isChildRoute ? 'Analytics' : SECTION_TITLES[section]}</h1>
        </div>

        {/* Section content — child routes (e.g. /admin/analytics) render via <Outlet /> */}
        {isChildRoute ? (
          <Outlet />
        ) : (
          <div className="p-6 space-y-6">
            {section === 'bookings'   && <AdminBookingCalendar />}
            {section === 'closures'   && <ClosuresTab />}
            {section === 'customers'  && <CustomersTab />}
            {section === 'coaches'    && <CoachesTab />}
            {section === 'statements' && <StatementsTab />}
            {section === 'discounts'  && <AdminDiscountCodesTab />}
            {section === 'faults'     && <AdminFaultInbox />}
            {section === 'waitlist'   && <WaitlistAdmin />}
            {section === 'settings'   && <SettingsPanel />}
          </div>
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Closures tab — date picker + closure manager for the chosen date
// ---------------------------------------------------------------------------

function ClosuresTab() {
  const todayKey = new Date().toISOString().slice(0, 10)
  const [dateKey, setDateKey] = useState(todayKey)
  // Parse YYYY-MM-DD as a local date (avoid UTC shift from new Date(str))
  const [y, m, d] = dateKey.split('-').map(Number)
  const selectedDate = new Date(y, m - 1, d)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="text-xs font-semibold text-gray-600 dark:text-gray-400">Date</label>
        <input
          type="date"
          value={dateKey}
          min={todayKey}
          onChange={(e) => setDateKey(e.target.value)}
          className="px-3 py-1.5 text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg outline-none focus:ring-2 focus:ring-red-500"
        />
        <button
          onClick={() => setDateKey(todayKey)}
          className="text-[11px] px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 font-semibold hover:bg-gray-200"
        >
          Today
        </button>
      </div>
      <ClosureManager selectedDate={selectedDate} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Admin unlock prompt (second factor — re-enter own password)
// ---------------------------------------------------------------------------

function AdminUnlock({ onUnlocked }: { onUnlocked: () => void }) {
  const verify = useAction((api as any).adminGateActions.verifyAdminPassword)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pw) return
    setBusy(true); setErr(null)
    try {
      const res = await verify({ password: pw })
      if (res?.success) { setPw(''); onUnlocked() }
      else setErr(res?.error ?? 'Incorrect password')
    } catch (e: any) {
      setErr(getErrorMessage(e) ?? 'Verification failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-sm mx-auto px-4 py-16">
      <div className="text-center mb-6">
        <div className="text-5xl mb-4">🔐</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">Confirm it&apos;s you</h2>
        <p className="text-gray-500 text-sm">Re-enter your account password to access the admin panel.</p>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={pw}
          onChange={e => setPw(e.target.value)}
          placeholder="Your password"
          className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm"
        />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button
          disabled={busy || !pw}
          className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors"
        >
          {busy ? 'Checking…' : 'Unlock admin'}
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise legacy tier values ('Bowling' → 'L1', 'BowlingL2' → 'L2') */
function normaliseCoachTier(tier: string | undefined | null): 'L1' | 'L2' {
  if (tier === 'L2' || tier === 'BowlingL2') return 'L2'
  return 'L1'
}

// ---------------------------------------------------------------------------
// Statements tab
// ---------------------------------------------------------------------------

function StatementsTab() {
  const { user } = useAuth()
  const { impersonate } = useImpersonation()
  const navigate = useNavigate()
  const customers = useQuery(api.queries.listCustomers) ?? []
  const coaches = (customers as any[]).filter(c => c.role === 'coach')
  const [viewCoach, setViewCoach] = useState<any | null>(null)
  const createPayment = useMutation((api.mutations as any).createPayment)
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({ amount: '', dateReceived: today, method: 'bank_transfer', description: '' })
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!viewCoach) return
    const amt = parseFloat(form.amount)
    if (!amt || amt <= 0) { alert('Enter a valid amount'); return }
    setBusy(true)
    try {
      await createPayment({
        coachId: viewCoach._id,
        amount: amt,
        dateReceived: form.dateReceived,
        method: form.method,
        description: form.description,
        note: form.description,
        createdBy: (user as any)?._id ?? (user as any)?.id ?? 'admin',
      } as any)
      setForm({ amount: '', dateReceived: today, method: 'bank_transfer', description: '' })
    } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed') }
    finally { setBusy(false) }
  }

  if (viewCoach) {
    return (
      <div className="space-y-4">
        <button onClick={() => setViewCoach(null)} className="text-sm text-emerald-600 hover:underline">
          ← Back to all statements
        </button>

        {/* Record payment — pre-filled for this coach */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-base font-bold text-gray-800">Record Payment — {viewCoach.name || viewCoach.email}</h3>
            <p className="text-sm text-gray-500 mt-0.5">Log a payment received from this coach</p>
          </div>
          <form onSubmit={submit} className="p-6 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <input required type="number" step="0.01" min="0" placeholder="Amount ($)" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <input required type="date" value={form.dateReceived} onChange={e => setForm({ ...form, dateReceived: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
              <option value="bank_transfer">Bank Transfer</option>
              <option value="cash">Cash</option>
              <option value="stripe">Stripe</option>
              <option value="other">Other</option>
            </select>
            <input placeholder="Notes (optional)" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <button disabled={busy} className="sm:col-span-4 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors">
              {busy ? 'Saving…' : 'Record Payment'}
            </button>
          </form>
        </div>

        <CoachStatementTable coachId={viewCoach._id} coachEmail={viewCoach.email} coachName={viewCoach.name} editable />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Coach list */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-gray-800">Coach Statements</h3>
            <p className="text-sm text-gray-500 mt-0.5">Click a coach to view their earnings and record a payment</p>
          </div>
          <span className="text-xs text-gray-400 tabular-nums">{coaches.length} coaches</span>
        </div>
        {coaches.length === 0 ? (
          <div className="p-6 text-sm text-gray-400 italic">No coaches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Coach</th>
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tier</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {coaches.map((c: any) => (
                  <tr key={c._id} className="hover:bg-gray-50 cursor-pointer transition-colors" onClick={() => setViewCoach(c)}>
                    <td className="px-5 py-3 font-medium text-gray-900">{c.name || '—'}</td>
                    <td className="px-5 py-3 text-gray-500">{c.email}</td>
                    <td className="px-5 py-3 text-gray-500">{normaliseCoachTier(c.coachTier)}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            impersonate({ id: c._id, name: c.name || c.email, email: c.email, role: c.role })
                            navigate({ to: '/' })
                          }}
                          className="text-xs px-2.5 py-1 border border-amber-300 bg-amber-50 rounded-lg hover:bg-amber-100 font-medium text-amber-700 transition-colors"
                          title="View site as this coach"
                        >
                          👁️ Login as
                        </button>
                        <span className="text-xs font-semibold text-emerald-600">View →</span>
                      </div>
                    </td>
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

// ---------------------------------------------------------------------------
// Edit user / coach modal
// ---------------------------------------------------------------------------

function EditUserModal({ user, onClose, isCoach }: { user: any; onClose: () => void; isCoach?: boolean }) {
  const updateProfile = useMutation((api.users as any).adminUpdateUserProfile)
  const deleteUser = useMutation((api.users as any).adminDeleteUser)
  const addCredit = useMutation((api.mutations as any).addCustomerCredit)
  const verifyEmail = useMutation((api.users as any).adminVerifyEmail)
  const logReset = useMutation((api.users as any).adminLogPasswordReset)
  const ledger = useQuery((api.queries as any).listCreditLedger, { email: user.email }) as any[] | undefined
  const [name, setName] = useState(user.name || '')
  // SPEC_NAME_SPLIT: customers edit first/last (coaches keep the single name).
  const seedSplit = (() => {
    const sf = (user.firstName ?? '').trim()
    const sl = (user.lastName ?? '').trim()
    if (sf || sl) return { f: sf, l: sl }
    const full = (user.name ?? '').trim().replace(/\s+/g, ' ')
    const i = full.lastIndexOf(' ')
    return i === -1 ? { f: full, l: '' } : { f: full.slice(0, i), l: full.slice(i + 1) }
  })()
  const [firstName, setFirstName] = useState(seedSplit.f)
  const [lastName, setLastName] = useState(seedSplit.l)
  const [phone, setPhone] = useState(user.phone || '')
  const [coachTier, setCoachTier] = useState(normaliseCoachTier(user.coachTier))
  const [color, setColor] = useState(user.color || '')
  const [role, setRole] = useState(user.role || 'user')
  const [defaultSessionDuration, setDefaultSessionDuration] = useState<number>(user.defaultSessionDuration || 60)
  const [athleteCapacity, setAthleteCapacity] = useState<number>(user.athleteCapacity || 1)
  const [busy, setBusy] = useState(false)
  // SPEC_ADMIN_MANUAL_POWERS — manual support actions
  const [creditAmount, setCreditAmount] = useState('')
  const [creditNote, setCreditNote] = useState('')
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  // Current balance: prefer the latest ledger row (reactive), else the snapshot.
  const currentBalance = ledger && ledger.length > 0
    ? ledger[ledger.length - 1].balanceAfter
    : (user.creditBalance ?? 0)

  const adjustCredit = async () => {
    const amt = Math.round(parseFloat(creditAmount) * 100) / 100
    if (!amt || isNaN(amt)) { setActionMsg('Enter a non-zero amount (use a minus sign to deduct).'); return }
    setBusy(true); setActionMsg(null)
    try {
      await addCredit({ email: user.email, amount: amt, note: creditNote.trim() || undefined })
      setCreditAmount(''); setCreditNote('')
      setActionMsg(`Credit ${amt >= 0 ? 'added' : 'deducted'}: ${amt >= 0 ? '+$' : '-$'}${Math.abs(amt).toFixed(2)}`)
    } catch (err: any) { setActionMsg(getErrorMessage(err) ?? 'Failed to adjust credit') }
    finally { setBusy(false) }
  }

  const doVerifyEmail = async () => {
    setBusy(true); setActionMsg(null)
    try {
      const r = await verifyEmail({ email: user.email })
      setActionMsg(r?.alreadyVerified ? 'Email was already verified.' : 'Email marked as verified.')
    } catch (err: any) { setActionMsg(getErrorMessage(err) ?? 'Failed to verify email') }
    finally { setBusy(false) }
  }

  const doPasswordReset = async () => {
    setBusy(true); setActionMsg(null)
    try {
      const r = await sendPasswordReset(user.email)
      if (!r.success) { setActionMsg(r.error?.message ?? 'Failed to send reset email'); return }
      try { await logReset({ email: user.email }) } catch { /* audit best-effort */ }
      setActionMsg('Password-reset email sent.')
    } catch (err: any) { setActionMsg(getErrorMessage(err) ?? 'Failed to send reset email') }
    finally { setBusy(false) }
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const args: any = { email: user.email, phone, role }
      if (isCoach) { args.name = name } else { args.firstName = firstName.trim(); args.lastName = lastName.trim() }
      if (isCoach || role === 'coach') { args.coachTier = coachTier; args.color = color; args.defaultSessionDuration = defaultSessionDuration; args.athleteCapacity = athleteCapacity }
      await updateProfile(args)
      onClose()
    } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed') }
    finally { setBusy(false) }
  }

  const remove = async () => {
    if (!confirm(`Permanently delete ${user.email}? This cannot be undone.`)) return
    setBusy(true)
    try { await deleteUser({ email: user.email }); onClose() }
    catch (err: any) { alert(getErrorMessage(err) ?? 'Failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={e => e.stopPropagation()} onSubmit={save} className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">Edit {isCoach ? 'Coach' : 'User'}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-gray-400">{user.email}</p>
        {isCoach ? (
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Full name</span>
            <input value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          </label>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="font-medium text-gray-700">First name</span>
              <input value={firstName} onChange={e => setFirstName(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Last name</span>
              <input value={lastName} onChange={e => setLastName(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </label>
          </div>
        )}
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
              <select value={coachTier} onChange={e => setCoachTier(e.target.value as 'L1' | 'L2')} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                <option value="L1">L1 — rolling 8-day window</option>
                <option value="L2">L2 — weekly (opens Sunday 5pm WST)</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Calendar colour</span>
              <div className="flex gap-2 items-center mt-1">
                <input type="color" value={color || '#10b981'} onChange={e => setColor(e.target.value)} className="h-10 w-14 border border-gray-200 rounded-lg cursor-pointer" />
                <input value={color} onChange={e => setColor(e.target.value)} placeholder="#10b981" className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono" />
              </div>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Default session duration</span>
              <p className="text-xs text-gray-400 mb-1">Pre-fills the athlete slot duration when adding allocations</p>
              <select value={defaultSessionDuration} onChange={e => setDefaultSessionDuration(Number(e.target.value))} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                {[30, 45, 60, 75, 90, 120].map(d => (
                  <option key={d} value={d}>{d} min</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Athletes per session</span>
              <p className="text-xs text-gray-400 mb-1">Max athletes at once — pre-fills that many back-to-back slots when allocating (1 = one-on-one)</p>
              <select value={athleteCapacity} onChange={e => setAthleteCapacity(Number(e.target.value))} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                {[1, 2, 3, 4].map(n => (
                  <option key={n} value={n}>{n === 1 ? '1 (one-on-one)' : `${n} athletes`}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {/* SPEC_ADMIN_MANUAL_POWERS — manual support actions */}
        <div className="border-t border-gray-100 pt-4 space-y-3">
          <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Account actions</h4>

          {/* Adjust account credit */}
          <div className="bg-gray-50 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Account credit</span>
              <span className="text-sm font-bold text-emerald-600">${Number(currentBalance).toFixed(2)}</span>
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                step="0.01"
                value={creditAmount}
                onChange={e => setCreditAmount(e.target.value)}
                placeholder="±amount"
                className="w-28 px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <input
                value={creditNote}
                onChange={e => setCreditNote(e.target.value)}
                placeholder="Note (optional)"
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <button type="button" onClick={adjustCredit} disabled={busy} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50 shrink-0">
                Apply
              </button>
            </div>
            <p className="text-[11px] text-gray-400">Positive adds credit, negative deducts. Logged to the credit ledger.</p>
          </div>

          {/* Statement adjustment lines — customers manage here; coaches use the Statements tab */}
          {!isCoach && role !== 'coach' && user._id && (
            <StatementAdjustmentsManager subjectType="customer" subjectId={user._id} />
          )}

          {/* Email verify + password reset */}
          <div className="flex gap-2">
            <button type="button" onClick={doVerifyEmail} disabled={busy} className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              ✓ Mark email verified
            </button>
            <button type="button" onClick={doPasswordReset} disabled={busy} className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              ✉ Send password reset
            </button>
          </div>

          {actionMsg && (
            <p className="text-xs text-gray-600 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">{actionMsg}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          <button type="button" onClick={remove} disabled={busy} className="text-sm text-red-500 hover:text-red-700 hover:underline disabled:opacity-50">
            Delete account
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
            <button disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Customers tab
// ---------------------------------------------------------------------------

// Recent role / tier / permission changes (audit trail surfaced to admins).
function RoleAuditLogPanel() {
  const [open, setOpen] = useState(false)
  const log = (useQuery((api.users as any).listRoleAuditLog, open ? { limit: 30 } : 'skip') ?? []) as any[]
  const fmt = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
  }
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-6 py-3 flex items-center justify-between text-left hover:bg-gray-50"
      >
        <span className="text-sm font-semibold text-gray-700">🔐 Recent role &amp; permission changes</span>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-50 max-h-72 overflow-y-auto">
          {log.length === 0 ? (
            <div className="px-6 py-4 text-sm text-gray-400 italic">No role changes recorded yet.</div>
          ) : (
            log.map((r: any) => (
              <div key={r._id} className="px-6 py-2.5 text-xs flex items-center justify-between gap-3">
                <span className="text-gray-700">
                  <span className="font-medium">{r.targetEmail}</span> · {r.field}:{' '}
                  <span className="text-gray-400">{r.oldValue ?? '—'}</span> → <span className="font-medium">{r.newValue ?? '—'}</span>
                </span>
                <span className="text-gray-400 shrink-0">{r.changedByEmail} · {fmt(r.changedAt)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function CustomersTab() {
  const customers = useQuery(api.queries.listCustomers) ?? []
  const list = (customers as any[]).filter(c => c.role !== 'admin' && c.role !== 'coach')
  const [editing, setEditing] = useState<any | null>(null)
  const [search, setSearch] = useState('')
  // SPEC_NAME_SPLIT: choose surname-first or given-name-first ordering.
  const [sortBy, setSortBy] = useState<'first' | 'last'>('first')
  const [showAddForm, setShowAddForm] = useState(false)
  const [custForm, setCustForm] = useState({ name: '', email: '', phone: '', password: '' })
  const [busyAdd, setBusyAdd] = useState(false)
  const { impersonate } = useImpersonation()
  const navigate = useNavigate()
  const createCustomerMut = useMutation((api.mutations as any).createCustomer)
  const setPassword = useAction((api as any).adminPassword.adminSetPassword)

  const filtered = search
    ? list.filter((c: any) => {
        const q = search.toLowerCase()
        const phoneDigits = (c.phone || '').replace(/\D/g, '')
        const qDigits = search.replace(/\D/g, '')
        return (
          (c.name || '').toLowerCase().includes(q) ||
          (c.firstName || '').toLowerCase().includes(q) ||
          (c.lastName || '').toLowerCase().includes(q) ||
          (c.email || '').toLowerCase().includes(q) ||
          (qDigits.length >= 3 && phoneDigits.includes(qDigits))
        )
      })
    : list

  // SPEC_NAME_SPLIT: sort by first or last name (fall back to the display name
  // when a row has no split fields yet — pre-migration accounts).
  const sortKey = (c: any) => {
    const f = (c.firstName || '').toLowerCase().trim()
    const l = (c.lastName || '').toLowerCase().trim()
    const composed = sortBy === 'last' ? `${l} ${f}`.trim() : `${f} ${l}`.trim()
    return composed || (c.name || c.email || '').toLowerCase()
  }
  const sorted = [...filtered].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const email = custForm.email.toLowerCase().trim()
    if (!custForm.name.trim() || !email) { alert('Name and email are required'); return }
    if (!custForm.password || custForm.password.length < 8) { alert('Password must be at least 8 characters'); return }
    setBusyAdd(true)
    try {
      await createCustomerMut({ name: custForm.name.trim(), email, phone: custForm.phone || undefined })
      try { await setPassword({ email, password: custForm.password }) }
      catch (err: any) { alert('Customer record created, but failed to set password: ' + (getErrorMessage(err) ?? 'unknown')) }
      setCustForm({ name: '', email: '', phone: '', password: '' })
      setShowAddForm(false)
    } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed to create customer') }
    finally { setBusyAdd(false) }
  }

  return (
    <div className="space-y-6">
      <RoleAuditLogPanel />
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-base font-bold text-gray-800">Customers</h3>
            <p className="text-sm text-gray-500 mt-0.5">{list.length} registered</p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="search"
              placeholder="Search name, email or mobile…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm w-56"
            />
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as 'first' | 'last')}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white"
              title="Sort order"
            >
              <option value="first">Sort: First name</option>
              <option value="last">Sort: Last name</option>
            </select>
            <button
              onClick={() => setShowAddForm(f => !f)}
              className={`text-sm px-3 py-1.5 rounded-lg font-semibold transition-colors ${showAddForm ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
            >
              {showAddForm ? 'Cancel' : '+ Add Customer'}
            </button>
          </div>
        </div>
        <div className="divide-y divide-gray-100">
          {sorted.length === 0 && (
            <div className="p-6 text-sm text-gray-400 italic">{search ? 'No results.' : 'No customers yet.'}</div>
          )}
          {sorted.map((c: any) => (
            <div key={c._id} className="px-6 py-3 flex items-center justify-between gap-3 hover:bg-gray-50 transition-colors">
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">{c.name || c.email}</div>
                <div className="text-sm text-gray-500 truncate">
                  {c.name ? c.email : ''}
                  {c.phone ? ` · ${c.phone}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {c.creditBalance ? (
                  <span className="text-sm text-emerald-600 font-semibold">${c.creditBalance.toFixed(2)} credit</span>
                ) : null}
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium capitalize">{c.role}</span>
                <button
                  onClick={() => {
                    impersonate({ id: c._id, name: c.name || c.email, email: c.email, role: c.role })
                    navigate({ to: '/' })
                  }}
                  className="text-xs px-3 py-1.5 border border-amber-300 bg-amber-50 rounded-lg hover:bg-amber-100 font-medium text-amber-700 transition-colors"
                  title="View site as this user"
                >
                  👁️ Login as
                </button>
                <button
                  onClick={() => setEditing(c)}
                  className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 font-medium text-gray-700"
                >
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
        {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} />}
      </div>

      {showAddForm && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-base font-bold text-gray-800">Add Customer</h3>
            <p className="text-sm text-gray-500 mt-0.5">Create an account immediately with a password</p>
          </div>
          <form onSubmit={submitAdd} className="p-6 grid grid-cols-1 sm:grid-cols-6 gap-3">
            <input
              required placeholder="Full name" value={custForm.name}
              onChange={e => setCustForm({ ...custForm, name: e.target.value })}
              className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
            <input
              required type="email" placeholder="Email" value={custForm.email}
              onChange={e => setCustForm({ ...custForm, email: e.target.value })}
              className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
            <input
              placeholder="Phone (optional)" value={custForm.phone}
              onChange={e => setCustForm({ ...custForm, phone: e.target.value })}
              className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
            <input
              required type="text" placeholder="Password (min 10 characters)"
              value={custForm.password} minLength={10}
              onChange={e => setCustForm({ ...custForm, password: e.target.value })}
              className="sm:col-span-6 px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
            <button
              disabled={busyAdd}
              className="sm:col-span-6 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors"
            >
              {busyAdd ? 'Creating…' : 'Create Customer Account'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Balance error boundary — isolates per-coach balance query failures so a
// single coach's data error doesn't crash the rest of the Coaches tab
// ---------------------------------------------------------------------------

class BalanceBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

type BalVal = { label: string; cls: string }

// Computes and renders the Balance + Last Paid cells for a single coach using
// only the two queries that already exist in production Convex.
// Lives in its own component so useQuery hooks don't violate the rules-of-hooks
// when called in a loop, and so BalanceBoundary can isolate any query errors.
function CoachBalanceCells({
  coachId, coachEmail, fmtBalance, fmtLastPaid,
}: {
  coachId: string
  coachEmail: string
  fmtBalance: (n: number) => BalVal
  fmtLastPaid: (d: string | null) => string
}) {
  const payments = useQuery(api.queries.listPaymentsByCoach, coachId ? { coachId } : 'skip')
  const bookings = useQuery(
    api.queries.listBookingsByEmail,
    coachEmail ? { email: coachEmail } : 'skip'
  )

  if (payments === undefined || bookings === undefined) {
    return (
      <>
        <td className="px-5 py-3 text-gray-300 text-xs">…</td>
        <td className="px-5 py-3 text-gray-300 text-xs">…</td>
      </>
    )
  }

  const now = getAWSTNow()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

  const totalCharged = (bookings as any[]).reduce((sum: number, b: any) => {
    if (b.status === 'cancelled') return sum
    if (!(b.isCoachBooking === true || (typeof b.coachPrice === 'number' && b.coachPrice > 0))) return sum
    if ((b.date || '') > todayStr) return sum
    return sum + (Number(b.coachPrice) || 0)
  }, 0)

  const totalPaid = (payments as any[]).reduce((sum: number, p: any) => sum + (Number(p.amount) || 0), 0)
  const balance = totalCharged - totalPaid

  const lastPayment = (payments as any[]).reduce((latest: any, p: any) =>
    !latest || (p.dateReceived || '') > (latest.dateReceived || '') ? p : latest
  , null)

  const bal = fmtBalance(balance)
  const lastPaid = fmtLastPaid(lastPayment?.dateReceived ?? null)

  return (
    <>
      <td className="px-5 py-3">
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${bal.cls}`}>
          {bal.label}
        </span>
      </td>
      <td className="px-5 py-3 text-sm text-gray-500 whitespace-nowrap">{lastPaid}</td>
    </>
  )
}

function CoachRow({
  c, setEditingCoach, fmtBalance, fmtLastPaid,
}: {
  c: any
  setEditingCoach: (c: any) => void
  fmtBalance: (n: number) => BalVal
  fmtLastPaid: (d: string | null) => string
}) {
  const { impersonate } = useImpersonation()
  const navigate = useNavigate()
  const unknownBal: BalVal = { label: '—', cls: 'bg-gray-100 text-gray-400 border-gray-200' }
  const fallbackCells = (
    <>
      <td className="px-5 py-3">
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${unknownBal.cls}`}>
          {unknownBal.label}
        </span>
      </td>
      <td className="px-5 py-3 text-sm text-gray-400 whitespace-nowrap">—</td>
    </>
  )
  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-5 py-3 font-medium text-gray-900">{c.name || '—'}</td>
      <td className="px-5 py-3 text-gray-500">{c.email}</td>
      <td className="px-5 py-3 text-gray-500">{c.phone || '—'}</td>
      <td className="px-5 py-3">
        <span className="inline-flex items-center gap-1.5">
          {c.color && <span className="w-2.5 h-2.5 rounded-full border border-gray-200 shrink-0" style={{ background: c.color }} />}
          <span className="text-gray-500">{normaliseCoachTier(c.coachTier)}</span>
        </span>
      </td>
      <BalanceBoundary fallback={fallbackCells}>
        <CoachBalanceCells
          coachId={c._id}
          coachEmail={c.email || ''}
          fmtBalance={fmtBalance}
          fmtLastPaid={fmtLastPaid}
        />
      </BalanceBoundary>
      <td className="px-5 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => {
              impersonate({ id: c._id, name: c.name || c.email, email: c.email, role: 'coach' })
              navigate({ to: '/statements' })
            }}
            className="text-xs px-2.5 py-1 border border-amber-300 bg-amber-50 rounded-lg hover:bg-amber-100 font-medium text-amber-700 transition-colors"
            title="View portal as this coach"
          >
            👁️ Login as
          </button>
          <button
            onClick={() => setEditingCoach(c)}
            className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 font-medium text-gray-700"
          >
            Edit
          </button>
        </div>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Coaches tab
// ---------------------------------------------------------------------------

function CoachesTab() {
  const { user } = useAuth()
  const { impersonate } = useImpersonation()
  const navigate = useNavigate()
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
  const [addMode, setAddMode] = useState<'direct' | 'invite'>('direct')
  const [showAddForm, setShowAddForm] = useState(false)

  // ── Quick-add payment ────────────────────────────────────────────────────
  const createPayment = useMutation(api.mutations.createPayment)

  const todayISO = (() => {
    const n = new Date()
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
  })()
  const [qpCoachId, setQpCoachId] = useState('')
  const [qpAmount, setQpAmount] = useState('')
  const [qpDate, setQpDate] = useState(todayISO)
  const [qpMethod, setQpMethod] = useState('Bank Transfer')
  const [qpNote, setQpNote] = useState('')
  const [qpBusy, setQpBusy] = useState(false)
  const [qpSuccess, setQpSuccess] = useState(false)

  const submitQuickPay = async (e: React.FormEvent) => {
    e.preventDefault()
    const amt = parseFloat(qpAmount)
    if (!qpCoachId || isNaN(amt) || amt <= 0) return
    setQpBusy(true)
    try {
      await createPayment({
        coachId: qpCoachId,
        amount: amt,
        dateReceived: qpDate,
        method: qpMethod,
        note: qpNote.trim() || undefined,
        createdBy: user?.email ?? 'admin',
      })
      setQpAmount('')
      setQpNote('')
      setQpSuccess(true)
      setTimeout(() => setQpSuccess(false), 3000)
    } catch (err: any) {
      alert(getErrorMessage(err) ?? 'Failed to record payment')
    } finally {
      setQpBusy(false)
    }
  }

  const fmtBalance = (balance: number) => {
    if (Math.abs(balance) < 0.005) return { label: 'Settled', cls: 'bg-gray-100 text-gray-500 border-gray-200' }
    if (balance > 0) return { label: `$${balance.toFixed(2)} outstanding`, cls: 'bg-red-100 text-red-700 border-red-200' }
    return { label: `$${Math.abs(balance).toFixed(2)} in credit`, cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' }
  }

  const fmtLastPaid = (dateStr: string | null) => {
    if (!dateStr) return 'Never'
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  // Merge consecutive bookings
  const mergeBookings = useMutation((api.mutations as any).mergeConsecutiveCoachBookings)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [showMergePreview, setShowMergePreview] = useState(false)
  const [mergeResult, setMergeResult] = useState<{ mergeCount: number; mergedSummary: string[] } | null>(null)
  const mergePreviewData = useQuery(
    (api.queries as any).previewMergeConsecutiveCoachBookings,
    showMergePreview ? {} : "skip"
  )

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
      try { await setPassword({ email, password: coachForm.password }) }
      catch (err: any) { alert('Coach created, but failed to set password: ' + (getErrorMessage(err) ?? 'unknown')) }
      setCoachForm({ name: '', email: '', phone: '', coachTier: 'L1', password: '' })
    } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed') }
    finally { setBusyAdd(false) }
  }

  const submitInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createInvite) { alert('Coach invites not available'); return }
    setBusy(true)
    try {
      const token = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
      await createInvite({
        token,
        name: form.name.trim(),
        email: form.email.toLowerCase().trim(),
        phone: form.phone,
        createdBy: (user as any)?._id ?? (user as any)?.id ?? 'admin',
      })
      setForm({ name: '', email: '', phone: '' })
    } catch (err: any) { alert(getErrorMessage(err) ?? 'Failed') }
    finally { setBusy(false) }
  }

  const pendingInvites = (invites as any[]).filter(i => !i.used)

  return (
    <div className="space-y-6">

      {/* ── Quick Add Coach Payment ── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-800">Quick Add Payment</h3>
          <p className="text-sm text-gray-500 mt-0.5">Record a payment received from a coach without opening their statement.</p>
        </div>
        <form onSubmit={submitQuickPay} className="p-6 grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
          {/* Coach */}
          <div className="sm:col-span-2 flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Coach</label>
            <select
              required
              value={qpCoachId}
              onChange={e => setQpCoachId(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
            >
              <option value="">Select coach…</option>
              {coaches.map((c: any) => (
                <option key={c._id} value={c._id}>{c.name || c.email}</option>
              ))}
            </select>
          </div>
          {/* Amount */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount ($)</label>
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={qpAmount}
              onChange={e => setQpAmount(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
          </div>
          {/* Date */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</label>
            <input
              required
              type="date"
              value={qpDate}
              onChange={e => setQpDate(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
          </div>
          {/* Method */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Method</label>
            <select
              value={qpMethod}
              onChange={e => setQpMethod(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
            >
              <option>Bank Transfer</option>
              <option>Cash</option>
              <option>Card</option>
            </select>
          </div>
          {/* Note */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Note (optional)</label>
            <input
              type="text"
              placeholder="e.g. May payment"
              value={qpNote}
              onChange={e => setQpNote(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
          </div>
          {/* Submit */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-transparent uppercase tracking-wide">Save</label>
            <button
              type="submit"
              disabled={qpBusy}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {qpBusy ? 'Saving…' : 'Save Payment'}
            </button>
          </div>
        </form>
        {qpSuccess && (
          <div className="mx-6 mb-4 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700 font-medium">
            ✅ Payment recorded successfully.
          </div>
        )}
      </div>

      {/* Active coaches */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-gray-800">Active Coaches</h3>
            <p className="text-sm text-gray-500 mt-0.5">{coaches.length} coach{coaches.length !== 1 ? 'es' : ''}</p>
          </div>
          <button
            onClick={() => setShowAddForm(f => !f)}
            className={`text-sm px-3 py-1.5 rounded-lg font-semibold transition-colors ${showAddForm ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
          >
            {showAddForm ? 'Cancel' : '+ Add Coach'}
          </button>
        </div>
        {coaches.length === 0 ? (
          <div className="p-6 text-sm text-gray-400 italic">No coaches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Phone</th>
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tier</th>
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Balance</th>
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Last Paid</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {coaches.map((c: any) => (
                  <CoachRow
                    key={c._id}
                    c={c}
                    setEditingCoach={setEditingCoach}
                    fmtBalance={fmtBalance}
                    fmtLastPaid={fmtLastPaid}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingCoach && <EditUserModal user={editingCoach} onClose={() => setEditingCoach(null)} isCoach />}

      {showAddForm && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-gray-800">Add Coach</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                {addMode === 'direct' ? 'Create an account immediately with a password' : 'Send a self-service invite link by email'}
              </p>
            </div>
            <div className="flex bg-gray-100 p-0.5 rounded-lg">
              <button
                onClick={() => setAddMode('direct')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${addMode === 'direct' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
              >
                Direct
              </button>
              <button
                onClick={() => setAddMode('invite')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${addMode === 'invite' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
              >
                Invite
              </button>
            </div>
          </div>

          {addMode === 'direct' ? (
            <form onSubmit={submitAdd} className="p-6 grid grid-cols-1 sm:grid-cols-6 gap-3">
              <input required placeholder="Full name" value={coachForm.name} onChange={e => setCoachForm({ ...coachForm, name: e.target.value })} className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              <input required type="email" placeholder="Email" value={coachForm.email} onChange={e => setCoachForm({ ...coachForm, email: e.target.value })} className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              <input placeholder="Phone" value={coachForm.phone} onChange={e => setCoachForm({ ...coachForm, phone: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              <select value={coachForm.coachTier} onChange={e => setCoachForm({ ...coachForm, coachTier: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                <option value="L1">L1</option>
                <option value="L2">L2</option>
              </select>
              <input required type="text" placeholder="Password (min 10 characters)" value={coachForm.password} onChange={e => setCoachForm({ ...coachForm, password: e.target.value })} minLength={10} className="sm:col-span-6 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              <button disabled={busyAdd} className="sm:col-span-6 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors">
                {busyAdd ? 'Creating…' : 'Create Coach Account'}
              </button>
            </form>
          ) : (
            <form onSubmit={submitInvite} className="p-6 grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input required placeholder="Full name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              <input required type="email" placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              <input placeholder="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              <button disabled={busy} className="sm:col-span-4 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors">
                {busy ? 'Sending…' : 'Send Invite'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Pending invites */}
      {(invites as any[]).length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-base font-bold text-gray-800">Pending Invites</h3>
            <span className="text-xs text-gray-400 tabular-nums">{pendingInvites.length} pending</span>
          </div>
          <div className="divide-y divide-gray-100">
            {(invites as any[]).map((inv: any) => (
              <div key={inv._id} className="px-6 py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-900 text-sm">{inv.name}</div>
                  <div className="text-xs text-gray-500">{inv.email}</div>
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${inv.used ? 'bg-gray-100 text-gray-400' : 'bg-amber-100 text-amber-700'}`}>
                  {inv.used ? 'Used' : 'Pending'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Merge Consecutive Bookings ── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-800">🔗 Merge Consecutive Bookings</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Collapses back-to-back coach blocks on the same lane &amp; day into a single booking.
            Door code is taken from the first block; price and athlete allocations are combined.
          </p>
        </div>
        <div className="p-6 space-y-4">

          {/* ── Post-merge success banner ── */}
          {mergeResult && (
            <div className={`rounded-xl px-4 py-3 text-sm ${mergeResult.mergeCount > 0 ? 'bg-emerald-50 border border-emerald-200' : 'bg-gray-50 border border-gray-200'}`}>
              {mergeResult.mergeCount === 0 ? (
                <p className="text-gray-500">✅ No consecutive blocks found — nothing to merge.</p>
              ) : (
                <>
                  <p className="font-semibold text-emerald-700 mb-2">
                    ✅ Merged {mergeResult.mergeCount} group{mergeResult.mergeCount !== 1 ? 's' : ''}
                  </p>
                  <ul className="space-y-0.5">
                    {mergeResult.mergedSummary.map((line, i) => (
                      <li key={i} className="text-gray-600 text-xs font-mono">• {line}</li>
                    ))}
                  </ul>
                </>
              )}
              <button
                onClick={() => { setMergeResult(null); setShowMergePreview(false) }}
                className="mt-3 text-xs text-gray-400 hover:text-gray-600 underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* ── Initial button ── */}
          {!showMergePreview && !mergeResult && (
            <button
              onClick={() => setShowMergePreview(true)}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-900 text-white rounded-lg text-sm font-semibold transition-colors"
            >
              🔍 Preview Merges
            </button>
          )}

          {/* ── Preview loading ── */}
          {showMergePreview && !mergeResult && mergePreviewData === undefined && (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
              Scanning bookings…
            </div>
          )}

          {/* ── Preview results ── */}
          {showMergePreview && !mergeResult && mergePreviewData !== undefined && (
            <div className="space-y-4">
              {(mergePreviewData as any[]).length === 0 ? (
                <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-500">
                  ✅ No consecutive blocks found — nothing to merge.
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-600">
                    Found <span className="font-semibold text-gray-900">{(mergePreviewData as any[]).length} group{(mergePreviewData as any[]).length !== 1 ? 's' : ''}</span> to merge:
                  </p>

                  {/* Chain list */}
                  <div className="space-y-3">
                    {(mergePreviewData as any[]).map((chain: any, idx: number) => {
                      const dateObj = new Date(chain.date + 'T00:00:00')
                      const dateLabel = dateObj.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
                      return (
                        <div key={idx} className="border border-gray-200 rounded-xl overflow-hidden">
                          {/* Chain header */}
                          <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                            <div className="flex items-center gap-2 text-sm">
                              <span className="font-semibold text-gray-800">{chain.coachName}</span>
                              <span className="text-gray-400">·</span>
                              <span className="text-gray-600">{dateLabel}</span>
                              <span className="text-gray-400">·</span>
                              <span className="text-gray-600">{chain.laneName}</span>
                            </div>
                            <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                              → {chain.mergedStartLabel}–{chain.mergedEndLabel} ({chain.mergedDuration}min)
                            </span>
                          </div>
                          {/* Individual blocks being merged */}
                          <div className="px-4 py-2 flex flex-wrap gap-2">
                            {chain.blocks.map((block: any, bi: number) => (
                              <div key={bi} className="flex items-center gap-1">
                                {bi > 0 && <span className="text-gray-300 text-xs">+</span>}
                                <span className="text-xs bg-blue-50 border border-blue-200 text-blue-700 px-2 py-0.5 rounded-lg font-mono">
                                  {block.startLabel}–{block.endLabel}
                                  {block.accessCode && bi === 0 && (
                                    <span className="ml-1 text-blue-400">🔑{block.accessCode}</span>
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Confirm / Cancel */}
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={async () => {
                        setMergeBusy(true)
                        try {
                          const result = await mergeBookings({})
                          setMergeResult(result as any)
                        } catch (err: any) {
                          alert(getErrorMessage(err) ?? 'Merge failed')
                        } finally {
                          setMergeBusy(false)
                        }
                      }}
                      disabled={mergeBusy}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors"
                    >
                      {mergeBusy ? 'Merging…' : `✅ Confirm — merge ${(mergePreviewData as any[]).length} group${(mergePreviewData as any[]).length !== 1 ? 's' : ''}`}
                    </button>
                    <button
                      onClick={() => setShowMergePreview(false)}
                      className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
