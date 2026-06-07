// C-1: single source for client-side price FALLBACKS (preview only — the server
// recomputes the authoritative price from settings, see R1). Mirror of
// convex/lib/priceDefaults.ts; keep the values identical.
export const PRICE_DEFAULTS = {
  customerPerHour: 40,
  trumanPerHour: 50,
  coachPerHour: 25,
} as const
