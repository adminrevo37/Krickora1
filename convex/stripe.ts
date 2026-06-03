"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import Stripe from "stripe";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ConvexError("STRIPE_SECRET_KEY not configured");
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
  // Explicit return type breaks the circular inference introduced by the
  // internal.queries.* runQuery below (TS7022/7023), matching the pattern used
  // elsewhere in the codebase.
  handler: async (
    ctx,
    args
  ): Promise<{ sessionId: string; url: string | null; description: string }> => {
    const stripe = getStripe();

    // R1 — SERVER-AUTHORITATIVE CHARGE. Never charge the client-supplied price.
    // Derive the amount entirely from the booking's server-computed price (set in
    // createBooking) minus the customer's server-clamped credit. The client value
    // (args.priceInCents) is ignored for the charge.
    if (!args.bookingId) {
      throw new ConvexError("A booking must be created before checkout.");
    }

    // LOW (SEC audit 2026-06-03): assert the caller owns the booking they're
    // paying for. The amount is already server-authoritative (R1), so this is
    // defence-in-depth against crafting a checkout for someone else's booking.
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Please sign in to check out.");
    const owner = await ctx.runQuery(internal.queries.getBookingOwner, {
      bookingId: args.bookingId,
    });
    if (owner) {
      const callerEmail = identity.email?.toLowerCase().trim() ?? "";
      const isOwner =
        (owner.userId != null && owner.userId === identity.subject) ||
        (!!callerEmail && callerEmail === owner.customerEmail);
      let isAdmin = false;
      if (!isOwner && callerEmail) {
        isAdmin = await ctx.runQuery(internal.queries.isAdminEmail, { email: callerEmail });
      }
      if (!isOwner && !isAdmin) {
        throw new ConvexError("You can only pay for your own booking.");
      }
    }

    const amountToChargeCents: number | null = await ctx.runQuery(
      internal.queries.getCheckoutAmountCents,
      { bookingId: args.bookingId }
    );
    if (amountToChargeCents == null) {
      throw new ConvexError("Booking not found for checkout.");
    }
    if (amountToChargeCents < 50) {
      // Below Stripe's A$0.50 minimum — a $0 booking should use the free/comp path,
      // not Stripe. Guards against a fully credit/discount-covered booking reaching here.
      throw new ConvexError("This booking does not require a card payment.");
    }

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
      // Stripe minimum is 30 min from now. When it lapses, the
      // checkout.session.expired webhook releases the held slot (the cron
      // backstop releases earlier per abandonedCheckoutMinutes).
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      customer_email: args.customerEmail,
      line_items: [
        {
          price_data: {
            currency: "aud",
            product_data: {
              name: `${args.isCoachBooking ? "Coach Session" : "Net Session"} - ${args.laneName}${variantLabel}`,
              description,
            },
            unit_amount: amountToChargeCents,
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
  handler: async (
    ctx,
    args
  ): Promise<{ url: string; description: string }> => {
    // ADMIN ONLY. This mints a Stripe payment link for an arbitrary amount and is
    // used solely by the admin manual-booking "send payment request" flow. Without
    // this guard a customer could call it directly to pay $0.01 for a booking.
    const plIdentity = await ctx.auth.getUserIdentity();
    const plEmail = plIdentity?.email?.toLowerCase?.().trim?.() ?? "";
    const plIsAdmin = plEmail
      ? await ctx.runQuery(internal.queries.isAdminEmail, { email: plEmail })
      : false;
    if (!plIsAdmin) throw new ConvexError("Not authorized — admin only.");

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

    return {
      url: paymentLink.url,
      description,
    };
  },
});

export const listRecentPayments = action({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any[]> => {
    // ADMIN ONLY — returns every customer's charge data (emails, amounts, receipts).
    const lrpIdentity = await ctx.auth.getUserIdentity();
    const lrpEmail = lrpIdentity?.email?.toLowerCase?.().trim?.() ?? "";
    const lrpIsAdmin = lrpEmail
      ? await ctx.runQuery(internal.queries.isAdminEmail, { email: lrpEmail })
      : false;
    if (!lrpIsAdmin) throw new ConvexError("Not authorized — admin only.");

    const stripe = getStripe();
    const charges = await stripe.charges.list({
      limit: args.limit || 50,
    });
    return charges.data.map((charge) => ({
      id: charge.id,
      amount: charge.amount,
      currency: charge.currency,
      status: charge.status,
      customerEmail: charge.billing_details?.email || charge.receipt_email || "",
      description: charge.description || "",
      created: charge.created,
      metadata: charge.metadata,
      receiptUrl: charge.receipt_url,
    }));
  },
});
