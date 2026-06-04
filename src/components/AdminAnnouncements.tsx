// SPEC_INAPP_BANNERS — admin "Announcements" tab. Author dismissable in-app
// banners / pop-ups: compose (title/body/CTA), choose display type + style +
// audience (all / by role / by booking date range), optional active window,
// dismissible, priority, active. Live preview of both the banner strip and the
// pop-up. List of all announcements with status, audience, dismiss count, and
// activate/deactivate + duplicate + delete + edit.
import { useMemo, useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { toast } from 'sonner'
import { api } from '../../convex/_generated/api'

type DisplayType = 'banner' | 'modal'
type Style = 'info' | 'notice' | 'promo'
type AudienceMode = 'all' | 'roles' | 'bookingRange'
type Scope = 'day' | 'week' | 'month' | 'range'

// ── date helpers (booking-range scope → YYYY-MM-DD start/end) ─────────────────
const fmt = (d: Date) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}
function rangeForScope(scope: Scope, ref: string, rStart: string, rEnd: string): { start: string; end: string } {
  if (scope === 'range') return { start: rStart, end: rEnd }
  const d = parse(ref)
  if (scope === 'day') return { start: ref, end: ref }
  if (scope === 'week') {
    const dow = (d.getDay() + 6) % 7 // Mon=0
    const mon = new Date(d); mon.setDate(d.getDate() - dow)
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
    return { start: fmt(mon), end: fmt(sun) }
  }
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { start: fmt(first), end: fmt(last) }
}

