// AU mobile phone normalisation (server mirror of src/lib/phone.ts).
import { ConvexError } from "convex/values";
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

// Digits-only, last 9 (drops country code / leading-zero differences) so
// "04xx xxx xxx" and "+61 4xx xxx xxx" match the same stored number. This is the
// matching key the Add-a-Mate search uses; the uniqueness check below uses the
// same key so "already on another account" and "search finds two" can never
// disagree.
export function phoneMatchKey(p?: string | null): string {
  const digits = (p || "").replace(/\D/g, "");
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/**
 * M1 (SECURITY review 2026-09-05b): every customers row whose phone matches the
 * given number. Phone uniqueness was enforced nowhere, and the mate search took
 * the FIRST match — so an account that set its phone to a friend's number could
 * be picked when the friend was searched for and receive their door code.
 * Small directory: a scan is fine (same as the search always did).
 */
export async function findCustomersByPhone(ctx: any, phone: string | undefined | null): Promise<any[]> {
  const key = phoneMatchKey(phone);
  if (key.length < 8) return [];
  const all = await ctx.db.query("customers").collect();
  return all.filter((c: any) => c.phone && phoneMatchKey(c.phone) === key);
}

/**
 * Throws if `phone` is already held by a customers row other than `selfId`.
 * Used by every self-service path that writes `customers.phone`. Not applied to
 * admin edits (an admin may legitimately consolidate duplicates).
 *
 * `currentPhone` = the number already stored on the caller's own row. Re-saving
 * the SAME number is never re-validated: the profile form sends the existing
 * phone on every save, so a legacy duplicate (pre-dating this check) must still
 * be able to edit their name or email preferences — they simply cannot be
 * matched by the mate search until an admin resolves the duplicate.
 */
export async function assertPhoneNotOnAnotherAccount(
  ctx: any,
  phone: string | undefined | null,
  selfId: string | null | undefined,
  currentPhone?: string | null
): Promise<void> {
  const key = phoneMatchKey(phone);
  if (!key) return;
  if (currentPhone && phoneMatchKey(currentPhone) === key) return;
  const others = (await findCustomersByPhone(ctx, phone)).filter(
    (c: any) => !selfId || String(c._id) !== String(selfId)
  );
  if (others.length > 0) {
    // ConvexError so the message survives to the client (a plain Error is
    // redacted to "Server Error" on this deployment).
    throw new ConvexError(
      "That mobile number is already on another Cricket Revolution account. If it's yours, contact us and we'll sort it out."
    );
  }
}
