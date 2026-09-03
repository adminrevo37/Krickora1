// 2026-09-03 — admin cancel reasons (stored as booking.cancelReason). Keep the
// keys stable: the analytics tallies on them.
export const CANCEL_REASONS: Array<{ key: string; label: string }> = [
  { key: 'coach_requested', label: 'Coach asked us to cancel (phone / text / email)' },
  { key: 'customer_requested', label: 'Customer asked us to cancel' },
  { key: 'no_show', label: 'No-show' },
  { key: 'facility', label: 'Facility or lane issue' },
  { key: 'error', label: 'Booking made in error / duplicate' },
  { key: 'other', label: 'Other (say what in the note)' },
]
export const CANCEL_REASON_LABEL: Record<string, string> = Object.fromEntries(
  CANCEL_REASONS.map((r) => [r.key, r.label.replace(/ \(.*\)$/, '')])
)
