import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * Idempotent: marks a booking as paid/confirmed and sends the payment
 * confirmation email exactly once. Safe to call multiple times for the
 * same booking — subsequent calls are no-ops.
 */
export const confirmBookingPayment = internalMutation({
  args: {
    bookingId: v.string(),
    stripeSessionId: v.string(),
    amountPaid: v.number(),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId as any);
    if (!booking) {
      console.warn(`[webhook] Booking not found: ${args.bookingId}`);
      return { success: false, reason: "booking_not_found" };
    }

    const b = booking as any;

    // Idempotency: already paid → no-op
    if (b.paymentStatus === "paid") {
      return { success: true, alreadyPaid: true };
    }

    // Email dedup guard: check before patching so we can set the flag atomically
    const willSendEmail = !!b.customerEmail && !b.paymentEmailSent;

    const patch: Record<string, any> = {
      paymentStatus: "paid",
      stripeSessionId: args.stripeSessionId,
      ...(willSendEmail ? { paymentEmailSent: true } : {}),
    };

    if (b.status === "tentative" || b.status === "pending_payment" || b.status === "pending") {
      patch.status = "confirmed";
    }

    await ctx.db.patch(booking._id, patch);

    // Send payment confirmation email (only if verifySession hasn't already sent it)
    if (willSendEmail) {
      const LANE_NAMES: Record<string, string> = {
        bm1: "Bowling Machine 1",
        bm2: "Bowling Machine 2",
        bm3: "Bowling Machine 3",
        ru1: "9m Run Up 1",
        ru2: "9m Run Up 2",
      };
      const currency = (args.currency ?? "AUD").toUpperCase();
      const amount = `$${(args.amountPaid / 100).toFixed(2)} ${currency}`;
      const laneName = LANE_NAMES[b.laneId] ?? String(b.laneId).toUpperCase();
      const description = `${laneName} — ${b.date}`;
      const paymentDate = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      await ctx.scheduler.runAfter(0, internal.emails.sendPaymentConfirmation, {
        to: b.customerEmail,
        customerName: b.customerName ?? "there",
        amount,
        description,
        reference: args.stripeSessionId,
        paymentDate,
      });
    }

    return { success: true, alreadyPaid: false };
  },
});

/**
 * Marks paymentEmailSent = true on a booking so the webhook won't resend
 * when verifySession has already sent the confirmation email.
 * Also stores stripePaymentIntentId (needed for future partial refunds).
 */
export const markPaymentEmailSent = internalMutation({
  args: {
    bookingId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId as any);
    if (!booking) return { success: false };
    const patch: Record<string, any> = { paymentEmailSent: true };
    if (args.stripePaymentIntentId) {
      patch.stripePaymentIntentId = args.stripePaymentIntentId;
    }
    await ctx.db.patch(booking._id, patch);
    return { success: true };
  },
});

/**
 * Marks a booking as payment_failed. Idempotent.
 */
export const markBookingPaymentFailed = internalMutation({
  args: {
    bookingId: v.string(),
    stripeSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId as any);
    if (!booking) return { success: false, reason: "booking_not_found" };

    const b = booking as any;
    if (b.paymentStatus === "failed" || b.paymentStatus === "paid") {
      return { success: true, noop: true };
    }

    await ctx.db.patch(booking._id, {
      paymentStatus: "failed",
      ...(args.stripeSessionId ? { stripeSessionId: args.stripeSessionId } : {}),
    });

    return { success: true };
  },
});
