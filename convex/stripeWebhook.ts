import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import Stripe from "stripe";

/**
 * Stripe webhook handler.
 *
 * Required env vars:
 *   - STRIPE_SECRET_KEY
 *   - STRIPE_WEBHOOK_SECRET  (from Stripe Dashboard → Developers → Webhooks)
 *
 * Endpoint URL to register in Stripe:
 *   https://<your-convex-deployment>.convex.site/stripe/webhook
 *
 * Events to subscribe:
 *   - checkout.session.completed
 *   - payment_intent.payment_failed
 */
export const stripeWebhook = httpAction(async (ctx, request) => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    console.error("[stripe-webhook] Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return new Response("Webhook not configured", { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  // Read raw body for signature verification
  const rawBody = await request.text();

  const stripe = new Stripe(secretKey);
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err: any) {
    console.error("[stripe-webhook] Signature verification failed:", err?.message);
    return new Response(`Webhook signature verification failed: ${err?.message}`, {
      status: 400,
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const bookingId = session.metadata?.bookingId;
        const sessionType = session.metadata?.sessionType ?? "booking";

        if (!bookingId) {
          console.warn("[stripe-webhook] checkout.session.completed without bookingId metadata");
          break;
        }

        if (sessionType === "booking_edit_topup") {
          // Top-up payment for a booking edit — apply the pending edit
          await ctx.runMutation(internal.bookingEdit.applyPendingBookingEdit, {
            bookingId,
            topUpStripeSessionId: session.id,
          });
        } else {
          // Regular booking payment
          await ctx.runMutation(internal.webhooks.confirmBookingPayment, {
            bookingId,
            stripeSessionId: session.id,
            amountPaid: session.amount_total ?? 0,
            currency: session.currency ?? "aud",
          });
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const intent = event.data.object as Stripe.PaymentIntent;
        const bookingId = intent.metadata?.bookingId;
        if (bookingId) {
          await ctx.runMutation(internal.webhooks.markBookingPaymentFailed, {
            bookingId,
            stripeSessionId: intent.id,
          });
        }
        break;
      }

      default:
        // Ignore other events
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[stripe-webhook] Handler error:", err?.message ?? err);
    // Return 500 so Stripe retries
    return new Response(`Handler error: ${err?.message ?? "unknown"}`, { status: 500 });
  }
});
