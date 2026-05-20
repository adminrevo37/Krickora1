import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
// Time-slot based waitlist — lane is '*' (any)
import { useAuth } from '../hooks/useAuth'
import { useWaitlist } from '../hooks/useWaitlist'

interface WaitlistModalProps {
  selectedSlots: { laneId: string; date: string; hour: number }[]
  onClose: () => void
  onSuccess: () => void
}

export default function WaitlistModal({ selectedSlots, onClose, onSuccess }: WaitlistModalProps) {
  const { user } = useAuth()
  const { addToWaitlist } = useWaitlist(user?.id)
  const addToWaitlistServer = useMutation(api.mutations.addToWaitlist)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [done, setDone] = useState(false)

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

  // Group by date only — waitlist is time-slot based (any lane match notifies)
  const grouped = new Map<string, { date: string; hours: number[] }>()
  for (const slot of selectedSlots) {
    const key = slot.date
    if (!grouped.has(key)) grouped.set(key, { date: slot.date, hours: [] })
    const bucket = grouped.get(key)!
    if (!bucket.hours.includes(slot.hour)) bucket.hours.push(slot.hour)
  }

  const handleSubmit = async () => {
    setIsSubmitting(true)
    await new Promise(r => setTimeout(r, 600))

    // Deduplicate to one entry per (date, hour) — any lane opening will notify
    const unique = new Map<string, { date: string; hour: number }>()
    for (const s of selectedSlots) unique.set(`${s.date}-${s.hour}`, { date: s.date, hour: s.hour })
    const uniqueSlots = Array.from(unique.values())
    addToWaitlist(
      uniqueSlots.map(s => ({
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        laneId: '*',
        date: s.date,
        hour: s.hour,
      }))
    )
    try {
      await addToWaitlistServer({
        entries: uniqueSlots.map(s => ({
          userId: user.id,
          userName: user.name,
          userEmail: user.email,
          laneId: '*',
          date: s.date,
          hour: s.hour,
        })),
      })
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
              You have been added to the waitlist for <strong>{selectedSlots.length} slot{selectedSlots.length > 1 ? 's' : ''}</strong>.
              We will email you at <strong>{user.email}</strong> when any of these slots become available.
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
                {selectedSlots.length} slot{selectedSlots.length > 1 ? 's' : ''} selected
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
            Get notified via email when any of these booked slots become available:
          </p>

          <div className="space-y-3">
            {Array.from(grouped.values()).map(({ date, hours }) => (
              <div
                key={date}
                className="bg-amber-50 dark:bg-amber-900/10 rounded-xl border border-amber-200 dark:border-amber-800/50 p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span>🏏</span>
                  <span className="font-semibold text-sm text-gray-800 dark:text-gray-200">Any Available Lane</span>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{formatDate(date)}</div>
                <div className="flex flex-wrap gap-1.5">
                  {hours.sort((a, b) => a - b).map(h => (
                    <span
                      key={h}
                      className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full font-medium"
                    >
                      {formatHour(h)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-xs text-gray-500 dark:text-gray-400">
            <strong className="text-gray-700 dark:text-gray-300">How it works:</strong> You will get an email notification the moment ANY lane becomes available at these times (from cancellations, changes, etc). It does not matter which lane — you will be notified as soon as anything opens up.
          </div>
        </div>

        <div className="p-5 border-t border-gray-200 dark:border-gray-800 shrink-0">
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="w-full py-3 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold rounded-xl shadow-lg shadow-amber-500/20 hover:shadow-amber-500/40 transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Adding...
              </>
            ) : (
              <>🔔 Join Waitlist for {selectedSlots.length} Slot{selectedSlots.length > 1 ? 's' : ''}</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
