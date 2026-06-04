// AU mobile phone normalisation — lenient input, strict storage.
// Accepts the number with or without spaces / dashes / brackets, and in either
// national (04xxxxxxxx) or international (+61 4xxxxxxxx / 614xxxxxxxx) form.
// Stores the canonical E.164 string (+614xxxxxxxx) — the format an SMS gateway
// needs. Returns null if it isn't a valid Australian mobile.

export function normalizeAuMobile(raw: string | undefined | null): string | null {
  if (!raw) return null
  const s = raw.replace(/[\s\-().]/g, '')
  let m: RegExpMatchArray | null
  // +614xxxxxxxx, 614xxxxxxxx, 00614xxxxxxxx
  if ((m = s.match(/^(?:\+?61|0061)(4\d{8})$/))) return '+61' + m[1]
  // 04xxxxxxxx
  if ((m = s.match(/^0(4\d{8})$/))) return '+61' + m[1]
  // bare 4xxxxxxxx (9 digits) — assume AU
  if ((m = s.match(/^(4\d{8})$/))) return '+61' + m[1]
  return null
}

export function isValidAuMobile(raw: string | undefined | null): boolean {
  return normalizeAuMobile(raw) !== null
}

// Pretty national format for display: +61412345678 -> "0412 345 678".
export function formatAuMobile(stored: string | undefined | null): string {
  const e164 = normalizeAuMobile(stored)
  if (!e164) return stored ?? ''
  const nsn = '0' + e164.slice(3) // 0412345678
  return `${nsn.slice(0, 4)} ${nsn.slice(4, 7)} ${nsn.slice(7)}`
}
