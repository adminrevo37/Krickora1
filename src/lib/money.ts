// SPEC_UI_IMPROVEMENTS_2026-08 U28 — one money formatter for every customer-facing
// price. Duration buttons, totals and the pay button all used raw `${n}`, so a
// half-hour rate rendered as "$67.5" instead of "$67.50".
//
// Convention: DOLLARS in, no currency symbol out (call sites own the "$" so they
// can prefix "-$" / "+$"). Two decimals only when the amount actually has cents —
// "$60" stays "$60", "$67.5" becomes "$67.50".
export const fmtMoney = (n: number): string =>
  Number.isInteger(n) ? `${n}` : n.toFixed(2)

// Same rule, from integer cents (Stripe/server amounts).
export const fmtMoneyCents = (cents: number): string => fmtMoney(cents / 100)
