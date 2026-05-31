/**
 * Discount-code redemption recording (SPEC_ADMIN_AND_SETTINGS #3).
 *
 * Called at the two points a discounted booking becomes final — direct
 * confirmed creation (free/comp) and Stripe payment confirmation. Increments
 * the code's usedCount and logs a discountRedemptions row so per-customer and
 * total caps can be enforced. Idempotent per bookingId (safe on webhook retry).
 */

export async function recordDiscountRedemption(
  ctx: any,
  args: { code?: string | null; customerEmail?: string | null; bookingId: string }
): Promise<void> {
  const code = (args.code ?? "").trim().toLowerCase();
  const email = (args.customerEmail ?? "").trim().toLowerCase();
  if (!code) return;

  // Idempotency — don't double-count if this booking was already recorded.
  const existing = await ctx.db
    .query("discountRedemptions")
    .withIndex("by_bookingId", (q: any) => q.eq("bookingId", args.bookingId))
    .first();
  if (existing) return;

  const doc = await ctx.db
    .query("discountCodes")
    .withIndex("by_code", (q: any) => q.eq("code", code))
    .first();
  if (!doc) return; // unknown code — nothing to track

  await ctx.db.patch(doc._id, { usedCount: (doc.usedCount ?? 0) + 1 });
  await ctx.db.insert("discountRedemptions", {
    code,
    customerEmail: email,
    bookingId: args.bookingId,
    at: new Date().toISOString(),
  });
}
