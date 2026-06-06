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
