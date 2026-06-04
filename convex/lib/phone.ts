// AU mobile phone normalisation (server mirror of src/lib/phone.ts).
// Lenient input (with/without spaces, national or +61), canonical E.164 storage.

export function normalizeAuMobile(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/[\s\-().]/g, "");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(?:\+?61|0061)(4\d{8})$/))) return "+61" + m[1];
  if ((m = s.match(/^0(4\d{8})$/))) return "+61" + m[1];
  if ((m = s.match(/^(4\d{8})$/))) return "+61" + m[1];
  return null;
}

export function isValidAuMobile(raw: string | undefined | null): boolean {
  return normalizeAuMobile(raw) !== null;
}
