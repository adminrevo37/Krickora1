"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import Stripe from "stripe";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key);
}

export const createCheckoutSession = action({
  args: {
    laneName: v.string(),
    variantName: v.optional(v.string()),
    date: v.string(),
    startHour: v.number(),
    duration: v.number(),
    customerName: v.string(),
    customerEmail: v.string(),
    priceInCents: v.number(),
    additionalLanes: v.optional(v.array(v.string())),
    isCoachBooking: v.optional(v.boolean()),
    bookingId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const stripe = getStripe();

    const formatHour = (h: number) => {
      const whole = Math.floor(h);
      const mins = (h - whole) * 60;
      const period = whole >= 12 ? "pm" : "am";
      const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
      return mins > 0 ? `${display}:${mins.toString().padStart(2, "0")}${period}` : `${display}${period}`;
    };

    const endHour = args.startHour + args.duration / 60;
    const durationLabel = args.duration >= 60
      ? `${Math.floor(args.duration / 60)}hr${args.duration % 60 > 0 ? ` ${args.duration % 60}min` : ""}`
      : `${args.duration}min`;
    const variantLabel = args.variantName ? ` (${args.variantName})` : "";
    const additionalLabel = args.additionalLanes && args.additionalLanes.length > 0
      ? ` + ${args.additionalLanes.join(", ")}`
      : "";

    const description = `${args.laneName}${variantLabel}${additionalLabel} - ${args.date} ${formatHour(args.startHour)}-${formatHour(endHour)} (${durationLabel})`;

    const siteUrl = process.env.SITE_URL || "http://localhost:5173";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: args.customerEmail,
      line_items: [
        {
          price_data: {
            currency: "aud",
            product_data: {
              name: `${args.isCoachBooking ? "Coach Session" : "Net Session"} - ${args.laneName}${variantLabel}`,
              description,
            },
            unit_amount: args.priceInCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookingId: args.bookingId || "",
        laneName: args.laneName,
        date: args.date,
        startHour: String(args.startHour),
        duration: String(args.duration),
        customerName: args.customerName,
        customerEmail: args.customerEmail,
        isCoachBooking: args.isCoachBooking ? "true" : "false",
      },
      success_url: `${siteUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: siteUrl,
    });

    return {
      sessionId: session.id,
      url: session.url,
      description,
    };
  },
});

export const verifySession = action({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(args.sessionId);
    const paid = session.payment_status === "paid";

    // Send payment confirmation email on successful checkout (idempotent guard via Stripe metadata flag)
    if (paid && session.customer_email && !session.metadata?.paymentEmailSent) {
      try {
        const amount = session.amount_total != null
          ? `$${(session.amount_total / 100).toFixed(2)} ${(session.currency || "AUD").toUpperCase()}`
          : "";
        const description = session.metadata?.laneName
          ? `${session.metadata.laneName} — ${session.metadata.date ?? ""}`
          : "Krickora booking";
        const customerName = session.metadata?.customerName || "there";
        const paymentDate = new Date().toLocaleDateString("en-US", {
          year: "numeric", month: "long", day: "numeric",
        });
        await ctx.runAction(internal.emails.sendPaymentConfirmation, {
          to: session.customer_email,
          customerName,
          amount,
          description,
          reference: session.id,
          paymentDate,
        });
        // Mark sent to avoid duplicates if verifySession is called again
        await stripe.checkout.sessions.update(args.sessionId, {
          metadata: { ...(session.metadata || {}), paymentEmailSent: "true" },
        });
      } catch (err) {
        console.error("[payment-confirmation] Failed to send:", err);
      }
    }

    return {
      paid,
      status: session.status,
      customerEmail: session.customer_email,
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
    };
  },
});

export const createPaymentLink = action({
  args: {
    laneName: v.string(),
    variantName: v.optional(v.string()),
    date: v.string(),
    startHour: v.number(),
    duration: v.number(),
    customerName: v.string(),
    customerEmail: v.string(),
    priceInCents: v.number(),
    bookingId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const stripe = getStripe();

    const formatHour = (h: number) => {
      const whole = Math.floor(h);
      const mins = (h - whole) * 60;
      const period = whole >= 12 ? "pm" : "am";
      const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
      return mins > 0 ? `${display}:${mins.toString().padStart(2, "0")}${period}` : `${display}${period}`;
    };

    const endHour = args.startHour + args.duration / 60;
    const durationLabel = args.duration >= 60
      ? `${Math.floor(args.duration / 60)}hr${args.duration % 60 > 0 ? ` ${args.duration % 60}min` : ""}`
      : `${args.duration}min`;
    const variantLabel = args.variantName ? ` (${args.variantName})` : "";
    const description = `${args.laneName}${variantLabel} - ${args.date} ${formatHour(args.startHour)}-${formatHour(endHour)} (${durationLabel})`;

    const siteUrl = process.env.SITE_URL || "http://localhost:5173";

    // Payment Links require a pre-saved price, so we create a one-off product/price
    // and immediately archive them to keep the Stripe dashboard clean.
    // Archiving does NOT break existing payment links — they remain functional.
    const product = await stripe.products.create({
      name: `Net Session - ${args.laneName}${variantLabel}`,
      description,
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: args.priceInCents,
      currency: "aud",
    });

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: {
        bookingId: args.bookingId || "",
        customerName: args.customerName,
        customerEmail: args.customerEmail,
      },
      after_completion: {
        type: "redirect",
        redirect: { url: `${siteUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}` },
      },
    });

    // Archive the one-off product/price so they don't pollute the Stripe dashboard
    try {
      await stripe.prices.update(price.id, { active: false });
      await stripe.products.update(product.id, { active: false });
    } catch (archiveErr) {
      console.warn("[createPaymentLink] Could not archive product/price:", archiveErr);
    }

    return {
      url: paymentLink.url,
      description,
    };
  },
});

export const listRecentPayments = action({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const stripe = getStripe();
    // Use payment_intents instead of the deprecated charges.list
    const paymentIntents = await stripe.paymentIntents.list({
      limit: args.limit || 50,
    });
    return paymentIntents.data.map((pi) => ({
      id: pi.id,
      amount: pi.amount,
      currency: pi.currency,
      status: pi.status,
      customerEmail: (pi as any).receipt_email || "",
      description: pi.description || "",
      created: pi.created,
      metadata: pi.metadata,
      receiptUrl: undefined as string | undefined,
    }));
  },
});
