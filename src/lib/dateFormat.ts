// Single source for display-date formatting on the client. See
// cricket/krickora/SPEC_DATE_FORMAT_STANDARDIZATION_2026-08.md for rationale.
//
// Target: "Tuesday, 1 September 2026" everywhere a date is shown.

// Accepts a YYYY-MM-DD string (parsed as a LOCAL date, not UTC — avoids the
// classic off-by-one-day shift `new Date(dateString)` causes when the browser's
// zone differs from AWST) or a Date object.
function toLocalDate(value: string | Date): Date {
  if (value instanceof Date) return value
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function formatDateLong(value: string | Date): string {
  const d = toLocalDate(value)
  // en-AU's Intl output has no comma after the weekday ("Tuesday 1 September
  // 2026") — build it explicitly rather than rely on locale punctuation, which
  // can vary by browser/ICU version.
  const weekday = d.toLocaleDateString('en-AU', { weekday: 'long' })
  const rest = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
  return `${weekday}, ${rest}`
}