// ── datetime-local <-> epoch ms (local) ──────────────────────────────────────
function toLocalInput(ms?: number): string {
  if (ms == null) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocalInput = (s: string): number | undefined => (s ? new Date(s).getTime() : undefined)

const STYLE_MAP: Record<Style, { wrap: string; icon: string; cta: string }> = {
  info: { wrap: 'bg-red-50 border-red-200 text-red-800', icon: 'ℹ️', cta: 'bg-red-600' },
  notice: { wrap: 'bg-amber-50 border-amber-200 text-amber-900', icon: '⚠️', cta: 'bg-amber-600' },
  promo: { wrap: 'bg-emerald-50 border-emerald-200 text-emerald-800', icon: '🎉', cta: 'bg-emerald-600' },
}

function Chip({ children, color }: { children: React.ReactNode; color: string }) {
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${color}`}>{children}</span>
}

type FormState = {
  title: string
  body: string
  ctaLabel: string
  ctaTarget: string
  displayType: DisplayType
  style: Style
  audienceMode: AudienceMode
  includeLoggedOut: boolean
  roles: Set<string> // for 'roles' mode: customer/coach/admin
  scope: Scope
  refDate: string
  rStart: string
  rEnd: string
  subRoles: Set<string> // for 'bookingRange' sub-filter: customer/coach/athlete
  startAt: string // datetime-local
  endAt: string
  dismissible: boolean
  priority: number
  active: boolean
}

const today = fmt(new Date())
const emptyForm = (): FormState => ({
  title: '', body: '', ctaLabel: '', ctaTarget: '',
  displayType: 'banner', style: 'info',
  audienceMode: 'all', includeLoggedOut: false,
  roles: new Set(['customer']),
  scope: 'week', refDate: today, rStart: today, rEnd: today,
  subRoles: new Set(),
  startAt: '', endAt: '',
  dismissible: true, priority: 0, active: true,
})

export default function AdminAnnouncements() {
  const list = useQuery(api.announcements.listAnnouncementsAdmin, {}) as any[] | undefined
  const createAnn = useMutation(api.announcements.createAnnouncement)
  const updateAnn = useMutation(api.announcements.updateAnnouncement)
  const setActive = useMutation(api.announcements.setAnnouncementActive)
  const duplicate = useMutation(api.announcements.duplicateAnnouncement)
  const remove = useMutation(api.announcements.deleteAnnouncement)

  const [form, setForm] = useState<FormState>(emptyForm())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [resetDismissals, setResetDismissals] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }))
  const toggleIn = (k: 'roles' | 'subRoles', val: string) =>
    setForm((f) => {
      const next = new Set(f[k]); next.has(val) ? next.delete(val) : next.add(val)
      return { ...f, [k]: next }
    })

  const resetForm = () => { setForm(emptyForm()); setEditingId(null); setResetDismissals(false) }

  const loadForEdit = (a: any) => {
    setEditingId(a._id)
    setResetDismissals(false)
    setForm({
      title: a.title ?? '',
      body: a.body ?? '',
      ctaLabel: a.ctaLabel ?? '',
      ctaTarget: a.ctaTarget ?? '',
      displayType: (a.displayType as DisplayType) ?? 'banner',
      style: (a.style as Style) ?? 'info',
      audienceMode: (a.audienceMode as AudienceMode) ?? 'all',
      includeLoggedOut: a.includeLoggedOut === true,
      roles: new Set(a.audienceMode === 'roles' ? a.audienceRoles ?? [] : ['customer']),
      scope: 'range',
      refDate: a.rangeStart ?? today,
      rStart: a.rangeStart ?? today,
      rEnd: a.rangeEnd ?? today,
      subRoles: new Set(a.audienceMode === 'bookingRange' ? a.audienceRoles ?? [] : []),
      startAt: toLocalInput(a.startAt),
      endAt: toLocalInput(a.endAt),
      dismissible: a.dismissible ?? true,
      priority: a.priority ?? 0,
      active: a.active ?? true,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const buildArgs = () => {
    const base: any = {
      title: form.title.trim(),
      body: form.body.trim(),
      ctaLabel: form.ctaLabel.trim() || undefined,
      ctaTarget: form.ctaTarget.trim() || undefined,
      displayType: form.displayType,
      style: form.style,
      audienceMode: form.audienceMode,
      startAt: fromLocalInput(form.startAt),
      endAt: fromLocalInput(form.endAt),
      dismissible: form.dismissible,
      priority: Number(form.priority) || 0,
      active: form.active,
    }
    if (form.audienceMode === 'all') {
      base.includeLoggedOut = form.includeLoggedOut
    } else if (form.audienceMode === 'roles') {
      base.audienceRoles = Array.from(form.roles)
    } else {
      const { start, end } = rangeForScope(form.scope, form.refDate, form.rStart, form.rEnd)
      base.rangeStart = start
      base.rangeEnd = end
      base.audienceRoles = Array.from(form.subRoles)
    }
    return base
  }

  const save = async () => {
    if (!form.title.trim() || !form.body.trim()) { toast.error('Add a title and message.'); return }
    if (form.audienceMode === 'roles' && form.roles.size === 0) { toast.error('Pick at least one role.'); return }
    setSaving(true)
    try {
      const args = buildArgs()
      if (editingId) {
        await updateAnn({ id: editingId as any, resetDismissals, ...args })
        toast.success('Announcement updated.')
      } else {
        await createAnn(args)
        toast.success('Announcement created.')
      }
      resetForm()
    } catch (e: any) {
      toast.error(e?.data ?? e?.message ?? 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  const st = STYLE_MAP[form.style]
  const now = Date.now()
  const statusOf = (a: any): { label: string; color: string } => {
    if (!a.active) return { label: 'inactive', color: 'bg-gray-100 text-gray-500' }
    if (a.startAt && now < a.startAt) return { label: 'scheduled', color: 'bg-blue-50 text-blue-600' }
    if (a.endAt && now > a.endAt) return { label: 'expired', color: 'bg-gray-100 text-gray-400' }
    return { label: 'live', color: 'bg-emerald-50 text-emerald-600' }
  }
  const audienceSummary = (a: any): string => {
    if (a.audienceMode === 'all') return a.includeLoggedOut ? 'Everyone (incl. logged-out)' : 'All logged-in users'
    if (a.audienceMode === 'roles') return `Roles: ${(a.audienceRoles ?? []).join(', ') || '—'}`
    const sub = (a.audienceRoles ?? []).length ? ` · ${(a.audienceRoles ?? []).join('/')}` : ''
    return `Booked ${a.rangeStart} → ${a.rangeEnd}${sub}`
  }

  const previewRange = useMemo(
    () => rangeForScope(form.scope, form.refDate, form.rStart, form.rEnd),
    [form.scope, form.refDate, form.rStart, form.rEnd]
  )

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-800">📌 Announcements</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          In-app banners &amp; pop-ups shown the next time a targeted user opens the app. No push or
          email is sent — use Broadcast for that.
        </p>
      </div>

      {/* ── Compose ── */}
      <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">
            {editingId ? 'Edit announcement' : 'New announcement'}
          </h3>
          {editingId && (
            <button onClick={resetForm} className="text-xs text-gray-500 hover:underline">Cancel edit · start new</button>
          )}
        </div>

        <label className="block text-sm">
          <span className="text-gray-600">Title</span>
          <input value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={120}
            placeholder="New: book up to 2 weeks ahead" className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-gray-600">Message</span>
          <textarea value={form.body} onChange={(e) => set('body', e.target.value)} rows={3}
            placeholder="Write your message…" className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-gray-600">CTA label (optional)</span>
            <input value={form.ctaLabel} onChange={(e) => set('ctaLabel', e.target.value)}
              placeholder="Book now" className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">CTA target (route or URL)</span>
            <input value={form.ctaTarget} onChange={(e) => set('ctaTarget', e.target.value)}
              placeholder="/ or https://…" className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
        </div>

        {/* Display type + style */}
        <div className="flex flex-wrap gap-6">
          <div className="text-sm">
            <span className="text-gray-600 block mb-1">Display</span>
            <div className="flex gap-3">
              {(['banner', 'modal'] as DisplayType[]).map((d) => (
                <label key={d} className="flex items-center gap-1.5">
                  <input type="radio" checked={form.displayType === d} onChange={() => set('displayType', d)} />
                  {d === 'banner' ? 'Banner strip' : 'Pop-up modal'}
                </label>
              ))}
            </div>
          </div>
          <div className="text-sm">
            <span className="text-gray-600 block mb-1">Style</span>
            <div className="flex gap-3">
              {(['info', 'notice', 'promo'] as Style[]).map((s) => (
                <label key={s} className="flex items-center gap-1.5 capitalize">
                  <input type="radio" checked={form.style === s} onChange={() => set('style', s)} />
                  {s}
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Audience */}
        <div className="border-t border-gray-100 pt-4 space-y-3">
          <span className="text-gray-600 text-sm font-medium">Audience</span>
          <div className="flex flex-wrap gap-2">
            {([['all', 'All users'], ['roles', 'By role'], ['bookingRange', 'By booking date']] as [AudienceMode, string][]).map(([m, label]) => (
              <button key={m} onClick={() => set('audienceMode', m)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${form.audienceMode === m ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {label}
              </button>
            ))}
          </div>

          {form.audienceMode === 'all' && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.includeLoggedOut} onChange={(e) => set('includeLoggedOut', e.target.checked)} className="rounded" />
              Also show to logged-out visitors (public landing notice)
            </label>
          )}

          {form.audienceMode === 'roles' && (
            <div className="flex flex-wrap gap-4 text-sm">
              {(['customer', 'coach', 'admin'] as const).map((r) => (
                <label key={r} className="flex items-center gap-2 text-gray-700 capitalize">
                  <input type="checkbox" checked={form.roles.has(r)} onChange={() => toggleIn('roles', r)} className="rounded" />
                  {r}s
                </label>
              ))}
            </div>
          )}

          {form.audienceMode === 'bookingRange' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {([['day', 'A day'], ['week', 'A week'], ['month', 'A month'], ['range', 'Custom']] as [Scope, string][]).map(([s, label]) => (
                  <button key={s} onClick={() => set('scope', s)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium ${form.scope === s ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    {label}
                  </button>
                ))}
              </div>
              {form.scope !== 'range' ? (
                <label className="block text-sm">
                  <span className="text-gray-600">Reference date</span>
                  <input type="date" value={form.refDate} onChange={(e) => set('refDate', e.target.value)}
                    className="mt-1 block border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
                  <span className="ml-3 text-xs text-gray-400">{previewRange.start} → {previewRange.end}</span>
                </label>
              ) : (
                <div className="flex flex-wrap items-end gap-3 text-sm">
                  <label className="block"><span className="text-gray-600">From</span>
                    <input type="date" value={form.rStart} onChange={(e) => set('rStart', e.target.value)}
                      className="mt-1 block border border-gray-300 rounded-lg px-3 py-1.5" /></label>
                  <label className="block"><span className="text-gray-600">To</span>
                    <input type="date" value={form.rEnd} onChange={(e) => set('rEnd', e.target.value)}
                      className="mt-1 block border border-gray-300 rounded-lg px-3 py-1.5" /></label>
                </div>
              )}
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-gray-500 text-xs self-center">Narrow to (optional):</span>
                {(['customer', 'coach', 'athlete'] as const).map((r) => (
                  <label key={r} className="flex items-center gap-2 text-gray-700 capitalize">
                    <input type="checkbox" checked={form.subRoles.has(r)} onChange={() => toggleIn('subRoles', r)} className="rounded" />
                    {r === 'athlete' ? 'parents of athletes' : `${r}s`}
                  </label>
                ))}
              </div>
              <p className="text-xs text-gray-400">Shown only to accounts with a confirmed booking in this range (logged-in only). Athlete = the child&apos;s parent account.</p>
            </div>
          )}
        </div>

        {/* Active window + flags */}
        <div className="border-t border-gray-100 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <label className="block">
            <span className="text-gray-600">Show from (optional)</span>
            <input type="datetime-local" value={form.startAt} onChange={(e) => set('startAt', e.target.value)}
              className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-1.5" />
          </label>
          <label className="block">
            <span className="text-gray-600">Hide after (optional)</span>
            <input type="datetime-local" value={form.endAt} onChange={(e) => set('endAt', e.target.value)}
              className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-1.5" />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-5 text-sm">
          <label className="flex items-center gap-2 text-gray-700">
            <input type="checkbox" checked={form.dismissible} onChange={(e) => set('dismissible', e.target.checked)} className="rounded" />
            Dismissible
          </label>
          <label className="flex items-center gap-2 text-gray-700">
            <span>Priority</span>
            <input type="number" value={form.priority} onChange={(e) => set('priority', Number(e.target.value))}
              className="w-20 border border-gray-300 rounded-lg px-2 py-1" />
          </label>
          <label className="flex items-center gap-2 text-gray-700">
            <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} className="rounded" />
            Active
          </label>
          {editingId && (
            <label className="flex items-center gap-2 text-gray-700">
              <input type="checkbox" checked={resetDismissals} onChange={(e) => setResetDismissals(e.target.checked)} className="rounded" />
              Show again to everyone <span className="text-xs text-gray-400">(clears dismissals)</span>
            </label>
          )}
        </div>

        {/* Live preview */}
        {(form.title.trim() || form.body.trim()) && (
          <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 space-y-3">
            <p className="text-[10px] uppercase tracking-wide text-gray-400">Preview · {form.displayType}</p>
            {form.displayType === 'banner' ? (
              <div className={`rounded-md border ${st.wrap} px-3 py-2 flex items-start gap-2 text-sm`}>
                <span>{st.icon}</span>
                <div className="flex-1 min-w-0">
                  <span className="font-semibold">{form.title || '(title)'}</span>
                  {form.body && <span className="ml-2 opacity-90">{form.body}</span>}
                </div>
                {form.ctaLabel && <span className="text-xs font-semibold underline">{form.ctaLabel}</span>}
                {form.dismissible && <span className="text-xs opacity-60">✕</span>}
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow-md border border-gray-200 max-w-sm overflow-hidden">
                <div className={`px-4 py-2 border-b flex items-center gap-2 ${st.wrap}`}>
                  <span>{st.icon}</span><span className="font-bold text-sm">{form.title || '(title)'}</span>
                </div>
                <div className="p-4">
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{form.body || '(message)'}</p>
                  <div className="flex justify-end gap-2 mt-3">
                    <span className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-600 text-xs">{form.dismissible ? 'Got it' : 'Close'}</span>
                    {form.ctaLabel && <span className={`px-3 py-1.5 rounded-lg text-white text-xs ${st.cta}`}>{form.ctaLabel}</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create announcement'}
          </button>
        </div>
      </section>

      {/* ── List ── */}
      <section className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-3">All announcements</h3>
        {!list ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-gray-400">None yet.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {list.map((a) => {
              const s = statusOf(a)
              return (
                <div key={a._id} className="py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-gray-800 truncate">{a.title}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Chip color={s.color}>{s.label}</Chip>
                      <Chip color="bg-gray-100 text-gray-500">{a.displayType}</Chip>
                      <Chip color="bg-gray-100 text-gray-500">{a.style}</Chip>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-0.5">{a.body}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px] text-gray-500">
                    <span>{audienceSummary(a)}</span>
                    <span>· {a.dismissCount} dismissed</span>
                    {a.priority ? <span>· priority {a.priority}</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-3 mt-2 text-xs">
                    <button onClick={() => loadForEdit(a)} className="text-emerald-600 hover:underline">Edit</button>
                    <button onClick={() => setActive({ id: a._id, active: !a.active }).then(() => toast.success(a.active ? 'Deactivated.' : 'Activated.'))}
                      className="text-gray-600 hover:underline">{a.active ? 'Deactivate' : 'Activate'}</button>
                    <button onClick={() => duplicate({ id: a._id }).then(() => toast.success('Duplicated (inactive).'))}
                      className="text-gray-600 hover:underline">Duplicate</button>
                    <button onClick={() => setConfirmDelete(a._id)} className="text-red-500 hover:underline">Delete</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Delete confirm */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDelete(null)}>
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-2">Delete this announcement?</h3>
            <p className="text-sm text-gray-600 mb-4">This removes it and its dismissal records. This can&apos;t be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm">Cancel</button>
              <button onClick={() => { const id = confirmDelete; setConfirmDelete(null); remove({ id: id as any }).then(() => toast.success('Deleted.')).catch((e) => toast.error(e?.message ?? 'Failed.')) }}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
