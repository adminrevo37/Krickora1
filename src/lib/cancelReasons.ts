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
// 2026-09-05 — set by the POLICY, not by an admin, when a customer cancels inside
// the cancellation window and nothing is returned. Deliberately not in
// CANCEL_REASONS above: that array is the admin dropdown, and this is never an
// admin's choice. It still needs a label so analytics doesn't print the raw key.
export const POLICY_CANCEL_REASON_LABEL: Record<string, string> = {
  late_no_refund: 'Cancelled late by customer — no refund',
}
export const CANCEL_REASON_LABEL: Record<string, string> = {
  ...Object.fromEntries(CANCEL_REASONS.map((r) => [r.key, r.label.replace(/ \(.*\)$/, '')])),
  ...POLICY_CANCEL_REASON_LABEL,
}
