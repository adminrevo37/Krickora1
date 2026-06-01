import { useState, useCallback, useEffect } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import { formatTime, type AthleteSlot } from '../lib/booking-data'

interface AthleteAllocationEditorProps {
  bookingStartHour: number
  bookingDuration: number // in minutes
  currentSlots: AthleteSlot[]
  coachId: string // The coach's customer _id or email to fetch their athletes
  onSave: (slots: AthleteSlot[], opts?: { confirmedOverride?: boolean }) => Promise<{ success: boolean; error?: string; conflict?: boolean }>
  onClose: () => void
  bottomSheet?: boolean // render as a mobile bottom sheet instead of a centred modal
  defaultSessionDuration?: number // coach's preferred default slot length in minutes
  athleteCapacity?: number // coach's max athletes per session (1-4) — drives auto-populate
}

// Bug #6: snap an hour value to the nearest quarter to avoid float drift
// (e.g. 9.5000000001). All slot start times pass through this.
const roundToQuarter = (h: number) => Math.round(h * 4) / 4

export default function AthleteAllocationEditor({
  bookingStartHour,
  bookingDuration,
  currentSlots,
  coachId,
  onSave,
  onClose,
  bottomSheet = false,
  defaultSessionDuration,
  athleteCapacity,
}: AthleteAllocationEditorProps) {
  const bookingEndHour = bookingStartHour + bookingDuration / 60
  // Use the coach's configured default session duration, capped at the booking length.
  const defaultSlotDuration = Math.min(defaultSessionDuration ?? 60, bookingDuration)

  // Part 2.5 — auto-populate: lay out up to `athleteCapacity` empty slots
  // back-to-back at the preferred interval, starting at booking start (capped to
  // the window). The coach just picks who goes in each pre-made slot, and can
  // delete/shift to insert rest-break gaps. Capacity 1 = a single 1:1 slot.
  const buildAutoSlots = (): AthleteSlot[] => {
    const cap = Math.max(1, Math.min(athleteCapacity ?? 1, 4))
    const out: AthleteSlot[] = []
    let cursor = bookingStartHour
    for (let i = 0; i < cap; i++) {
      const remaining = Math.round((bookingEndHour - cursor) * 60)
      if (remaining < 15) break
      const dur = Math.min(defaultSlotDuration, remaining)
      out.push({ athleteName: '', startHour: roundToQuarter(cursor), durationMinutes: dur })
      cursor += dur / 60
    }
    return out.length > 0 ? out : [{ athleteName: '', startHour: bookingStartHour, durationMinutes: defaultSlotDuration }]
  }

  const [slots, setSlots] = useState<AthleteSlot[]>(
    currentSlots.length > 0 ? currentSlots.map(s => ({ ...s })) : buildAutoSlots()
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  // Auto-open the dropdown for slot 0 when opening a new (unallocated) booking
  const [activeDropdown, setActiveDropdown] = useState<number | null>(currentSlots.length === 0 ? 0 : null)
  const [loadingTimedOut, setLoadingTimedOut] = useState(false)
  // Review mode: when athletes are already allocated, show a clean read-only summary
  // so coaches can quickly confirm without accidentally editing anything
  const [reviewMode, setReviewMode] = useState(currentSlots.length > 0)
  // Bug #3: same-athlete double-booking warning (coach confirms to proceed).
  const [conflictWarning, setConflictWarning] = useState<string | null>(null)
  // Part 4: coach-managed roster — add an athlete by parent email + child name.
  const [showAddAthlete, setShowAddAthlete] = useState(false)
  const [addParentEmail, setAddParentEmail] = useState('')
  const [addChildName, setAddChildName] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addFeedback, setAddFeedback] = useState<string | null>(null)

  // Fetch athletes assigned to this coach from Convex
  const athletes = useQuery(api.queries.listAthletesByCoach, coachId ? { coachId } : "skip")
  const addAthleteToCoach = useMutation(api.athletes.addAthleteToCoach)
  const removeAthleteFromCoach = useMutation(api.athletes.removeAthleteFromCoach)

  const handleAddAthlete = async () => {
    const email = addParentEmail.trim()
    const child = addChildName.trim()
    if (!email || !child) { setAddFeedback('Enter both the parent email and the athlete name.'); return }
    setAddBusy(true)
    setAddFeedback(null)
    try {
      const res = await addAthleteToCoach({ coachId, parentEmail: email, childName: child })
      setAddFeedback(res?.accountExists ? `Added ${child} — they're now in your list.` : `Invite sent to ${email}.`)
      setAddParentEmail('')
      setAddChildName('')
      if (res?.accountExists) setShowAddAthlete(false)
    } catch (err: any) {
      setAddFeedback(getErrorMessage(err) ?? 'Could not add athlete.')
    } finally {
      setAddBusy(false)
    }
  }

  const handleRemoveFromRoster = async (athleteId: string, name: string) => {
    if (!confirm(`Remove ${name} from your roster? Past bookings are unaffected; they just won't appear when allocating future sessions.`)) return
    try {
      await removeAthleteFromCoach({ coachId, athleteId: athleteId as any })
    } catch (err: any) {
      alert(getErrorMessage(err) ?? 'Could not remove athlete.')
    }
  }

  // Timeout for loading state — if athletes haven't loaded in 5 seconds, show fallback
  useEffect(() => {
    if (athletes !== undefined) {
      setLoadingTimedOut(false)
      return
    }
    const timer = setTimeout(() => setLoadingTimedOut(true), 5000)
    return () => clearTimeout(timer)
  }, [athletes])

  const getValidStartTimes = useCallback(() => {
    const times: number[] = []
    for (let h = bookingStartHour; h < bookingEndHour - 0.001; h += 0.25) {
      times.push(roundToQuarter(h))
    }
    return times
  }, [bookingStartHour, bookingEndHour])

  const getValidDurations = useCallback((startHour: number) => {
    const maxMinutes = Math.round((bookingEndHour - startHour) * 60)
    const durations: number[] = []
    for (let m = 15; m <= maxMinutes; m += 15) {
      durations.push(m)
    }
    return durations
  }, [bookingEndHour])

  const getSelectedAthleteNames = useCallback((excludeIndex: number) => {
    return slots
      .filter((_, i) => i !== excludeIndex)
      .map(s => s.athleteName.toLowerCase().trim())
      .filter(Boolean)
  }, [slots])

  const addSlot = () => {
    setSlots([...slots, {
      athleteName: '',
      startHour: bookingStartHour,
      durationMinutes: defaultSlotDuration,
    }])
    setError(null)
    setSuccessMsg(null)
    setActiveDropdown(slots.length)
    setSearchQuery('')
  }

  const removeSlot = (index: number) => {
    setSlots(slots.filter((_, i) => i !== index))
    setError(null)
    setSuccessMsg(null)
    if (activeDropdown !== null && activeDropdown >= index) {
      setActiveDropdown(null)
      setSearchQuery('')
    }
  }

  const selectAthlete = (index: number, athlete: { _id: string; name: string }) => {
    const updated = [...slots]
    updated[index] = {
      ...updated[index],
      athleteId: athlete._id,
      athleteName: athlete.name,
    }
    setSlots(updated)
    setActiveDropdown(null)
    setSearchQuery('')
    setError(null)
    setSuccessMsg(null)
  }

  const updateSlot = (index: number, field: 'startHour' | 'durationMinutes', value: number) => {
    const updated = [...slots]
    const oldSlot = updated[index]
    if (field === 'startHour') {
      const newStart = roundToQuarter(value)
      const maxDur = Math.round((bookingEndHour - newStart) * 60)
      const newDur = Math.min(oldSlot.durationMinutes, maxDur)
      updated[index] = {
        ...oldSlot,
        startHour: newStart,
        durationMinutes: Math.max(15, newDur),
      }
    } else if (field === 'durationMinutes') {
      updated[index] = {
        ...oldSlot,
        durationMinutes: value,
      }
    }
    setSlots(updated)
    setError(null)
    setSuccessMsg(null)
  }

  const validate = (): string | null => {
    // Empty (unselected) slots are auto-populate placeholders — they are ignored
    // on save, not errors. Only validate filled slots.
    const filled = slots.filter(s => s.athleteName.trim())
    for (const s of filled) {
      if (s.startHour < bookingStartHour) return `${s.athleteName}'s start time is before the booking starts.`
      const slotEnd = s.startHour + s.durationMinutes / 60
      if (slotEnd > bookingEndHour + 0.001) return `${s.athleteName}'s session extends past the booking end.`
      if (s.durationMinutes < 15) return `${s.athleteName}'s session must be at least 15 minutes.`
    }
    const names = filled.map(s => s.athleteName.toLowerCase().trim())
    const uniqueNames = new Set(names)
    if (uniqueNames.size !== names.length) return 'Each athlete can only be allocated once.'
    return null
  }

  const handleSave = async (confirmedOverride = false) => {
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    setSaving(true)
    setError(null)
    setSuccessMsg(null)
    if (!confirmedOverride) setConflictWarning(null)
    const cleanSlots = slots.filter(s => s.athleteName.trim()).map(s => ({
      athleteId: s.athleteId,
      athleteName: s.athleteName.trim(),
      startHour: s.startHour,
      durationMinutes: s.durationMinutes,
    }))
    const result = await onSave(cleanSlots, { confirmedOverride })
    setSaving(false)
    if (result.success) {
      setConflictWarning(null)
      setSuccessMsg('Athlete allocations saved!')
      setTimeout(() => onClose(), 1200)
    } else if (result.conflict) {
      // Bug #3: soft warning — coach can confirm to proceed.
      setConflictWarning(result.error ?? 'This athlete is already booked at that time.')
    } else {
      setError(result.error ?? 'Failed to save.')
    }
  }

  const totalAthleteMinutes = slots.reduce((sum, s) => sum + s.durationMinutes, 0)
  const validStartTimes = getValidStartTimes()

  const getSlotPosition = (startHour: number, durationMinutes: number) => {
    const totalMinutes = bookingDuration
    const offsetMinutes = (startHour - bookingStartHour) * 60
    const left = (offsetMinutes / totalMinutes) * 100
    const width = (durationMinutes / totalMinutes) * 100
    return { left: `${left}%`, width: `${width}%` }
  }

  const slotColors = [
    'bg-orange-400 dark:bg-orange-500',
    'bg-blue-400 dark:bg-blue-500',
    'bg-emerald-400 dark:bg-emerald-500',
    'bg-purple-400 dark:bg-purple-500',
    'bg-pink-400 dark:bg-pink-500',
    'bg-cyan-400 dark:bg-cyan-500',
    'bg-amber-400 dark:bg-amber-500',
    'bg-indigo-400 dark:bg-indigo-500',
  ]

  const getFilteredAthletes = (slotIndex: number) => {
    const selectedNames = getSelectedAthleteNames(slotIndex)
    const available = (athletes ?? []).filter(
      a => !selectedNames.includes(a.name.toLowerCase().trim())
    )
    if (!searchQuery.trim()) return available
    return available.filter(a =>
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.email.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }

  const availableAthleteCount = (athletes ?? []).length - slots.filter(s => s.athleteName.trim()).length
  const isLoading = athletes === undefined && !loadingTimedOut

  return (
    <div className={`fixed inset-0 z-50 bg-black/50 backdrop-blur-sm ${bottomSheet ? 'flex items-end' : 'flex items-center justify-center p-4'}`} onClick={onClose}>
      <div className={`bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-y-auto ${bottomSheet ? 'rounded-t-2xl w-full max-h-[88vh]' : 'rounded-2xl w-full max-w-lg max-h-[90vh]'}`} onClick={e => e.stopPropagation()}>
        {/* Drag handle — sheet mode only */}
        {bottomSheet && (
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
          </div>
        )}
        {/* Header */}
        <div className={`sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 p-4 z-10 ${bottomSheet ? '' : 'rounded-t-2xl'}`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-800 dark:text-gray-200 flex items-center gap-2">
                🏏 Athlete Allocations
                {reviewMode && slots.length > 0 && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 font-semibold">✓ Allocated</span>
                )}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {formatTime(bookingStartHour)} – {formatTime(bookingEndHour)} · {bookingDuration}min booking
              </p>
            </div>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 transition-colors">✕</button>
          </div>
        </div>

        {/* ── REVIEW MODE: clean read-only summary ── */}
        {reviewMode && (
          <div className="p-4 space-y-4">
            {/* Timeline */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Session Timeline</span>
                <span className="text-[11px] text-gray-400">{slots.length} athlete{slots.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="relative bg-gray-100 dark:bg-gray-800 rounded-xl h-12 overflow-hidden">
                {/* Time markers */}
                {Array.from({ length: Math.ceil(bookingDuration / 30) + 1 }, (_, i) => {
                  const markerHour = bookingStartHour + (i * 30) / 60
                  if (markerHour > bookingEndHour + 0.01) return null
                  const pos = ((i * 30) / bookingDuration) * 100
                  return (
                    <div key={i} className="absolute top-0 h-full flex flex-col items-start" style={{ left: `${Math.min(pos, 98)}%` }}>
                      <div className="w-px h-3 bg-gray-300 dark:bg-gray-600" />
                      <span className="text-[8px] text-gray-400 mt-0.5 pl-0.5">{formatTime(markerHour)}</span>
                    </div>
                  )
                })}
                {/* Athlete blocks */}
                {slots.map((slot, i) => {
                  if (!slot.athleteName.trim()) return null
                  const totalMinutes = bookingDuration
                  const offsetMinutes = (slot.startHour - bookingStartHour) * 60
                  const left = (offsetMinutes / totalMinutes) * 100
                  const width = (slot.durationMinutes / totalMinutes) * 100
                  return (
                    <div
                      key={i}
                      className={`absolute top-3.5 h-6 ${slotColors[i % slotColors.length]} rounded-lg text-[10px] text-white font-semibold flex items-center justify-center overflow-hidden px-2 shadow-sm`}
                      style={{ left: `${left}%`, width: `${Math.max(width, 6)}%`, minWidth: '2.5rem' }}
                      title={`${slot.athleteName}: ${formatTime(slot.startHour)}–${formatTime(slot.startHour + slot.durationMinutes / 60)}`}
                    >
                      <span className="truncate">{slot.athleteName.split(' ')[0]}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Athlete cards */}
            <div className="space-y-2">
              {slots.map((slot, i) => (
                <div key={i} className="flex items-center gap-3 bg-gray-50 dark:bg-gray-800/60 rounded-xl px-3 py-2.5 border border-gray-100 dark:border-gray-700">
                  <div className={`w-8 h-8 ${slotColors[i % slotColors.length]} rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0`}>
                    {slot.athleteName.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{slot.athleteName}</div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
                      {formatTime(slot.startHour)} – {formatTime(slot.startHour + slot.durationMinutes / 60)}
                      <span className="ml-1.5 text-gray-400">· {slot.durationMinutes}min</span>
                    </div>
                  </div>
                  <span className="text-emerald-500 text-base shrink-0">✓</span>
                </div>
              ))}
            </div>

            {/* Success message */}
            {successMsg && (
              <div className="flex items-center gap-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-3 border border-emerald-200 dark:border-emerald-800/50">
                <span>✅</span>
                <p className="text-sm text-emerald-700 dark:text-emerald-400">{successMsg}</p>
              </div>
            )}
          </div>
        )}

        {/* ── EDIT MODE: full allocation editor ── */}
        {!reviewMode && (
        <div className="p-4 space-y-4">
          {/* Loading state */}
          {isLoading && (
            <div className="flex items-center justify-center py-6 gap-2 text-sm text-gray-400">
              <span className="animate-spin">⏳</span> Loading your athletes...
            </div>
          )}

          {/* Timed out — no athletes found or coachId issue */}
          {loadingTimedOut && athletes === undefined && (
            <div className="bg-amber-50 dark:bg-amber-900/10 rounded-xl p-4 border border-amber-200 dark:border-amber-800/30 text-center">
              <div className="text-2xl mb-2">⚠️</div>
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">Could not load athletes</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Please check your connection and try again. If the issue persists, athletes may need to assign you as their coach in their profile.
              </p>
            </div>
          )}

          {/* Empty state — query resolved but no athletes */}
          {athletes !== undefined && athletes.length === 0 && (
            <div className="bg-amber-50 dark:bg-amber-900/10 rounded-xl p-4 border border-amber-200 dark:border-amber-800/30 text-center">
              <div className="text-2xl mb-2">👥</div>
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">No athletes assigned</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Athletes need to select you as their coach in their profile before they appear here.
              </p>
            </div>
          )}

          {/* Timeline visualization */}
          {slots.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Timeline</div>
              <div className="relative bg-gray-100 dark:bg-gray-800 rounded-lg h-10 overflow-hidden">
                {Array.from({ length: Math.ceil(bookingDuration / 30) + 1 }, (_, i) => {
                  const markerHour = bookingStartHour + (i * 30) / 60
                  if (markerHour > bookingEndHour) return null
                  const pos = ((i * 30) / bookingDuration) * 100
                  return (
                    <div key={i} className="absolute top-0 h-full flex flex-col items-center" style={{ left: `${pos}%` }}>
                      <div className="w-px h-2 bg-gray-300 dark:bg-gray-600" />
                      <span className="text-[8px] text-gray-400 mt-0.5 -translate-x-1/2">{formatTime(markerHour)}</span>
                    </div>
                  )
                })}
                {slots.map((slot, i) => {
                  if (!slot.athleteName.trim()) return null
                  const pos = getSlotPosition(slot.startHour, slot.durationMinutes)
                  return (
                    <div
                      key={i}
                      className={`absolute top-1 h-5 ${slotColors[i % slotColors.length]} rounded text-[9px] text-white font-semibold flex items-center justify-center overflow-hidden px-1 shadow-sm`}
                      style={{ left: pos.left, width: pos.width, minWidth: '2px' }}
                      title={`${slot.athleteName}: ${formatTime(slot.startHour)}–${formatTime(slot.startHour + slot.durationMinutes / 60)}`}
                    >
                      <span className="truncate">{slot.athleteName}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Athlete slots */}
          <div className="space-y-3">
            {slots.map((slot, index) => {
              const filteredAthletes = getFilteredAthletes(index)
              const isDropdownOpen = activeDropdown === index

              return (
                <div key={index} className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 border border-gray-200 dark:border-gray-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`w-3 h-3 rounded-full ${slotColors[index % slotColors.length]}`} />
                      <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">Athlete {index + 1}</span>
                    </div>
                    <button onClick={() => removeSlot(index)} className="text-xs text-red-400 hover:text-red-600 transition-colors px-2 py-0.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20">Remove</button>
                  </div>

                  {/* Athlete selector */}
                  <div className="relative">
                    {slot.athleteName.trim() ? (
                      <div className="flex items-center justify-between bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className={`w-7 h-7 ${slotColors[index % slotColors.length]} rounded-full flex items-center justify-center text-white text-xs font-bold`}>
                            {slot.athleteName.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{slot.athleteName}</div>
                            {athletes && (() => {
                              const match = athletes.find(a => a.name === slot.athleteName)
                              return match ? <div className="text-[10px] text-gray-400">{match.email}</div> : null
                            })()}
                          </div>
                        </div>
                        <button
                          onClick={() => { setActiveDropdown(index); setSearchQuery('') }}
                          className="text-xs text-orange-500 hover:text-orange-700 dark:hover:text-orange-300 font-medium transition-colors"
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setActiveDropdown(isDropdownOpen ? null : index); setSearchQuery('') }}
                        className="w-full px-3 py-2.5 text-sm bg-white dark:bg-gray-900 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-400 hover:border-orange-400 hover:text-orange-500 dark:hover:border-orange-500 dark:hover:text-orange-400 transition-all text-left flex items-center gap-2"
                      >
                        <span className="text-base">👤</span> Select an athlete...
                      </button>
                    )}

                    {/* Dropdown */}
                    {isDropdownOpen && (
                      <>
                      <div className="fixed inset-0 z-10" onClick={() => { setActiveDropdown(null); setSearchQuery('') }} />
                      <div className="relative mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-20 max-h-64 flex flex-col overflow-hidden">
                        <div className="p-2 border-b border-gray-100 dark:border-gray-800">
                          <div className="relative">
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
                            <input
                              type="text"
                              value={searchQuery}
                              onChange={e => setSearchQuery(e.target.value)}
                              placeholder="Search athletes..."
                              className="w-full pl-8 pr-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none text-gray-800 dark:text-gray-200 placeholder-gray-400"
                              autoFocus
                            />
                          </div>
                        </div>
                        <div className="overflow-y-auto flex-1">
                          {filteredAthletes.length === 0 ? (
                            <div className="p-4 text-center text-xs text-gray-400">
                              {searchQuery ? 'No athletes match your search' : 'No more athletes available'}
                            </div>
                          ) : (
                            filteredAthletes.map(athlete => (
                              <button
                                key={athlete._id}
                                onClick={() => selectAthlete(index, athlete)}
                                className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-colors text-left group"
                              >
                                <div className="w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 group-hover:scale-105 transition-transform">
                                  {athlete.name.charAt(0).toUpperCase()}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{athlete.name}</div>
                                  <div className="text-[10px] text-gray-400 truncate">{athlete.email}</div>
                                </div>
                                <span className="text-orange-500 opacity-0 group-hover:opacity-100 transition-opacity text-xs">Select</span>
                              </button>
                            ))
                          )}
                        </div>
                        <div className="p-1.5 border-t border-gray-100 dark:border-gray-800">
                          <button
                            onClick={() => { setActiveDropdown(null); setSearchQuery('') }}
                            className="w-full py-1.5 text-xs text-gray-500 hover:text-gray-700 font-medium transition-colors rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
                          >
                            Close
                          </button>
                        </div>
                      </div>
                      </>
                    )}
                  </div>

                  {/* Start time & Duration */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1 block">Start Time</label>
                      <select
                        value={slot.startHour}
                        onChange={e => updateSlot(index, 'startHour', parseFloat(e.target.value))}
                        className="w-full px-2 py-1.5 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none text-gray-800 dark:text-gray-200"
                      >
                        {validStartTimes.map(h => (
                          <option key={h} value={h}>{formatTime(h)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1 block">Duration</label>
                      <select
                        value={slot.durationMinutes}
                        onChange={e => updateSlot(index, 'durationMinutes', parseInt(e.target.value))}
                        className="w-full px-2 py-1.5 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none text-gray-800 dark:text-gray-200"
                      >
                        {getValidDurations(slot.startHour).map(d => (
                          <option key={d} value={d}>{d}min</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="text-[10px] text-gray-400 dark:text-gray-500">
                    {formatTime(slot.startHour)} – {formatTime(slot.startHour + slot.durationMinutes / 60)}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Add athlete button */}
          {(athletes !== undefined && athletes.length > 0 && availableAthleteCount > 0) && (
            <button
              onClick={addSlot}
              className="w-full py-2.5 border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl text-sm font-semibold text-gray-500 dark:text-gray-400 hover:border-orange-400 hover:text-orange-500 dark:hover:border-orange-500 dark:hover:text-orange-400 transition-all flex items-center justify-center gap-2"
            >
              <span className="text-lg">+</span> Add another athlete — group booking ({availableAthleteCount} available)
            </button>
          )}

          {athletes !== undefined && athletes.length > 0 && availableAthleteCount <= 0 && slots.length > 0 && (
            <div className="text-center text-xs text-gray-400 py-1">All your athletes have been allocated</div>
          )}

          {/* Summary */}
          {slots.length > 0 && (
            <div className="bg-orange-50 dark:bg-orange-900/10 rounded-xl p-3 border border-orange-200 dark:border-orange-800/30">
              <div className="flex items-center justify-between text-sm">
                <span className="text-orange-700 dark:text-orange-400 font-medium">{slots.filter(s => s.athleteName.trim()).length} athlete{slots.filter(s => s.athleteName.trim()).length !== 1 ? 's' : ''}</span>
                <span className="text-orange-600 dark:text-orange-400 font-semibold">{totalAthleteMinutes}min total</span>
              </div>
              {totalAthleteMinutes > bookingDuration && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">⚠️ Overlapping slots — athletes share lane time</p>
              )}
            </div>
          )}

          {/* Part 4 — coach-managed roster: add an athlete who isn't in the list yet */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
            {!showAddAthlete ? (
              <button
                onClick={() => { setShowAddAthlete(true); setAddFeedback(null) }}
                className="w-full py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-orange-500 transition-colors flex items-center justify-center gap-1.5"
              >
                <span className="text-sm">＋</span> Add a new athlete to your list
              </button>
            ) : (
              <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 border border-gray-200 dark:border-gray-700 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">Add an athlete</span>
                  <button onClick={() => setShowAddAthlete(false)} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
                </div>
                <p className="text-[10px] text-gray-400">If they already have an account we'll add them straight away; otherwise we email the parent an invite to register.</p>
                <input
                  value={addChildName}
                  onChange={e => setAddChildName(e.target.value)}
                  placeholder="Athlete name"
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none text-gray-800 dark:text-gray-200 placeholder-gray-400"
                />
                <input
                  value={addParentEmail}
                  onChange={e => setAddParentEmail(e.target.value)}
                  type="email"
                  placeholder="Parent / account email"
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none text-gray-800 dark:text-gray-200 placeholder-gray-400"
                />
                <button
                  onClick={handleAddAthlete}
                  disabled={addBusy}
                  className="w-full py-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-300 text-white font-semibold text-sm rounded-lg transition-colors"
                >
                  {addBusy ? 'Adding…' : 'Add athlete'}
                </button>
                {addFeedback && <p className="text-[11px] text-gray-600 dark:text-gray-300">{addFeedback}</p>}
              </div>
            )}
          </div>

          {/* Bug #3 — same-athlete double-booking warning (coach confirms to proceed) */}
          {conflictWarning && (
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 border border-amber-300 dark:border-amber-700/50 space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-base">⚠️</span>
                <p className="text-xs text-amber-800 dark:text-amber-300">{conflictWarning} Allocate them anyway?</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setConflictWarning(null)} className="flex-1 px-3 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">Cancel</button>
                <button onClick={() => handleSave(true)} disabled={saving} className="flex-1 px-3 py-1.5 text-xs font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-lg disabled:opacity-60">Proceed anyway</button>
              </div>
            </div>
          )}

        </div>
        )} {/* end !reviewMode */}

        {/* Footer */}
        <div className={`sticky bottom-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 p-4 z-10 ${bottomSheet ? 'pb-safe' : 'rounded-b-2xl'}`}>
          {reviewMode ? (
            /* Review mode footer */
            <div className="flex items-center gap-3">
              <button
                onClick={() => setReviewMode(false)}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-700 hover:bg-orange-50 dark:hover:bg-orange-900/20 rounded-xl transition-colors"
              >
                ✏️ Edit Allocations
              </button>
              <button
                onClick={onClose}
                className="flex-[2] px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-sm rounded-xl shadow-md transition-all active:scale-95"
              >
                ✓ Looks Correct
              </button>
            </div>
          ) : (
            /* Edit mode footer */
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  if (currentSlots.length > 0) {
                    setSlots(currentSlots.map(s => ({ ...s })))
                    setReviewMode(true)
                    setError(null)
                  } else {
                    onClose()
                  }
                }}
                className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors"
              >
                {currentSlots.length > 0 ? '← Back' : 'Cancel'}
              </button>
              <button
                onClick={() => handleSave()}
                disabled={saving}
                className="flex-1 px-6 py-2.5 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-bold text-sm rounded-xl shadow-md transition-all disabled:cursor-not-allowed active:scale-95"
              >
                {saving ? 'Saving…' : '💾 Save Allocations'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
