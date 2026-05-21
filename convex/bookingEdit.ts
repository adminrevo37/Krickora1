"use node";

import { action, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import Stripe from "stripe";

// ============================================================================
// BOOKING EDIT FEATURE
// Allows customers to change the duration (and/or additional lanes) of an
// existing confirmed booking.
//   • If new price === old price → apply immediately, no Stripe needed
//   • If new price < old price  → apply immediately + issue partial refund
//   • If new price > old price  → store pendingEdit, return requiresPayment:true
//     The frontend then creates a top-up Stripe checkout session.
//     The webhook fires confirmBookingPayment → no (sessionType = booking_edit_topup)
//     → applyPendingBookingEdit is called instead.
// ============================================================================

// ---------------------------------------------------------------------------
// requestBookingEdit — called from the frontend booking edit modal
// ---------------------------------------------------------------------------
export const requestBookingEdit = action({
  args: {
    bookingId: v.string(),
    newDuration: v.number(),
    newAdditionalLaneIds: v.optional(v.array(v.string())),
    newPriceInCents: v.number(),   // frontend calculates from siteSettings
    oldPriceInCents: v.number(),   // frontend calculates from current booking
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.bookingEdit._requestBookingEdit, args);
  },
});

export const _requestBookingEdit = internalMutation({
  args: {
    bookingId: v.string(),
    newDuration: v.number(),
    newAdditionalLaneIds: v.optional(v.array(v.string())),
    newPriceInCents: v.number(),
    oldPriceInCents: v.number(),
  },
  handler: async (ctx, args) => {
    // ── Auth guard ──────────────────────────────────────────────────────────
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required.");

    const booking = await ctx.db.get(args.bookingId as any);
    if (!booking) throw new Error("Booking not found.");
    if (booking.status === "cancelled") throw new Error("Cannot edit a cancelled booking.");
    if ((booking as any).status === "pending_edit_payment") {
      throw new Error("A payment for this booking is already pending. Complete or cancel it first.");
    }

    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const isOwner =
      (booking.userId != null && booking.userId === identity.subject) ||
      booking.customerEmail.toLowerCase() === callerEmail;

    if (!isOwner) {
      const callerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
        .first();
      if (callerCustomer?.role !== "admin") {
        throw new Error("You can only edit your own bookings.");
      }
    }

    // ── Enforce cancellation window ──────────────────────────────────────────
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const cancellationHours = settings?.cancellationHoursBefore ?? 2;
    const CLOSING_HOUR = settings?.closingHour ?? 21;

    const [year, month, day] = booking.date.split("-").map(Number);
    const whole = Math.floor(booking.startHour);
    const mins = Math.round((booking.startHour - whole) * 60);
    const bookingStart = new Date(year, month - 1, day, whole, mins, 0);
    const awstNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Australia/Perth" })
    );
    const hoursUntil = (bookingStart.getTime() - awstNow.getTime()) / (1000 * 60 * 60);

    if (hoursUntil < cancellationHours) {
      throw new Error(
        `Bookings can only be modified at least ${cancellationHours} hour${cancellationHours !== 1 ? "s" : ""} before the session starts.`
      );
    }

    // ── Validate new duration ────────────────────────────────────────────────
    const newEndHour = booking.startHour + args.newDuration / 60;
    if (newEndHour > CLOSING_HOUR) {
      throw new Error("New duration extends past closing time.");
    }
    if (args.newDuration < 60) {
      throw new Error("Minimum booking duration is 1 hour.");
    }

    // ── Conflict check when extending ────────────────────────────────────────
    if (args.newDuration > booking.duration) {
      const allLaneIds = [
        booking.laneId,
        ...(args.newAdditionalLaneIds ?? (booking as any).additionalLaneIds ?? []),
      ];
      for (const lid of allLaneIds) {
        const laneBookings = await ctx.db
          .query("bookings")
          .withIndex("by_laneId_date", (q: any) =>
            q.eq("laneId", lid).eq("date", booking.date)
          )
          .collect();
        const hasConflict = laneBookings.some((b) => {
          if (b._id.toString() === args.bookingId || b.status === "cancelled") return false;
          const bEnd = b.startHour + b.duration / 60;
          return booking.startHour < bEnd && newEndHour > b.startHour;
        });
        if (hasConflict) {
          throw new Error("Cannot extend — another booking conflicts with the new duration.");
        }
      }
    }

    // ── Price diff ───────────────────────────────────────────────────────────
    const priceDifference = args.newPriceInCents - args.oldPriceInCents;

    if (priceDifference === 0) {
      // Apply directly — no Stripe interaction needed
      await ctx.db.patch(booking._id, {
        duration: args.newDuration,
        ...(args.newAdditionalLaneIds !== undefined
          ? { additionalLaneIds: args.newAdditionalLaneIds }
          : {}),
      });
      return { requiresPayment: false, priceDifference: 0, refunded: false };
    }

    if (priceDifference < 0) {
      // Shorter booking → refund, apply immediately
      await ctx.db.patch(booking._id, {
        duration: args.newDuration,
        ...(args.newAdditionalLaneIds !== undefined
          ? { additionalLaneIds: args.newAdditionalLaneIds }
          : {}),
        priceInCents: args.newPriceInCents,
      });
      // Issue Stripe refund if we have a paymentIntentId
      const paymentIntentId = (booking as any).stripePaymentIntentId;
      if (paymentIntentId) {
        await ctx.scheduler.runAfter(0, internal.stripe.issueBookingRefund, {
          bookingId: args.bookingId,
          paymentIntentId,
          refundAmountCents: Math.abs(priceDifference),
          customerEmail: booking.customerEmail,
        });
      }
      return { requiresPayment: false, priceDifference, refunded: !!paymentIntentId };
    }

    // priceDifference > 0 → top-up required
    await ctx.db.patch(booking._id, {
      status: "pending_edit_payment",
      pendingEdit: {
        newDuration: args.newDuration,
        newAdditionalLaneIds: args.newAdditionalLaneIds,
        newPriceInCents: args.newPriceInCents,
        priceDifference,
      },
    });
    return { requiresPayment: true, priceDifference };
  },
});

