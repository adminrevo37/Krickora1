import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
// Time-slot based waitlist — lane is '*' (any)
import { useAuth } from '../hooks/useAuth'
import { useWaitlist } from '../hooks/useWaitlist'

interface WaitlistModalProps {
  selectedSlots: { laneId: string; date: string; hour: number }[]
  // SPEC_MOBILE_BOOKING_UPDATES §4.3 — the day's other full/waitlistable hours, so
  // the user can join several in one confirm. The tapped hour(s) start pre-ticked.
  availableHours?: number[]
  date?: string
  onClose: () => void
  onSuccess: () => void
}

export default function WaitlistModal({ selectedSlots, availableHours, date, onClose, onSuccess }: WaitlistModalProps) {
  const { user } = useAuth()
  const { addToWaitlist } = useWaitlist(user?.id)
  const addToWaitlistServer = useMutation(api.mutations.addToWaitlist)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  // The hours the user has ticked to join (seeded from the tapped slot).
  const seedHours = selectedSlots.map(s => s.hour)
  const seedDate = date ?? selectedSlots[0]?.date ?? ''
  const [chosenHours, setChosenHours] = useState<number[]>(() => Array.from(new Set(seedHours)))
  const toggleHour = (h: number) =>
    setChosenHours(prev => prev.includes(h) ? prev.filter(x => x !== h) : [...prev, h])

  if (!user) return null

  const formatHour = (h: number) => {
    const period = h >= 12 ? 'pm' : 'am'
    const display = h > 12 ? h - 12 : h === 0 ? 12 : h
    return `${display}${period}`
  }

  const formatDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number)
    const d = new Date(year, month - 1, day)
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  // The list of hours to offer as a checklist: the day's full hours if provided,
  // else just the seeded hour(s). Always include the seeded hours.
  const offerHours = Array.from(new Set([...(availableHours ?? []), ...seedHours])).sort((a, b) => a - b)

  const handleSubmit = async () => {
    if (chosenHours.length === 0) return
    setIsSubmitting(true)
    await new Promise(r => setTimeout(r, 600))

    // One entry per (date, hour) — any lane opening at that time notifies.
    const uniqueSlots = Array.from(new Set(chosenHours)).map(h => ({ date: seedDate, hour: h }))
    const entries = uniqueSlots.map(s => ({
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      laneId: '*',
      date: s.date,
      hour: s.hour,
    }))
    addToWaitlist(entries)
    try {
      await addToWaitlistServer({ entries })
    } catch (err) {
      console.error('Failed to add to waitlist on server:', err)
    }

    setDone(true)
    setTimeout(() => {
      onSuccess()
    }, 2000)
  }

  if (done) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
        <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-sm overflow-hidden">
          <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-5 text-white">
            <h3 className="text-lg font-bold">Added to Waitlist! 🔔</h3>
            <p className="text-white/80 text-sm mt-0.5">You will be notified when slots open up</p>
          </div>
          <div className="p-6 text-center">
            <div className="w-14 h-14 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-2xl">✅</span>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              You have been added to the waitlist for <strong>{chosenHours.length} slot{chosenHours.length > 1 ? 's' : ''}</strong>.
              You'll be notified when any of these times open up — accept to grab it.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-sm overflow-hidden max-h-[85vh] flex flex-col">
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-5 text-white shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">Join Waitlist</h3>
              <p className="text-white/80 text-sm mt-0.5">
                {chosenHours.length} slot{chosenHours.length === 1 ? '' : 's'} selected
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Pick the times you'd like a net for on <strong>{formatDate(seedDate)}</strong>. We'll
            notify you when any lane opens — first in the queue gets first refusal.
          </p>

          <div className="flex flex-wrap gap-2">
            {offerHours.map(h => {
              const on = chosenHours.includes(h)
              return (
                <button
                  key={h}
                  type="button"
                  onClick={() => toggleHour(h)}
                  className={`text-sm px-3 py-1.5 rounded-full font-medium border transition-colors ${on ? 'bg-amber-500 border-amber-500 text-white' : 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100'}`}
                >
                  {on ? '✓ ' : ''}{formatHour(h)}
                </button>
              )
            })}
          </div>

          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-xs text-gray-500 dark:text-gray-400">
            <strong className="text-gray-700 dark:text-gray-300">How it works:</strong> You will get an email notification the moment ANY lane becomes available at these times (from cancellations, changes, etc). It does not matter which lane — you will be notified as soon as anything opens up.
          </div>
        </div>

        <div className="p-5 border-t border-gray-200 dark:border-gray-800 shrink-0">
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || chosenHours.length === 0}
            className="w-full py-3 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold rounded-xl shadow-lg shadow-amber-500/20 hover:shadow-amber-500/40 transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Adding...
              </>
            ) : (
              <>🔔 Join Waitlist for {chosenHours.length} Slot{chosenHours.length === 1 ? '' : 's'}</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
