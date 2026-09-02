// SPEC_ANALYTICS_BUILD_2026-06 C2.1 — filterable, sortable, paginated bookings
// explorer with CSV export.
import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { type DateRange, downloadCsv, Loading, Empty, Section, KpiCard, BarRow } from './shared'

const LANES = [
  { id: '', name: 'All lanes' },
  { id: 'bm1', name: 'BM 1' }, { id: 'bm2', name: 'BM 2' }, { id: 'bm3', name: 'BM 3' },
  { id: 'ru1', name: 'RU 1' }, { id: 'ru2', name: 'RU 2' },
]

const fmtHour = (h: number) => {
  const whole = Math.floor(h); const mins = Math.round((h - whole) * 60)
  const period = whole >= 12 ? 'pm' : 'am'; const disp = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole
  return mins > 0 ? `${disp}:${String(mins).padStart(2, '0')}${period}` : `${disp}${period}`
}

export default function BookingsTab({ range }: { range: DateRange }) {
  const [laneId, setLaneId] = useState('')
  const [status, setStatus] = useState('')
  const [kind, setKind] = useState('')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(0)
  const pageSize = 50

  const data = useQuery(api.analyticsAdmin.queryBookings, {
    from: range.from || undefined,
    to: range.to || undefined,
    laneId: laneId || undefined,
    status: status || undefined,
    kind: kind || undefined,
    search: search.trim() || undefined,
    sortBy, sortDir, page, pageSize,
  })
  const cancel = useQuery(api.analyticsAdmin.getCancellationAnalytics, { from: range.from || undefined, to: range.to || undefined })

  const toggleSort = (col: string) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortBy(col); setSortDir('desc') }
    setPage(0)
  }

  const exportCsv = () => {
    if (!data) return
    const header = ['Date', 'Time', 'Lane', 'Variant', 'Customer', 'Email', 'Suburb', 'Type', 'Status', 'Price', 'Charge removed', 'Discount']
    const rows = data.rows.map((r: any) => [
      r.date, fmtHour(r.startHour), r.laneName, r.variant, r.customerName, r.customerEmail,
      r.suburb, r.isCoachBooking ? 'coach' : 'customer', r.status, r.price,
      r.statementExcluded ? 'yes' : '', r.discountCode,
    ])
    downloadCsv(`bookings_${range.from || 'all'}_${range.to || 'all'}.csv`, [header, ...rows])
  }

  const Th = ({ col, label, right }: { col?: string; label: string; right?: boolean }) => (
    <th className={`px-3 py-2.5 text-${right ? 'right' : 'left'} text-[11px] font-semibold text-gray-500 uppercase tracking-wide ${col ? 'cursor-pointer hover:text-gray-800 select-none' : ''}`}
      onClick={col ? () => toggleSort(col) : undefined}>
      {label}{col && sortBy === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  )

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1

  return (
    <div className="space-y-4">
      {/* Cancellation timing */}
      <CancellationPanel cancel={cancel} />

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-500">Lane
          <select value={laneId} onChange={(e) => { setLaneId(e.target.value); setPage(0) }}
            className="block mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm">
            {LANES.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-500">Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0) }}
            className="block mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm">
            <option value="">All</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
            <option value="pending_payment">Pending payment</option>
          </select>
        </label>
        <label className="text-xs text-gray-500">Type
          <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(0) }}
            className="block mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm">
            <option value="">All</option>
            <option value="customer">Customer</option>
            <option value="coach">Coach</option>
          </select>
        </label>
        <label className="text-xs text-gray-500 flex-1 min-w-[180px]">Search name / email
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} placeholder="e.g. jane@…"
            className="block w-full mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm" />
        </label>
        <button onClick={exportCsv} disabled={!data || data.rows.length === 0}
          className="px-3 py-2 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          Export CSV
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {!data ? <Loading /> : data.rows.length === 0 ? <Empty label="No bookings match these filters." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <Th col="date" label="Date" />
                  <Th label="Time" />
                  <Th label="Lane" />
                  <Th label="Variant" />
                  <Th col="name" label="Customer" />
                  <Th label="Suburb" />
                  <Th label="Type" />
                  <Th label="Status" />
                  <Th col="price" label="Price" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.rows.map((r: any) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{r.date}</td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtHour(r.startHour)}{r.additionalLanes > 0 ? ` +${r.additionalLanes}` : ''}</td>
                    <td className="px-3 py-2 text-gray-700">{r.laneName}</td>
                    <td className="px-3 py-2 text-gray-500">{r.variant || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">{r.customerName || '—'}</div>
                      <div className="text-[11px] text-gray-400">{r.customerEmail}</div>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{r.suburb || '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${r.isCoachBooking ? 'bg-violet-100 text-violet-700' : 'bg-emerald-100 text-emerald-700'}`}>
                        {r.isCoachBooking ? 'Coach' : 'Customer'}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${r.status === 'confirmed' ? 'bg-green-100 text-green-700' : r.status === 'cancelled' ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-600'}`}>
                        {r.status}
                      </span>
                    </td>
                    {/* Phase 4: a coach session whose charge the admin removed shows $0,
                        which is what the coach is billed — say WHY, or it reads as a bug. */}
                    <td className="px-3 py-2 text-right font-medium text-gray-800">
                      {r.statementExcluded ? (
                        <span title="Charge removed from the coach's statement — the coach is not billed for this session.">
                          $0 <span className="text-gray-400 font-normal">(removed)</span>
                        </span>
                      ) : r.price ? `$${r.price}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
            <span>{data.total} booking{data.total !== 1 ? 's' : ''} · page {page + 1} of {totalPages}</span>
            <div className="flex gap-2">
              <button disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50">‹ Prev</button>
              <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50">Next ›</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CancellationPanel({ cancel }: { cancel: any }) {
  // Inspector 2026-09-02: split coach vs customer, and add "when did they cancel
  // relative to when they BOOKED" alongside the original notice-before-session view.
  return (
    <Section title="Cancellations" subtitle="Split by who booked. Each side: notice before the session, time since the booking was made, and where in the wait the cancel landed.">
      {cancel === undefined ? <Loading /> : cancel === null ? <Empty label="Unavailable." /> : cancel.cancelled === 0 ? (
        <Empty label="No cancellations in range." />
      ) : (
        <div className="p-5 grid grid-cols-1 xl:grid-cols-2 gap-6">
          <CancelGroup title="Customers" icon="🏏" g={cancel.customer} />
          <CancelGroup title="Coaches" icon="🎓" g={cancel.coach} />
        </div>
      )}
    </Section>
  )
}

function CancelGroup({ title, icon, g }: { title: string; icon: string; g: any }) {
  const fmtH = (h: number) => (Math.abs(h) >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`)
  const notice = [
    { label: '> 48h before', value: g.noticeBuckets.gt48h, color: 'bg-emerald-600' },
    { label: '24–48h before', value: g.noticeBuckets.h24_48, color: 'bg-emerald-500' },
    { label: '6–24h before', value: g.noticeBuckets.h6_24, color: 'bg-blue-500' },
    { label: '2–6h before', value: g.noticeBuckets.h2_6, color: 'bg-amber-500' },
    { label: '< 2h before', value: g.noticeBuckets.lt2h, color: 'bg-red-500' },
    { label: 'after start', value: g.noticeBuckets.after_start, color: 'bg-gray-500' },
  ]
  const since = [
    { label: '< 1h after booking', value: g.sinceBookingBuckets.lt1h, color: 'bg-violet-600' },
    { label: '1–6h', value: g.sinceBookingBuckets.h1_6, color: 'bg-violet-500' },
    { label: '6–24h', value: g.sinceBookingBuckets.h6_24, color: 'bg-indigo-500' },
    { label: '1–3 days', value: g.sinceBookingBuckets.d1_3, color: 'bg-blue-500' },
    { label: '3–7 days', value: g.sinceBookingBuckets.d3_7, color: 'bg-sky-500' },
    { label: '> 7 days', value: g.sinceBookingBuckets.gt7d, color: 'bg-cyan-500' },
  ]
  const position = [
    { label: 'First quarter of the wait', value: g.positionBuckets.q1, color: 'bg-emerald-500' },
    { label: 'Second quarter', value: g.positionBuckets.q2, color: 'bg-lime-500' },
    { label: 'Third quarter', value: g.positionBuckets.q3, color: 'bg-amber-500' },
    { label: 'Last quarter', value: g.positionBuckets.q4, color: 'bg-red-500' },
    { label: 'After the session started', value: g.positionBuckets.after, color: 'bg-gray-500' },
  ]
  const max = (rows: { value: number }[]) => rows.reduce((m, r) => Math.max(m, r.value), 0)
  const whoTotal = g.who.self + g.who.admin + g.who.system + g.who.unknown
  const pct = (n: number) => (whoTotal > 0 ? Math.round((n / whoTotal) * 100) : 0)
  return (
    <div className="space-y-4">
      <h4 className="text-sm font-bold text-gray-800">{icon} {title}</h4>
      {g.cancelled === 0 ? <Empty label={`No ${title.toLowerCase()} cancellations in range.`} /> : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <KpiCard label="Cancellations" value={String(g.cancelled)} sub={`${g.cancellationRatePct}% of ${g.base} bookings${g.clubCancelled ? ` · ${g.clubCancelled} club` : ''}`} tone="red" />
            <KpiCard label="Median notice" value={fmtH(g.medianNoticeHours)} sub="before session start" tone="blue" />
            <KpiCard label={`Late (< ${g.lateWindowHours}h)`} value={`${g.lateCancelPct}%`} sub={`${g.withinLateWindow} inside window${g.lateCharged ? ` · ${g.lateCharged} charged` : ''}`} tone="amber" />
            <KpiCard label="Median time held" value={fmtH(g.medianSinceBookingHours)} sub={`booked → cancelled · at ${g.medianPositionPct}% of the wait`} tone="violet" />
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-1.5">Notice before the session</p>
            <div className="space-y-1.5">{notice.map((r) => <BarRow key={r.label} label={r.label} value={r.value} max={max(notice)} color={r.color} />)}</div>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-1.5">Time between booking and cancelling</p>
            <div className="space-y-1.5">{since.map((r) => <BarRow key={r.label} label={r.label} value={r.value} max={max(since)} color={r.color} />)}</div>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-1.5">Where in the wait they cancelled</p>
            <div className="space-y-1.5">{position.map((r) => <BarRow key={r.label} label={r.label} value={r.value} max={max(position)} color={r.color} />)}</div>
            <p className="text-[11px] text-gray-400 mt-1.5">
              Cancelled bookings were made a median {fmtH(g.medianBookingLeadHoursCancelled)} ahead; kept bookings {fmtH(g.medianBookingLeadHoursKept)} ahead.
            </p>
          </div>
          {g.abandonedCheckouts > 0 && (
            <p className="text-[11px] text-gray-400">
              Plus <strong className="text-gray-600">{g.abandonedCheckouts}</strong> abandoned checkouts (unpaid, auto-released) — not counted as cancellations.
            </p>
          )}
          <div className="text-xs text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
            <span className="font-semibold text-gray-500 uppercase text-[11px]">Who cancelled</span>
            <span>Self <strong>{g.who.self}</strong> ({pct(g.who.self)}%)</span>
            <span>Admin <strong>{g.who.admin}</strong> ({pct(g.who.admin)}%)</span>
            <span>Closure / block <strong>{g.who.system}</strong> ({pct(g.who.system)}%)</span>
            {g.who.unknown > 0 && <span className="text-gray-400">Unrecorded {g.who.unknown}</span>}
          </div>
        </>
      )}
    </div>
  )
}
