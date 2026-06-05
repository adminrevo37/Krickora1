import { useMemo, useRef, useState } from 'react'

/**
 * SPEC_SIGNUP_UPDATES_2026-06 G4 — searchable coach multi-select.
 *
 * Replaces the old "wall of chips that auto-saves on tap". Scales to 20+ coaches:
 * type to filter, tap a result to add; selected coaches show as removable chips.
 *
 * CONTROLLED + STAGING-ONLY: it never persists anything itself — it just reports
 * the chosen ids via onChange. The parent decides when to commit (signup commits
 * on Create Account; Profile commits on an explicit Save). So an accidental tap
 * can no longer auto-save.
 */
export interface CoachOption {
  _id: string
  name: string
}

interface CoachMultiSelectProps {
  coaches: CoachOption[]
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  placeholder?: string
  /** Dark variant for the AuthModal (light is the default, for Profile). */
  dark?: boolean
}

export default function CoachMultiSelect({
  coaches,
  value,
  onChange,
  disabled,
  placeholder = 'Search coaches…',
  dark,
}: CoachMultiSelectProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const byId = useMemo(() => {
    const m = new Map<string, CoachOption>()
    for (const c of coaches) m.set(c._id, c)
    return m
  }, [coaches])

  const selected = value.map((id) => byId.get(id)).filter(Boolean) as CoachOption[]

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    // No cap — the full filtered list is shown in a scrollable box (the old
    // slice(0,8) meant longer lists silently couldn't be reached).
    return coaches
      .filter((c) => !value.includes(c._id))
      .filter((c) => (q ? c.name.toLowerCase().includes(q) : true))
  }, [coaches, value, query])

  const add = (id: string) => {
    if (!value.includes(id)) onChange([...value, id])
    setQuery('')
  }
  const remove = (id: string) => onChange(value.filter((c) => c !== id))

  const chipCls = dark
    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
    : 'bg-emerald-50 text-emerald-700 border-emerald-200'
  const inputCls = dark
    ? 'bg-gray-800 border-gray-700 text-gray-100 placeholder-gray-500 focus:ring-emerald-500'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-emerald-500'
  const menuCls = dark
    ? 'bg-gray-800 border-gray-700'
    : 'bg-white border-gray-200'
  const itemCls = dark
    ? 'text-gray-200 hover:bg-gray-700'
    : 'text-gray-700 hover:bg-emerald-50'

  if (coaches.length === 0) {
    return (
      <p className={`text-xs ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
        No coaches available yet.
      </p>
    )
  }

  return (
    <div className="relative">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map((c) => (
            <span
              key={c._id}
              className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border ${chipCls}`}
            >
              {c.name}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(c._id)}
                  className="hover:opacity-70 font-bold leading-none"
                  aria-label={`Remove ${c.name}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <input
        type="text"
        value={query}
        disabled={disabled}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 120) }}
        placeholder={placeholder}
        className={`w-full px-3 py-2 rounded-lg border text-base focus:outline-none focus:ring-2 focus:border-transparent transition-all disabled:opacity-50 ${inputCls}`}
      />

      {/* Results render INLINE (not absolute): the parent card uses overflow-hidden,
          which clipped the old absolute dropdown so longer lists couldn't be scrolled.
          In-flow + max-h + overflow-y-auto makes the full list reliably scrollable on
          mobile, while overscroll-contain stops the scroll chaining to the page. */}
      {open && results.length > 0 && (
        <div
          className={`mt-1 w-full max-h-60 overflow-y-auto overscroll-contain rounded-lg border shadow-sm ${menuCls}`}
          onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current) }}
        >
          {results.map((c) => (
            <button
              key={c._id}
              type="button"
              onClick={() => add(c._id)}
              className={`block w-full text-left px-3 py-2.5 text-base ${itemCls}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {open && query.trim() && results.length === 0 && (
        <div className={`mt-1 w-full rounded-lg border shadow-sm px-3 py-2 text-sm ${menuCls} ${dark ? 'text-gray-400' : 'text-gray-400'}`}>
          No coaches match “{query.trim()}”.
        </div>
      )}
    </div>
  )
}
