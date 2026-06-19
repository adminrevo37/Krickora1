// SPEC_PWA_PUSH_NOTIFICATIONS §5.2 — push notification categories (the separate
// per-category toggle set, independent of email prefs). `roles` controls which
// role sees the toggle in their profile; sending checks the stored pref by email
// regardless of role (absent key = ON for the relevant role).
//
// Shared by backend (convex/push*.ts) and mirrored on the frontend
// (src/lib/pushCategories.ts) — keep the two in sync.

export type PushCategoryKey =
  | "booking-confirmation"
  | "session-reminders"
  | "facility-access"
  | "booking-changes"
  | "waitlist-offers"
  | "mate-alerts"
  | "child-coaching"
  | "coach-allocation"
  | "account-credit"
  | "coach-roster"
  | "admin-ops";

export interface PushCategory {
  key: PushCategoryKey;
  label: string;
  description: string;
  roles: Array<"customer" | "coach" | "admin">;
}

export const PUSH_CATEGORIES: PushCategory[] = [
  {
    key: "booking-confirmation",
    label: "Booking confirmation & door code",
    description: "When a booking is confirmed, with your door access code.",
    roles: ["customer"],
  },
  {
    key: "session-reminders",
    label: "Session reminders",
    description: "A nudge before your booked session starts.",
    roles: ["customer"],
  },
  {
    key: "facility-access",
    label: "Facility access (first visit)",
    description: "Before your first session — how to find us, parking and getting in.",
    roles: ["customer"],
  },
  {
    key: "booking-changes",
    label: "Booking changes & cancellations",
    description: "When a booking is changed or cancelled.",
    roles: ["customer"],
  },
  {
    key: "waitlist-offers",
    label: "Waitlist offers",
    description: "When a slot you're waitlisted for opens up for you.",
    roles: ["customer"],
  },
  {
    key: "mate-alerts",
    label: "Shared-booking (mate) alerts",
    description: "When you're added to, removed from, or a shared booking changes.",
    roles: ["customer"],
  },
  {
    key: "child-coaching",
    label: "Child coaching alerts",
    description: "When your child is allocated to, moved or removed from a coaching session.",
    roles: ["customer"],
  },
  {
    key: "coach-allocation",
    label: "Coach allocation alerts",
    description: "When an athlete is allocated to your session, or admin books you in.",
    roles: ["coach"],
  },
  {
    key: "account-credit",
    label: "Account & credit",
    description: "When credit is added or adjusted on your account.",
    roles: ["customer"],
  },
  {
    key: "coach-roster",
    label: "Coach roster changes",
    description: "When an athlete adds or removes you as their coach.",
    roles: ["coach"],
  },
  {
    key: "admin-ops",
    label: "Admin operational alerts",
    description: "New fault reports and payment failures.",
    roles: ["admin"],
  },
];

const VALID_KEYS = new Set(PUSH_CATEGORIES.map((c) => c.key));

export function isPushCategory(key: string): key is PushCategoryKey {
  return VALID_KEYS.has(key as PushCategoryKey);
}

// Categories a given role may receive / control. Admins also see the customer
// categories are NOT shown (an admin account doesn't book as a customer); they
// only get admin-ops. Customers get 1–6; coaches get coach-allocation.
export function categoriesForRole(role: string): PushCategory[] {
  const r = role === "admin" || role === "coach" ? role : "customer";
  return PUSH_CATEGORIES.filter((c) => c.roles.includes(r as any));
}
