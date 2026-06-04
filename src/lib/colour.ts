// Shared colour helpers (SPEC_COACH_PLANNER_RETIRE_AND_VIEW §3/§6). Lifted from
// AdminBookingCalendar's inline getContrastText so admin + coach views match.

// Pick black or white text for legibility against a hex background.
export function getContrastText(hex?: string): string {
  if (!hex) return '#fff'
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(x => x + x).join('') : h
  if (full.length !== 6) return '#fff'
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luma > 0.6 ? '#1f2937' : '#fff'
}

// Fallback coach colour when a coach has no admin-set customers.color.
export const DEFAULT_COACH_COLOR = '#dc2626' // rose-600 (matches the legacy red coach block)

// Amber hatch for UNALLOCATED coach time (NOT grey — grey means past/blocked).
export const AMBER_HATCH =
  'repeating-linear-gradient(45deg,#fef3c7,#fef3c7 5px,#fde68a 5px,#fde68a 10px)'
export const AMBER_TEXT = '#92400e'
