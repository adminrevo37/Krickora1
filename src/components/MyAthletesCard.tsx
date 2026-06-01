import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { getErrorMessage } from '../lib/errors'

/**
 * "My Athletes" — account-holder self-management of their child-athletes
 * (SPEC_PARENT_ATHLETE_MODEL). Lists the account's athletes (including the
 * self-athlete), lets the parent add a child, rename/remove, and assign coaches
 * per athlete. Replaces the old account-level "select your coach" control.
 */
export default function MyAthletesCard() {
  const athletes = useQuery(api.athletes.listAthletesByAccount, {}) ?? []
  const coaches = useQuery(api.queries.listCustomersByRole, { role: 'coach' }) ?? []
  const createAthlete = useMutation(api.athletes.createAthlete)
  const updateAthlete = useMutation(api.athletes.updateAthlete)
  const removeAthlete = useMutation(api.athletes.removeAthlete)
  const setAthleteCoaches = useMutation(api.athletes.setAthleteCoaches)

  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const flash = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 4000)
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setAdding(true)
    try {
      await createAthlete({ name })
      setNewName('')
      flash('success', `Added ${name}`)
    } catch (err: any) {
      flash('error', getErrorMessage(err) ?? 'Failed to add athlete')
    } finally {
      setAdding(false)
    }
  }

  const handleRename = async (athleteId: string) => {
    const name = editName.trim()
    if (!name) return
    setBusyId(athleteId)
    try {
      await updateAthlete({ athleteId: athleteId as Id<'athletes'>, name })
      setEditingId(null)
      flash('success', 'Name updated')
    } catch (err: any) {
      flash('error', getErrorMessage(err) ?? 'Failed to rename')
    } finally {
      setBusyId(null)
    }
  }

  const handleRemove = async (athleteId: string, name: string) => {
    if (!confirm(`Remove ${name}? Past bookings are kept; this only stops future allocations.`)) return
    setBusyId(athleteId)
    try {
      await removeAthlete({ athleteId: athleteId as Id<'athletes'> })
      flash('success', `Removed ${name}`)
    } catch (err: any) {
      flash('error', getErrorMessage(err) ?? 'Failed to remove')
    } finally {
      setBusyId(null)
    }
  }

  const toggleCoach = async (athlete: any, coachId: string) => {
    const current: string[] = athlete.assignedCoachIds ?? []
    const next = current.includes(coachId)
      ? current.filter((c) => c !== coachId)
      : [...current, coachId]
    setBusyId(athlete._id)
    try {
      await setAthleteCoaches({ athleteId: athlete._id as Id<'athletes'>, coachIds: next })
    } catch (err: any) {
      flash('error', getErrorMessage(err) ?? 'Failed to update coaches')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100">
        <h3 className="text-lg font-bold text-gray-800">My Athletes</h3>
        <p className="text-sm text-gray-500 mt-0.5">
          Add the people who train under this account and choose their coach(es). Coaches see the athlete's name and can allocate them to sessions.
        </p>
      </div>

      {message && (
        <div className={`px-6 py-2.5 text-sm ${message.type === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
          {message.text}
        </div>
      )}

      <div className="p-6 space-y-4">
        {athletes.length === 0 && (
          <p className="text-sm text-gray-400">No athletes yet. Add one below.</p>
        )}

        {athletes.map((a: any) => (
          <div key={a._id} className="rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between gap-2">
              {editingId === a._id ? (
                <div className="flex items-center gap-2 flex-1">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    autoFocus
                  />
                  <button
                    onClick={() => handleRename(a._id)}
                    disabled={busyId === a._id}
                    className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button onClick={() => setEditingId(null)} className="px-3 py-1.5 text-gray-500 text-sm">Cancel</button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-9 h-9 bg-emerald-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">
                      {a.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-800 truncate">
                        {a.name}
                        {a.isSelf && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium align-middle">You</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => { setEditingId(a._id); setEditName(a.name) }}
                      className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100"
                    >
                      Rename
                    </button>
                    {!a.isSelf && (
                      <button
                        onClick={() => handleRemove(a._id, a.name)}
                        disabled={busyId === a._id}
                        className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Coach assignment */}
            <div className="mt-3">
              <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Coaches</div>
              {coaches.length === 0 ? (
                <p className="text-xs text-gray-400">No coaches available yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {coaches.map((c: any) => {
                    const assigned = (a.assignedCoachIds ?? []).includes(c._id)
                    return (
                      <button
                        key={c._id}
                        onClick={() => toggleCoach(a, c._id)}
                        disabled={busyId === a._id}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors disabled:opacity-50 ${
                          assigned
                            ? 'bg-emerald-500 text-white border-emerald-500'
                            : 'bg-white text-gray-600 border-gray-300 hover:border-emerald-400'
                        }`}
                      >
                        {assigned ? '✓ ' : ''}{c.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Add child */}
        <form onSubmit={handleAdd} className="flex items-center gap-2 pt-1">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Add a child / athlete name"
            className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <button
            type="submit"
            disabled={adding || !newName.trim()}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium text-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
      </div>
    </div>
  )
}
