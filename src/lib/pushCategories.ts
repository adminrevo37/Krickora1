// SPEC_PWA_PUSH_NOTIFICATIONS §5.2 — frontend mirror of convex/lib/pushCategories.ts.
// Keep the two in sync. `roles` controls which toggles a role sees in their profile.

export type PushCategoryKey =
  | 'booking-confirmation'
  | 'session-reminders'
  | 'booking-changes'
  | 'waitlist-offers'
  | 'mate-alerts'
  | 'child-coaching'
  | 'coach-allocation'
  | 'admin-ops'

export interface PushCategory {
  key: PushCategoryKey
  label: string
  description: string
  roles: Array<'customer' | 'coach' | 'admin'>
}

export const PUSH_CATEGORIES: PushCategory[] = [
  { key: 'booking-confirmation', label: 'Booking confirmation & door code', description: 'When a booking is confirmed, with your door access code.', roles: ['customer'] },
  { key: 'session-reminders', label: 'Session reminders', description: 'A nudge before your booked session starts.', roles: ['customer'] },
  { key: 'booking-changes', label: 'Booking changes & cancellations', description: 'When a booking is changed or cancelled.', roles: ['customer'] },
  { key: 'waitlist-offers', label: 'Waitlist offers', description: "When a slot you're waitlisted for opens up for you.", roles: ['customer'] },
  { key: 'mate-alerts', label: 'Shared-booking (mate) alerts', description: "When you're added to, removed from, or a shared booking changes.", roles: ['customer'] },
  { key: 'child-coaching', label: 'Child coaching alerts', description: 'When your child is allocated to, moved or removed from a coaching session.', roles: ['customer'] },
  { key: 'coach-allocation', label: 'Coach allocation alerts', description: 'When an athlete is allocated to your session, or admin books you in.', roles: ['coach'] },
  { key: 'admin-ops', label: 'Admin operational alerts', description: 'New fault reports and payment failures.', roles: ['admin'] },
]

export function categoriesForRole(role: string): PushCategory[] {
  const r = role === 'admin' || role === 'coach' ? role : 'customer'
  return PUSH_CATEGORIES.filter((c) => c.roles.includes(r as any))
}
