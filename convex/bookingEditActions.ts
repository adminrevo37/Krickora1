"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import Stripe from "stripe";

// ---------------------------------------------------------------------------
// applyPendingEditFromSession — public action called by the success page.
// Verifies the Stripe session payment before applying the edit.
// Must live in a "use node" file because it uses the Stripe SDK.
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
