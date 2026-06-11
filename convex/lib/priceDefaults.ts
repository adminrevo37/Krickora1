// C-1: single source for price FALLBACKS (used only when a siteSettings value is
// missing/unseeded — the admin panel is the real SSOT). Centralising these stops
// the same magic numbers drifting apart across the codebase. Mirror of the
// client copy in src/lib/priceDefaults.ts (the two build roots can't share a
// module; keep the values identical).
export const PRICE_DEFAULTS = {
  customerPerHour: 40,
  trumanPerHour: 50,
  coachPerHour: 25,
  // SPEC_30MIN_GAP_FILL — explicit (not pro-rata) 30-minute gap-fill price. $20 for
  // standard/run-up, $25 for Truman. Decoupled from the hourly rate so it stays fixed.
  thirtyMin: 20,
  trumanThirtyMin: 25,
} as const;
