import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { LANES } from '../lib/booking-data'

const LANE_LABEL = (id?: string) => (id ? (LANES.find(l => l.id === id)?.name ?? id) : 'General / facility')

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  resolved: 'bg-emerald-100 text-emerald-700',
  dismissed: 'bg-gray-100 text-gray-500',
}

export default function AdminFaultInbox() {
  const [filter, setFilter] = useState<'open' | 'resolved' | 'dismissed' | 'all'>('open')
  const reports = (useQuery(api.faults.listFaultReports, filter === 'all' ? {} : { status: filter }) ?? []) as any[]
  const updateStatus = useMutation(api.faults.updateFaultReportStatus)
  const [busyId, setBusyId] = useState<string | null>(null)

  const act = async (id: string, status: string, adminNote?: string) => {
    setBusyId(id)
    try {
      await updateStatus({ id: id as any, status, adminNote })
    } catch (e: any) {
      alert(e?.message ?? 'Failed to update report')
    } finally {
      setBusyId(null)
    }
  }

  const fmt = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Fault Reports</h2>
          <p className="text-sm text-gray-500 mt-0.5">Equipment &amp; facility issues reported by customers and coaches. Block a lane from the calendar if needed — reports never auto-block.</p>
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {(['open', 'resolved', 'dismissed', 'all'] as const).map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold capitalize transition-colors ${
                filter === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {reports.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-12 text-center">
          <div className="text-4xl mb-3">🛠️</div>
          <p className="text-gray-500">No {filter === 'all' ? '' : filter} fault reports.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map(r => (
            <div key={r._id} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[r.status] ?? STATUS_STYLES.open}`}>{r.status}</span>
                    <span className="text-sm font-semibold text-gray-800">{LANE_LABEL(r.laneId)}</span>
                    {r.category && <span className="text-[11px] text-gray-400 capitalize">· {r.category}</span>}
                  </div>
                  <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{r.details}</p>
                  <p className="text-xs text-gray-400 mt-2">
                    {r.reportedByName || r.reportedByEmail || 'Anonymous'} · {fmt(r.createdAt)}
                  </p>
                  {r.adminNote && <p className="text-xs text-gray-500 mt-1 italic">Note: {r.adminNote}</p>}
                </div>
                {r.photoUrl && (
                  <a href={r.photoUrl} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={r.photoUrl} alt="Issue" className="w-20 h-20 object-cover rounded-lg border border-gray-200" />
                  </a>
                )}
              </div>
              <div className="flex gap-2 mt-3 flex-wrap">
                {r.status !== 'resolved' && (
                  <button
                    onClick={() => act(r._id, 'resolved')}
                    disabled={busyId === r._id}
                    className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-semibold disabled:opacity-50"
                  >
                    ✓ Resolve
                  </button>
                )}
                {r.status !== 'dismissed' && (
                  <button
                    onClick={() => act(r._id, 'dismissed')}
                    disabled={busyId === r._id}
                    className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                )}
                {r.status !== 'open' && (
                  <button
                    onClick={() => act(r._id, 'open')}
                    disabled={busyId === r._id}
                    className="text-xs px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-700 font-semibold disabled:opacity-50"
                  >
                    Reopen
                  </button>
                )}
                <button
                  onClick={() => {
                    const note = prompt('Add / edit an admin note for this report:', r.adminNote ?? '')
                    if (note !== null) act(r._id, r.status, note)
                  }}
                  disabled={busyId === r._id}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-600 font-semibold disabled:opacity-50"
                >
                  Note
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
