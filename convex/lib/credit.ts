/**
 * Account-credit helper (SPEC_PAYMENTS_AND_CREDIT #1).
 *
 * The SINGLE place that mutates `customers.creditBalance`. Every movement also
 * appends a `creditLedger` row so the customer's credit history is complete and
 * auditable. All credit sites (cancellation, modify-decrease, admin grant,
 * checkout redemption) route through here — never patch creditBalance directly.
 *
 * Amounts are in DOLLARS, rounded to cents.
 */

type CreditReason =
  | "cancellation"
  | "modify_decrease"
  | "admin_grant"
  | "admin_adjust"
  | "redeemed"
  | "refund"
  | "account_deleted";

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Apply a signed credit delta to an existing customer record and log it.
 * Balance is clamped at 0 (never negative). Returns the resulting balance.
 */
export async function recordCreditMovement(
  ctx: any,
  args: {
    customer: any;
    delta: number;
    reason: CreditReason;
    bookingId?: string;
    note?: string;
  }
): Promise<number> {
  const delta = roundCents(args.delta);
  if (delta === 0) return args.customer.creditBalance ?? 0;
  const newBalance = roundCents(Math.max(0, (args.customer.creditBalance ?? 0) + delta));
  await ctx.db.patch(args.customer._id, { creditBalance: newBalance });
  await ctx.db.insert("creditLedger", {
    customerId: args.customer._id,
    delta,
    balanceAfter: newBalance,
    reason: args.reason,
    bookingId: args.bookingId,
    note: args.note,
    at: new Date().toISOString(),
  });
  return newBalance;
}

/**
 * Issue (add) credit to a customer by email. No-op if the customer doesn't
 * exist or amount <= 0. Returns the amount issued.
 */
export async function issueCredit(
  ctx: any,
  args: {
    email: string;
    amount: number;
    reason: CreditReason;
    bookingId?: string;
    note?: string;
  }
): Promise<number> {
  const amount = roundCents(args.amount);
  if (amount <= 0) return 0;
  const email = args.email.toLowerCase().trim();
  if (!email) return 0;
  const customer = await ctx.db
    .query("customers")
    .withIndex("by_email", (q: any) => q.eq("email", email))
    .first();
  if (!customer) return 0;
  await recordCreditMovement(ctx, {
    customer,
    delta: amount,
    reason: args.reason,
    bookingId: args.bookingId,
    note: args.note,
  });
  return amount;
}

/**
 * Redeem (deduct) up to `amount` of a customer's credit. Deducts only what is
 * available (never goes negative) and logs the actual amount taken. Returns the
 * amount actually redeemed.
 */
export async function redeemCredit(
  ctx: any,
  args: {
    email: string;
    amount: number;
    bookingId?: string;
    note?: string;
  }
): Promise<number> {
  const amount = roundCents(args.amount);
  if (amount <= 0) return 0;
  const email = args.email.toLowerCase().trim();
  if (!email) return 0;
  const customer = await ctx.db
    .query("customers")
    .withIndex("by_email", (q: any) => q.eq("email", email))
    .first();
  if (!customer) return 0;
  const available = customer.creditBalance ?? 0;
  const used = roundCents(Math.min(available, amount));
  if (used <= 0) return 0;
  await recordCreditMovement(ctx, {
    customer,
    delta: -used,
    reason: "redeemed",
    bookingId: args.bookingId,
    note: args.note,
  });
  return used;
}
