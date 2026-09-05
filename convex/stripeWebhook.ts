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
 *   - checkout.session.async_payment_succeeded   (Prior-H1, 2026-09-05 — harmless
 *   - checkout.session.async_payment_failed        if never enabled: card-only today)
 *   - checkout.session.expired
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

  // Prior-H1 (BACKEND review 2026-09-05): a Checkout session is only money once
  // `payment_status === "paid"`. `checkout.session.completed` also fires for
  // delayed-notification methods with payment_status "unpaid" (the funds arrive —
  // or never arrive — days later via checkout.session.async_payment_succeeded /
  // _failed), and for $0 sessions as "no_payment_required". Confirming a booking,
  // recording a stripePayments row or bumping a top-up on anything but "paid"
  // would hand out a door code for money that has not landed. Both session
  // creators are card-only, so in practice only "paid" ever arrives; this is the
  // server-side guarantee of that, not the mechanism.
  const handlePaidCheckoutSession = async (session: Stripe.Checkout.Session) => {
    const bookingId = session.metadata?.bookingId;
    // A top-up (admin extended an existing, already-confirmed booking) must NOT
    // run confirmBookingPayment — that path no-ops on an already-paid booking
    // (so the extra payment would vanish) and would try to re-confirm/re-sync.
    const isTopUp = session.metadata?.topup === "true";
    if (bookingId) {
      // Best-effort: pull the Stripe-hosted receipt URL off the charge so the
      // customer Payments screen can link to it. Never block confirmation on it.
      let receiptUrl: string | undefined;
      try {
        if (session.payment_intent) {
          const pi = await stripe.paymentIntents.retrieve(
            session.payment_intent as string,
            { expand: ["latest_charge"] }
          );
          const charge = pi.latest_charge as Stripe.Charge | null;
          receiptUrl = charge?.receipt_url ?? undefined;
        }
      } catch (e: any) {
        console.warn("[stripe-webhook] could not fetch receipt_url:", e?.message);
      }
      if (isTopUp) {
        await ctx.runMutation(internal.webhooks.recordTopUpPayment, {
          bookingId,
          stripeSessionId: session.id,
          amountPaid: session.amount_total ?? 0,
          currency: session.currency ?? "aud",
          receiptUrl,
        });
      } else {
        await ctx.runMutation(internal.webhooks.confirmBookingPayment, {
          bookingId,
          stripeSessionId: session.id,
          amountPaid: session.amount_total ?? 0,
          currency: session.currency ?? "aud",
          receiptUrl,
        });
      }
    } else {
      console.warn("[stripe-webhook] checkout.session.completed without bookingId metadata");
    }

    // SPEC_PAYMENT_LINK_TRACKING_2026-07 — if this session was spawned by a
    // Stripe Payment Link (admin-sent top-up / manual payment request), flip
    // the tracked link to 'paid' and DEACTIVATE it on Stripe. Payment Links
    // are reusable URLs that never expire — without deactivation a second
    // open would spawn a NEW session and charge the customer again (the
    // session-level dedupe in recordTopUpPayment can't catch a different
    // session id). Best-effort: never fail the webhook over tracking.
    const paymentLinkId =
      typeof (session as any).payment_link === "string"
        ? ((session as any).payment_link as string)
        : ((session as any).payment_link?.id as string | undefined);
    if (paymentLinkId) {
      let receiptUrlForLink: string | undefined;
      try {
        if (session.payment_intent) {
          const pi = await stripe.paymentIntents.retrieve(
            session.payment_intent as string,
            { expand: ["latest_charge"] }
          );
          receiptUrlForLink =
            (pi.latest_charge as Stripe.Charge | null)?.receipt_url ?? undefined;
        }
      } catch {
        /* best-effort */
      }
      try {
        await ctx.runMutation(internal.paymentLinks.markPaidInternal, {
          stripePaymentLinkId: paymentLinkId,
          stripeSessionId: session.id,
          receiptUrl: receiptUrlForLink,
        });
      } catch (e: any) {
        console.warn("[stripe-webhook] paymentLinks.markPaid failed:", e?.message);
      }
      try {
        await stripe.paymentLinks.update(paymentLinkId, { active: false });
      } catch (e: any) {
        console.warn("[stripe-webhook] payment link deactivate failed:", e?.message);
      }
    }
  };

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== "paid") {
          // "unpaid" = delayed method still settling (wait for
          // async_payment_succeeded); "no_payment_required" = a $0 session, which
          // this app never creates (createCheckoutSession refuses < A$0.50) and
          // must not confirm anything.
          console.warn(
            `[stripe-webhook] checkout.session.completed ${session.id} with payment_status=${session.payment_status} — not confirming`
          );
          break;
        }
        await handlePaidCheckoutSession(session);
        break;
      }

      case "checkout.session.async_payment_succeeded": {
        // Delayed-notification method finally settled. Same idempotent path as a
        // card payment (confirmBookingPayment / recordTopUpPayment no-op on a
        // session already recorded).
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== "paid") break;
        await handlePaidCheckoutSession(session);
        break;
      }

      case "checkout.session.async_payment_failed": {
        // Delayed-notification payment bounced. The booking never confirmed (the
        // completed event was ignored above), so the normal hold expiry / release
        // sweep frees the slot; nothing to unwind here beyond logging it.
        const session = event.data.object as Stripe.Checkout.Session;
        console.warn(
          `[stripe-webhook] async payment FAILED for session ${session.id} (booking ${session.metadata?.bookingId ?? "?"})`
        );
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        const bookingId = session.metadata?.bookingId;
        if (bookingId) {
          // MON-1: pass the EXPIRING session id so a stale expiry can't cancel a
          // booking whose customer resumed with a newer "Pay now" session.
          await ctx.runMutation(internal.slotHolds.releaseCheckoutBooking, {
            bookingId,
            stripeSessionId: session.id,
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
