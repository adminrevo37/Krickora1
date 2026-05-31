import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { redeemCredit } from "./lib/credit";
import { recordDiscountRedemption } from "./lib/discounts";
import { releaseHoldForBooking } from "./lib/slotHolds";
import { applyBookingChange } from "./mutations";

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

    // Booking edit / unified modify top-up — apply the pending change once paid.
    if (b.status === "pending_edit_payment" && b.pendingEdit) {
      const pe = b.pendingEdit;
      // A unified modify carries slot fields (date/time/lane); a legacy
      // duration-only edit (EditBookingModal) carries none of them.
      const isUnified =
        pe.newDate !== undefined || pe.newStartHour !== undefined || pe.newLaneId !== undefined;

      if (isUnified) {
        // Mark paid first, then apply the full change-set (calendar resync, code
        // regen, athlete keep-what-fits, emails) via the shared helper.
        await ctx.db.patch(booking._id, {
          paymentStatus: "paid",
          stripeSessionId: args.stripeSessionId,
        });
        const newDate = pe.newDate ?? b.date;
        const newStartHour = pe.newStartHour ?? b.startHour;
        const newLaneId = pe.newLaneId ?? b.laneId;
        const regenCode =
          pe.newAccessCode !== undefined ||
          newDate !== b.date ||
          newStartHour !== b.startHour ||
          newLaneId !== b.laneId;
        await applyBookingChange(ctx, booking, {
          newDate,
          newStartHour,
          newDuration: pe.newDuration,
          newLaneId,
          newVariantId: pe.newVariantId,
          newAdditionalLaneIds: pe.newAdditionalLaneIds ?? b.additionalLaneIds,
          newAccessCode: pe.newAccessCode,
          regenCode,
          newPriceInCents: pe.newPriceInCents,
          actorUserId: pe.actorUserId ?? b.userId,
          actorName: b.customerName,
        });
        await ctx.db.patch(booking._id, { status: "confirmed", pendingEdit: undefined });
        // Redeem any account credit applied to the top-up (atomic on confirm).
        if ((pe.creditApplied ?? 0) > 0 && b.customerEmail) {
          await redeemCredit(ctx, {
            email: b.customerEmail,
            amount: pe.creditApplied,
            bookingId: booking._id.toString(),
          });
        }
        await releaseHoldForBooking(ctx, booking._id.toString());
        return { success: true, isBookingEdit: true };
      }

      // Legacy duration-only edit — unchanged inline behaviour.
      await ctx.db.patch(booking._id, {
        status: "confirmed",
        paymentStatus: "paid",
        stripeSessionId: args.stripeSessionId,
        duration: pe.newDuration,
        ...(pe.newAdditionalLaneIds !== undefined ? { additionalLaneIds: pe.newAdditionalLaneIds } : {}),
        priceInCents: pe.newPriceInCents,
        pendingEdit: undefined,
      } as any);
      return { success: true, isBookingEdit: true };
    }

    const patch: Record<string, any> = {
      paymentStatus: "paid",
      stripeSessionId: args.stripeSessionId,
    };

    if (b.status === "tentative" || b.status === "pending_payment" || b.status === "pending") {
      patch.status = "confirmed";
      patch.priceInCents = args.amountPaid; // store Stripe-confirmed amount for future edit calculations
    }

    await ctx.db.patch(booking._id, patch);

    // SPEC_PAYMENTS_AND_CREDIT #1/#3: deduct any account credit applied to this
    // booking ATOMICALLY on confirmation (never on the abandoned path), and free
    // the checkout slot hold now that the booking is confirmed.
    if ((b.creditApplied ?? 0) > 0 && b.customerEmail) {
      await redeemCredit(ctx, {
        email: b.customerEmail,
        amount: b.creditApplied,
        bookingId: booking._id.toString(),
      });
    }

    // Record discount redemption now that payment succeeded (idempotent).
    if (b.discountCode) {
      await recordDiscountRedemption(ctx, {
        code: b.discountCode,
        customerEmail: b.customerEmail,
        bookingId: booking._id.toString(),
      });
    }

    await releaseHoldForBooking(ctx, booking._id.toString());

    // Send payment confirmation email
    if (b.customerEmail) {
      const currency = (args.currency ?? "AUD").toUpperCase();
      const amount = `$${(args.amountPaid / 100).toFixed(2)} ${currency}`;
      const laneNameMap: Record<string, string> = {
        bm1: "Bowling Machine Lane 1",
        bm2: "Bowling Machine Lane 2",
        ru1: "Run-Up Lane 1",
        ru2: "Run-Up Lane 2",
      };
      const laneName = laneNameMap[b.laneId] ?? String(b.laneId).toUpperCase();
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
