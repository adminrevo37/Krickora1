import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { getErrorMessage } from '../lib/errors'
import CoachMultiSelect from './CoachMultiSelect'

/**
 * "My Athletes" — account-holder self-management of their child-athletes
 * (SPEC_PARENT_ATHLETE_MODEL). Lists the account's athletes (including the
 * self-athlete), lets the parent add a child, rename/remove, and assign coaches
 * per athlete.
 *
 * SPEC_SIGNUP_UPDATES_2026-06:
 *  - G3: athletes carry first + last name (both required).
 *  - G4: coach assignment uses the searchable CoachMultiSelect with an EXPLICIT
 *    Save/Cancel per athlete — taps now STAGE locally (an "unsaved changes"
 *    marker shows) and commit only on Save. Replaces the old auto-save-on-tap.
 */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort(), sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

export default function MyAthletesCard() {
  const athletes = useQuery(api.athletes.listAthletesByAccount, {}) ?? []
  const coaches = useQuery(api.queries.listCustomersByRole, { role: 'coach' }) ?? []
  const createAthlete = useMutation(api.athletes.createAthlete)
  const updateAthlete = useMutation(api.athletes.updateAthlete)
  const removeAthlete = useMutation(api.athletes.removeAthlete)
  const setAthleteCoaches = useMutation(api.athletes.setAthleteCoaches)

  const [newFirst, setNewFirst] = useState('')
  const [newLast, setNewLast] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editFirst, setEditFirst] = useState('')
  const [editLast, setEditLast] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  // Staged coach selections per athlete (G4). Absent → use the server value.
  const [coachDraft, setCoachDraft] = useState<Record<string, string[]>>({})
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const flash = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 4000)
  }

  const draftFor = (a: any): string[] => coachDraft[a._id] ?? (a.assignedCoachIds ?? [])
  const isDirty = (a: any): boolean => !sameSet(draftFor(a), a.assignedCoachIds ?? [])
  const setDraft = (a: any, ids: string[]) => setCoachDraft((prev) => ({ ...prev, [a._id]: ids }))
  const clearDraft = (a: any) =>
    setCoachDraft((prev) => { const next = { ...prev }; delete next[a._id]; return next })

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const firstName = newFirst.trim()
    const lastName = newLast.trim()
    if (!firstName || !lastName) {
      flash('error', 'Enter a first and last name.')
      return
    }
    setAdding(true)
    try {
      await createAthlete({ firstName, lastName })
      setNewFirst('')
      setNewLast('')
      flash('success', `Added ${firstName} ${lastName}`)
    } catch (err: any) {
      flash('error', getErrorMessage(err) ?? 'Failed to add athlete')
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (a: any) => {
    setEditingId(a._id)
    setEditFirst(a.firstName ?? a.name?.split(' ').slice(0, -1).join(' ') ?? a.name ?? '')
    setEditLast(a.lastName ?? a.name?.split(' ').slice(-1).join(' ') ?? '')
  }

  const handleRename = async (athleteId: string) => {
    const firstName = editFirst.trim()
    const lastName = editLast.trim()
    if (!firstName || !lastName) {
      flash('error', 'Enter a first and last name.')
      return
    }
    setBusyId(athleteId)
    try {
      await updateAthlete({ athleteId: athleteId as Id<'athletes'>, firstName, lastName })
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

  const saveCoaches = async (a: any) => {
    setBusyId(a._id)
    try {
      await setAthleteCoaches({ athleteId: a._id as Id<'athletes'>, coachIds: draftFor(a) })
      clearDraft(a)
      flash('success', 'Coaches updated')
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

        {athletes.map((a: any) => {
          const dirty = isDirty(a)
          return (
          <div key={a._id} className="rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between gap-2">
              {editingId === a._id ? (
                <div className="flex items-center gap-2 flex-1 flex-wrap">
                  <input
                    value={editFirst}
                    onChange={(e) => setEditFirst(e.target.value)}
                    placeholder="First name"
                    className="flex-1 min-w-[7rem] px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    autoFocus
                  />
                  <input
                    value={editLast}
                    onChange={(e) => setEditLast(e.target.value)}
                    placeholder="Last name"
                    className="flex-1 min-w-[7rem] px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
                      onClick={() => startEdit(a)}
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

            {/* Coach assignment — staged with explicit Save/Cancel (G4) */}
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Coaches</div>
                {dirty && (
                  <span className="text-[11px] font-medium text-amber-600">● Unsaved changes</span>
                )}
              </div>
              <CoachMultiSelect
                coaches={coaches}
                value={draftFor(a)}
                onChange={(ids) => setDraft(a, ids)}
                disabled={busyId === a._id}
              />
              {dirty && (
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={() => saveCoaches(a)}
                    disabled={busyId === a._id}
                    className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {busyId === a._id ? 'Saving…' : 'Save coaches'}
                  </button>
                  <button
                    onClick={() => clearDraft(a)}
                    disabled={busyId === a._id}
                    className="px-3 py-1.5 text-gray-500 text-sm hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
          )
        })}

        {/* Add child */}
        <form onSubmit={handleAdd} className="flex items-center gap-2 pt-1 flex-wrap">
          <input
            value={newFirst}
            onChange={(e) => setNewFirst(e.target.value)}
            placeholder="First name"
            className="flex-1 min-w-[7rem] px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <input
            value={newLast}
            onChange={(e) => setNewLast(e.target.value)}
            placeholder="Last name"
            className="flex-1 min-w-[7rem] px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <button
            type="submit"
            disabled={adding || !newFirst.trim() || !newLast.trim()}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium text-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
      </div>
    </div>
  )
}
