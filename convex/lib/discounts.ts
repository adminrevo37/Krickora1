/**
 * Discount-code redemption recording (SPEC_ADMIN_AND_SETTINGS #3).
 *
 * Called at the two points a discounted booking becomes final — direct
 * confirmed creation (free/comp) and Stripe payment confirmation. Increments
 * the code's usedCount and logs a discountRedemptions row so per-customer and
 * total caps can be enforced. Idempotent per bookingId (safe on webhook retry).
 */

/**
 * Server-authoritative discount validation (R1/R3 — money path).
 *
 * The single source of truth for whether a code is usable RIGHT NOW: active,
 * not expired, under its total usage cap, and under this customer's per-customer
 * cap. Returns the validated discount params, or null if the code is missing/
 * invalid/expired/over-cap. Used by createBooking (to reject bad codes + recompute
 * the price server-side) and by the validateDiscountCode query (client preview),
 * so both compute identically.
 */
export interface ValidatedDiscount {
  discount: number;        // percentage (for percent type)
  type: "percent" | "fixed";
  amountOff: number;       // dollars off (for fixed type)
  label: string;
  bypassStripe: boolean;
}

export async function validateDiscount(
  ctx: any,
  code: string | null | undefined,
  customerEmail?: string | null
): Promise<ValidatedDiscount | null> {
  const normalised = (code ?? "").trim().toLowerCase();
  if (!normalised) return null;
  const doc = await ctx.db
    .query("discountCodes")
    .withIndex("by_code", (q: any) => q.eq("code", normalised))
    .first();
  if (!doc || !doc.active) return null;
  // Expiry (YYYY-MM-DD string comparison is safe)
  if (doc.expiresAt) {
    const today = new Date().toISOString().slice(0, 10);
    if (doc.expiresAt < today) return null;
  }
  // Total usage cap (usedCount defaults to 0 for old docs missing the field)
  if (doc.usageLimit !== undefined && (doc.usedCount ?? 0) >= doc.usageLimit) return null;
  // Per-customer cap — count this email's prior redemptions of this code
  const email = (customerEmail ?? "").trim().toLowerCase();
  if (doc.perCustomerLimit !== undefined && email) {
    const mine = await ctx.db
      .query("discountRedemptions")
      .withIndex("by_code_email", (q: any) => q.eq("code", normalised).eq("customerEmail", email))
      .collect();
    if (mine.length >= doc.perCustomerLimit) return null;
  }
  return {
    discount: doc.discount,
    type: (doc.discountType ?? "percent") as "percent" | "fixed",
    amountOff: doc.amountOff ?? 0,
    label: doc.label ?? "",
    bypassStripe: doc.bypassStripe ?? false,
  };
}

/** Discount amount in cents off a gross total (cents), mirroring the client. */
export function discountAmountCents(gross: number, d: ValidatedDiscount): number {
  if (d.type === "fixed") return Math.min(gross, Math.round(d.amountOff * 100));
  return Math.round((gross * d.discount) / 100);
}

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

/**
 * MON-4 (audit 2026-06): release a discount RESERVATION made at booking-create time
 * (recordDiscountRedemption) when the unpaid booking is abandoned/cancelled before it
 * ever became a real, paid booking. Mirrors the record in reverse — decrement
 * usedCount + delete the redemption row keyed by bookingId. No-op if there was no
 * reservation. Idempotent (a second call finds no row). Without this, an abandoned
 * checkout would permanently consume a usage slot of a limited/comp code.
 */
export async function releaseDiscountReservation(
  ctx: any,
  bookingId: string
): Promise<void> {
  const row = await ctx.db
    .query("discountRedemptions")
    .withIndex("by_bookingId", (q: any) => q.eq("bookingId", bookingId))
    .first();
  if (!row) return;
  const doc = await ctx.db
    .query("discountCodes")
    .withIndex("by_code", (q: any) => q.eq("code", row.code))
    .first();
  if (doc) {
    await ctx.db.patch(doc._id, { usedCount: Math.max(0, (doc.usedCount ?? 0) - 1) });
  }
  await ctx.db.delete(row._id);
}
