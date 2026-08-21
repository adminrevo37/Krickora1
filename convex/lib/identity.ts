// Batch 2B/2C — canonical customer identity resolution.
//
// Root cause of the coach-booking bugs: customer identity resolved via a NON-UNIQUE
// `by_email` index + `.first()`. A duplicate / role-drifted `customers` row could make
// `.first()` return a non-coach row, silently demoting a coach to a customer EVERYWHERE
// (no blue, customer/pay modal, isCoachBooking:false, broken roster links). These
// helpers resolve a deterministic, privilege-preferring canonical row instead, and
// expose every id form that shares an email so historical references still match.

// Rank a customers row by privilege for canonical selection (admin > coach > customer).
function roleRank(role?: string): number {
  return role === "admin" ? 3 : role === "coach" ? 2 : role === "customer" ? 1 : 0;
}

/**
 * Resolve the CANONICAL `customers` row for an email. Prefers the most-privileged LIVE
 * row (ignoring merged-away / deactivated tombstones); falls back to the raw set if all
 * rows are tombstoned. Returns null when no row exists. Use this everywhere identity is
 * resolved by email instead of a bare `.first()`.
 */
export async function resolveCanonicalCustomerByEmail(
  ctx: any,
  email: string | null | undefined,
): Promise<any | null> {
  const normalized = (email ?? "").toLowerCase().trim();
  if (!normalized) return null;
  const rows = await ctx.db
    .query("customers")
    .withIndex("by_email", (q: any) => q.eq("email", normalized))
    .collect();
  if (rows.length <= 1) return rows[0] ?? null;
  const live = rows.filter((r: any) => !r.mergedIntoCustomerId && !r.deactivatedAt);
  const pool = live.length ? live : rows;
  return pool.reduce(
    (best: any, r: any) => (roleRank(r.role) > roleRank(best.role) ? r : best),
    pool[0],
  );
}

/**
 * Every `customers` _id (as a string) that shares an email — the canonical row plus any
 * duplicates. Lets roster lookups match athletes that point at a coach's historical /
 * duplicate id (Batch 2C), not only the current canonical one.
 */
export async function customerIdsForEmail(
  ctx: any,
  email: string | null | undefined,
): Promise<string[]> {
  const normalized = (email ?? "").toLowerCase().trim();
  if (!normalized) return [];
  const rows = await ctx.db
    .query("customers")
    .withIndex("by_email", (q: any) => q.eq("email", normalized))
    .collect();
  return rows.map((r: any) => r._id as string);
}

/**
 * The identity a coach's ledger is keyed on — resolved ONCE, then used for all three
 * streams (SPEC_COACH_LEDGER_UNIFICATION_2026-08 Phase 2, disagreement #2).
 *
 * The bug this closes: charges are keyed by `booking.customerEmail` while payments and
 * statement adjustments are keyed by `customers._id`. Three streams, two different keys
 * — so a coach with more than one `customers` row (a duplicate, or a merge tombstone)
 * keeps the charges recorded against their email while losing the payments recorded
 * against the other row's id. The failure is silent and total.
 *
 * ⚠️ What this CANNOT close: a booking carrying an email that no coach account has any
 * more. `customers` has no `userId`, so email is the only link from a booking to a coach
 * — there is nothing else to resolve through. That case is prevented at the write path
 * (`adminChangeEmail` repoints every email-keyed row) and DETECTED by the ledger guard's
 * orphan-charge meter, which reports charges belonging to no coach account.
 *
 * Measured on prod 2026-08-21: 0 coach emails carry a duplicate `customers` row, so this
 * is currently a structural no-op — which is exactly why it is safe to land now.
 */
export async function resolveCoachLedgerIdentity(
  ctx: any,
  coach: any,
): Promise<{ email: string; ids: string[] }> {
  const email = (coach?.email ?? "").toLowerCase().trim();
  const ids = new Set<string>([String(coach?._id ?? "")]);
  for (const id of await customerIdsForEmail(ctx, email)) ids.add(String(id));
  ids.delete("");
  return { email, ids: Array.from(ids) };
}
