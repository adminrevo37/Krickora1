/**
 * SPEC_PAYMENT_LINK_TRACKING_2026-07 — persistence + admin visibility for
 * admin-sent Stripe payment links (top-up + manual payment requests).
 *
 * Lifecycle: createPaymentLink (stripe.ts, node) mints the Stripe NATIVE
 * Payment Link (plink_…) and records a `pending` row here. When someone pays,
 * the spawned Checkout Session completes and the webhook marks the row `paid`
 * by session.payment_link (and deactivates the reusable link on Stripe so it
 * can't be paid twice). An admin can also cancel a pending link (deactivates
 * on Stripe) or mark it paid offline.
 *
 * Stripe-touching actions live in stripe.ts ("use node"); this module is the
 * plain mutations/queries side.
 */
import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getCallerContext } from "./lib/adminGuard";
import { laneNameForBooking } from "./lib/lanes";

// ── Writes (internal — called from stripe.ts actions + the webhook) ─────────

export const recordCreatedInternal = internalMutation({
  args: {
    bookingId: v.optional(v.string()),
    stripePaymentLinkId: v.string(),
    purpose: v.string(), // 'topup' | 'manual'
    amountCents: v.number(),
    currency: v.string(),
    customerName: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    sentToEmail: v.optional(v.string()),
    url: v.string(),
    description: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("paymentLinks", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

/**
 * Flip a link pending→paid when its spawned Checkout Session completes.
 * Idempotent: a webhook retry for an already-paid link is a no-op. Best-effort
 * caller (the webhook never throws on this).
 */
export const markPaidInternal = internalMutation({
  args: {
    stripePaymentLinkId: v.string(),
    stripeSessionId: v.string(),
    receiptUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("paymentLinks")
      .withIndex("by_link", (q: any) => q.eq("stripePaymentLinkId", args.stripePaymentLinkId))
      .first();
    if (!link) return { found: false }; // link predates tracking, or not admin-sent
    if ((link as any).status === "paid") return { found: true, alreadyPaid: true };
    await ctx.db.patch(link._id, {
      status: "paid",
      paidAt: Date.now(),
      stripeSessionId: args.stripeSessionId,
      ...(args.receiptUrl ? { receiptUrl: args.receiptUrl } : {}),
    });
    return { found: true };
  },
});

export const markCancelledInternal = internalMutation({
  args: { linkId: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId as any);
    if (!link) return { found: false };
    if ((link as any).status !== "pending") return { found: true, noop: true };
    await ctx.db.patch(link._id, { status: "cancelled", cancelledAt: Date.now() });
    return { found: true };
  },
});

/**
 * Offline payment ("mark paid manually"). Called by stripe.markPaymentLinkPaidManually
 * AFTER it deactivates the Stripe link (deactivation is the double-count guard — a
 * later real card payment of the same link becomes impossible).
 *
 * Money semantics — deliberately asymmetric by purpose:
 * - 'topup'  → mirror recordTopUpPayment exactly: insert a distinct stripePayments
 *   row + bump booking.priceInCents, so balance-due maths and future edit-diffs
 *   stay correct, identically to a Stripe-paid top-up.
 * - 'manual' → mark the LINK paid only. The manual booking already carries its
 *   price (offline-revenue fallback paths sum priceInCents); ALSO inserting a
 *   stripePayments row would risk double-counting in revenue reports. Booking
 *   paid/unpaid state for offline bookings stays with adminSetBookingPaymentStatus.
 */
export const applyManualLinkPayment = internalMutation({
  args: { linkId: v.string(), adminEmail: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId as any);
    if (!link) return { success: false, reason: "not_found" };
    const l = link as any;
    if (l.status !== "pending") return { success: false, reason: `status_${l.status}` };

    await ctx.db.patch(link._id, {
      status: "paid",
      paidAt: Date.now(),
      manualPaid: true,
    });

    if (l.purpose === "topup" && l.bookingId) {
      const booking = await ctx.db.get(l.bookingId as any);
      if (booking) {
        const b = booking as any;
        const syntheticSessionId = `manual-${l.stripePaymentLinkId}`;
        // Dedupe exactly like recordTopUpPayment (session-level, same index).
        const existing = await ctx.db
          .query("stripePayments")
          .withIndex("by_bookingId", (q: any) => q.eq("bookingId", l.bookingId))
          .collect();
        if (!existing.some((p: any) => p.stripeSessionId === syntheticSessionId)) {
          const laneName = laneNameForBooking(b);
          await ctx.db.insert("stripePayments", {
            bookingId: l.bookingId,
            stripeSessionId: syntheticSessionId,
            customerEmail: (l.customerEmail ?? b.customerEmail ?? "").toLowerCase().trim(),
            customerName: l.customerName ?? b.customerName ?? "Customer",
            amount: l.amountCents / 100,
            currency: (l.currency ?? "AUD").toUpperCase(),
            status: "paid",
            laneName,
            date: b.date,
            description: `Session extension top-up (paid offline) — ${laneName} ${b.date}`,
          } as any);
          await ctx.db.patch(booking._id, {
            priceInCents: (b.priceInCents ?? 0) + l.amountCents,
          } as any);
        }
      }
    }
    return { success: true };
  },
});

// ── Admin reads ─────────────────────────────────────────────────────────────

const linkView = (l: any) => ({
  id: l._id,
  // Needed by the admin cancel / mark-paid actions (they deactivate on Stripe).
  stripePaymentLinkId: l.stripePaymentLinkId,
  bookingId: l.bookingId ?? null,
  purpose: l.purpose,
  amountCents: l.amountCents,
  currency: l.currency,
  status: l.status,
  customerName: l.customerName ?? null,
  customerEmail: l.customerEmail ?? null,
  sentToEmail: l.sentToEmail ?? null,
  url: l.url,
  description: l.description,
  createdBy: l.createdBy,
  createdAt: l.createdAt,
  paidAt: l.paidAt ?? null,
  cancelledAt: l.cancelledAt ?? null,
  manualPaid: l.manualPaid === true,
  receiptUrl: l.receiptUrl ?? null,
});

/** Admin list, newest-first, optional status filter. Non-admins get []. */
export const listPaymentLinks = query({
  args: {
    status: v.optional(v.string()), // 'pending' | 'paid' | 'cancelled'
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    try {
      const caller = await getCallerContext(ctx);
      if (!caller.isAdmin) return [];
    } catch {
      return [];
    }
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const rows = args.status
      ? await ctx.db
          .query("paymentLinks")
          .withIndex("by_status", (q: any) => q.eq("status", args.status))
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("paymentLinks")
          .withIndex("by_createdAt")
          .order("desc")
          .take(limit);
    return rows.map(linkView);
  },
});

/** The links attached to one booking (admin booking-details modal). Non-admins get []. */
export const getLinksForBooking = query({
  args: { bookingId: v.string() },
  handler: async (ctx, args) => {
    try {
      const caller = await getCallerContext(ctx);
      if (!caller.isAdmin) return [];
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("paymentLinks")
      .withIndex("by_booking", (q: any) => q.eq("bookingId", args.bookingId))
      .collect();
    return rows.sort((a: any, b: any) => b.createdAt - a.createdAt).map(linkView);
  },
});