// ---------------------------------------------------------------------------
// applyPendingBookingEdit — called by the Stripe webhook after top-up payment
// ---------------------------------------------------------------------------
export const applyPendingBookingEdit = internalMutation({
  args: {
    bookingId: v.string(),
    topUpStripeSessionId: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId as any);
    if (!booking) return { success: false, reason: "not_found" };

    // Idempotency: already applied
    if ((booking as any).status !== "pending_edit_payment") {
      return { success: true, alreadyApplied: true };
    }

    const pe = (booking as any).pendingEdit;
    if (!pe) return { success: false, reason: "no_pending_edit" };

    await ctx.db.patch(booking._id, {
      status: "confirmed",
      duration: pe.newDuration,
      ...(pe.newAdditionalLaneIds !== undefined
        ? { additionalLaneIds: pe.newAdditionalLaneIds }
        : {}),
      priceInCents: pe.newPriceInCents,
      pendingEdit: undefined,
    } as any);

    return { success: true };
  },
});

// ---------------------------------------------------------------------------
// applyPendingEditFromSession — public action called by the success page
// Verifies the Stripe session payment before applying the edit.
// ---------------------------------------------------------------------------
export const applyPendingEditFromSession = action({
  args: { stripeSessionId: v.string() },
  handler: async (ctx, args) => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
    const stripe = new Stripe(key);

    const session = await stripe.checkout.sessions.retrieve(args.stripeSessionId);
    if (session.payment_status !== "paid") {
      throw new Error("Payment not confirmed — cannot apply booking edit.");
    }
    const bookingId = session.metadata?.bookingId;
    if (!bookingId) throw new Error("No booking ID in session metadata.");
    if (session.metadata?.sessionType !== "booking_edit_topup") {
      throw new Error("Not a booking edit session.");
    }

    return await ctx.runMutation(internal.bookingEdit.applyPendingBookingEdit, {
      bookingId,
      topUpStripeSessionId: args.stripeSessionId,
    });
  },
});
