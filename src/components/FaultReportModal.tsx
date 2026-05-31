import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { LANES } from '../lib/booking-data'

/**
 * Customer / coach "Report an issue" form (SPEC_ADMIN_AND_SETTINGS #5).
 * Submits to the admin fault inbox. Optional photo via Convex storage.
 */
export default function FaultReportModal({ onClose }: { onClose: () => void }) {
  const submit = useMutation(api.faults.submitFaultReport)
  const generateUploadUrl = useMutation(api.faults.generateUploadUrl)

  const [laneId, setLaneId] = useState('')
  const [category, setCategory] = useState('equipment')
  const [details, setDetails] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const handleSubmit = async () => {
    setError(null)
    if (!details.trim()) { setError('Please describe the issue.'); return }
    setBusy(true)
    try {
      let photoStorageId: string | undefined
      if (photo) {
        const uploadUrl = await generateUploadUrl({})
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': photo.type },
          body: photo,
        })
        if (!res.ok) throw new Error('Photo upload failed.')
        const { storageId } = await res.json()
        photoStorageId = storageId
      }
      await submit({
        laneId: laneId || undefined,
        category,
        details: details.trim(),
        photoStorageId: photoStorageId as any,
      })
      setDone(true)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to submit report.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">🛠️ Report an Issue</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {done ? (
          <div className="text-center py-6">
            <div className="text-4xl mb-3">✅</div>
            <p className="text-sm text-gray-700 dark:text-gray-300">Thanks — your report has been sent to the team.</p>
            <button onClick={onClose} className="mt-5 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold">Done</button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-gray-500 dark:text-gray-400">Report broken equipment or a facility problem. The team will review it.</p>

            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Lane <span className="text-gray-400 font-normal">(optional)</span></span>
              <select value={laneId} onChange={e => setLaneId(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800">
                <option value="">General / facility</option>
                {LANES.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Type</span>
              <select value={category} onChange={e => setCategory(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800">
                <option value="equipment">Equipment</option>
                <option value="facility">Facility</option>
                <option value="other">Other</option>
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">What's wrong?</span>
              <textarea
                value={details}
                onChange={e => setDetails(e.target.value)}
                rows={4}
                placeholder="e.g. Bowling machine in BM2 not feeding balls."
                className="mt-1 w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Photo <span className="text-gray-400 font-normal">(optional)</span></span>
              <input
                type="file"
                accept="image/*"
                onChange={e => setPhoto(e.target.files?.[0] ?? null)}
                className="mt-1 w-full text-sm text-gray-600 dark:text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-gray-100 file:text-gray-700 file:text-sm file:font-semibold"
              />
            </label>

            {error && <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-lg p-2">{error}</div>}

            <div className="flex gap-2 pt-1">
              <button onClick={onClose} disabled={busy} className="flex-1 text-sm px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold hover:bg-gray-200 disabled:opacity-50">Cancel</button>
              <button onClick={handleSubmit} disabled={busy} className="flex-1 text-sm px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-semibold disabled:opacity-50">
                {busy ? 'Sending…' : 'Submit Report'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
