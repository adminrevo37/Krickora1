// Multi-date picker — a month grid (with ‹ › month navigation) where the admin
// clicks individual dates to toggle them into a selected set. Used to copy a
// booking onto an arbitrary, irregular set of dates (e.g. a preseason program
// that skips some weeks) — see AdminManualBookingModal "Pick dates" mode.
import { useState } from 'react'
import { formatDateKey } from '../lib/booking-data'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export default function MultiDatePicker({
  selected,
  onToggle,
  baseDate,
  lockedDate,
}: {
  selected: Set<string>
  onToggle: (dateKey: string) => void
  /** Month to open on (defaults to today). */
  baseDate?: Date
  /** A date that's always selected and can't be removed (the primary booking date). */
  lockedDate?: string
}) {
  const [view, setView] = useState<Date>(() => {
    const b = baseDate ?? new Date()
    return new Date(b.getFullYear(), b.getMonth(), 1)
  })
  const year = view.getFullYear()
  const month = view.getMonth()
  const firstDay = new Date(year, month, 1)
  const leadBlanks = (firstDay.getDay() + 6) % 7 // Mon-first grid
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const cells: (Date | null)[] = []
  for (let i = 0; i < leadBlanks; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d))

  return (
    <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => setView(new Date(year, month - 1, 1))}
          className="w-7 h-7 rounded-lg bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 flex items-center justify-center"
        >
          ‹
        </button>
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          {view.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}
        </span>
        <button
          type="button"
          onClick={() => setView(new Date(year, month + 1, 1))}
          className="w-7 h-7 rounded-lg bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 flex items-center justify-center"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-gray-400 mb-1">
        {WEEKDAYS.map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} />
          const dk = formatDateKey(d)
          const isSel = selected.has(dk)
          const isLocked = lockedDate === dk
          return (
            <button
              key={i}
              type="button"
              onClick={() => { if (!isLocked) onToggle(dk) }}
              title={isLocked ? 'Primary date (always included)' : undefined}
              className={`aspect-square rounded-lg text-xs font-medium transition-all ${
                isSel
                  ? 'bg-emerald-500 text-white shadow-sm'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
              } ${isLocked ? 'ring-2 ring-emerald-300 dark:ring-emerald-600 cursor-default' : ''}`}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>

      <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
        {selected.size} date{selected.size === 1 ? '' : 's'} selected — click to add/remove, ‹ › to change month.
      </div>
    </div>
  )
}
