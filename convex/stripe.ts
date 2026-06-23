"use node";

import { action, internalAction } from "./_generated/server";
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
    // SPEC_EMBEDDED_CHECKOUT — when true, create an embedded-UI session (rendered
    // in-app via Stripe Embedded Checkout) and return a clientSecret instead of a
    // hosted redirect URL. Optional + defaulting to the hosted flow keeps the
    // deploy non-breaking: an old frontend (no arg) still gets a redirect URL.
    embedded: v.optional(v.boolean()),
  },
  // Explicit return type breaks the circular inference introduced by the
  // internal.queries.* runQuery below (TS7022/7023), matching the pattern used
  // elsewhere in the codebase.
  handler: async (
    ctx,
    args
  ): Promise<{ sessionId: string; url: string | null; clientSecret: string | null; description: string }> => {
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

    const common: Stripe.Checkout.SessionCreateParams = {
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
    };

    // SPEC_EMBEDDED_CHECKOUT — embedded mode renders Stripe Checkout inside our own
    // modal (no redirect). It returns a clientSecret instead of a hosted URL, and
    // has no success/cancel URLs (redirect_on_completion:"never" → the client's
    // onComplete fires; the checkout.session.completed webhook stays the source of
    // truth). Abandonment is handled by the modal close → cancelUnpaidCheckout +
    // the existing quick-cancel/cron/expiry backstops. The hosted branch is the
    // unchanged redirect flow, kept as a deploy/no-publishable-key fallback.
    const session = args.embedded
      ? await stripe.checkout.sessions.create({
          ...common,
          ui_mode: "embedded",
          redirect_on_completion: "never",
        })
      : await stripe.checkout.sessions.create({
          ...common,
          success_url: `${siteUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          // SPEC_CHECKOUT_ABANDONMENT (layer 2) — backing out of Stripe lands on a
          // route that releases this booking's slot immediately, instead of leaving
          // an "Awaiting payment" slot stuck until the timer/cron.
          cancel_url: `${siteUrl}/checkout/cancel?b=${encodeURIComponent(args.bookingId)}`,
        });

    // SPEC_CHECKOUT_ABANDONMENT — record the session on the booking, then schedule
    // a quick auto-cancel. expireUnpaidCheckout expires THIS session (so the slot
    // can't be paid after release) and frees the slot if still unpaid. A "Pay now"
    // resume overwrites stripeSessionId, so this scheduled run no-ops (session
    // mismatch). The 30-min Stripe expiry + 5-min cron remain as backstops.
    await ctx.runMutation(internal.mutations.setBookingCheckoutSession, {
      bookingId: args.bookingId,
      sessionId: session.id,
    });
    const quickMs = await ctx.runQuery(internal.queries.getQuickCheckoutMs, {});
    await ctx.scheduler.runAfter(quickMs, internal.stripe.expireUnpaidCheckout, {
      bookingId: args.bookingId,
      sessionId: session.id,
    });

    return {
      sessionId: session.id,
      url: session.url,
      clientSecret: session.client_secret ?? null,
      description,
    };
  },
});

// SPEC_CHECKOUT_ABANDONMENT — expire an unpaid checkout's Stripe session and free
// its slot. Money-safe quick-cancel: actively expiring the session means a
// customer who left the payment tab open can't pay a slot we've already released
// (Stripe's minimum session lifetime is 30 min — it can't be shortened, so we
// must expire it ourselves to cancel sooner). Idempotent; safe to run twice.
export const expireUnpaidCheckout = internalAction({
  args: { bookingId: v.string(), sessionId: v.string() },
  handler: async (ctx, args): Promise<{ released: boolean; reason?: string }> => {
    const state = await ctx.runQuery(internal.queries.getBookingPaymentState, {
      bookingId: args.bookingId,
    });
    if (!state) return { released: false, reason: "not_found" };
    // Paid or already past the awaiting-payment phase → leave it alone.
    if (state.paymentStatus === "paid") return { released: false, reason: "paid" };
    if (state.status !== "pending_payment" && state.status !== "pending")
      return { released: false, reason: "not_pending" };
    // Superseded by a "Pay now" resume that created a newer session.
    if (state.stripeSessionId && state.stripeSessionId !== args.sessionId)
      return { released: false, reason: "superseded" };

    const sid = state.stripeSessionId ?? args.sessionId;
    // Inverse-race guard: the payment may have SUCCEEDED on Stripe while the
    // confirming webhook is still in flight (our DB still shows pending). Check
    // Stripe's authoritative status first — if it's paid, do NOT release; the
    // webhook will confirm it. Only release a genuinely-unpaid session.
    if (await stripeSessionIsPaid(sid)) return { released: false, reason: "paid_pending_webhook" };
    try {
      await getStripe().checkout.sessions.expire(sid);
    } catch {
      // already expired/unknown — release anyway (idempotent).
    }
    await ctx.runMutation(internal.slotHolds.releaseCheckoutBooking, {
      bookingId: args.bookingId,
    });
    return { released: true };
  },
});

// True if the Stripe Checkout session has actually been paid/completed. Used to
// avoid cancelling a booking whose payment succeeded but whose webhook is lagging.
async function stripeSessionIsPaid(sessionId: string): Promise<boolean> {
  try {
    const s = await getStripe().checkout.sessions.retrieve(sessionId);
    return s.payment_status === "paid" || s.status === "complete";
  } catch {
    return false; // unknown session → treat as unpaid (safe to release)
  }
}

// SPEC_CHECKOUT_ABANDONMENT (layers 1+2) — owner/admin-triggered cancel of an
// unpaid booking (the "Cancel" button on an Awaiting-payment card, and the Stripe
// cancel_url route). Expires the session so it can never be paid, then frees the
// slot. Refuses to touch a paid booking (use cancelBooking for those).
export const cancelUnpaidCheckout = action({
  args: { bookingId: v.string() },
  handler: async (ctx, args): Promise<{ released: boolean }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Please sign in.");
    const owner = await ctx.runQuery(internal.queries.getBookingOwner, {
      bookingId: args.bookingId,
    });
    if (!owner) return { released: false };
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const isOwner =
      (owner.userId != null && owner.userId === identity.subject) ||
      (!!callerEmail && callerEmail === owner.customerEmail);
    let isAdmin = false;
    if (!isOwner && callerEmail) {
      isAdmin = await ctx.runQuery(internal.queries.isAdminEmail, { email: callerEmail });
    }
    if (!isOwner && !isAdmin) throw new ConvexError("You can only cancel your own booking.");

    const state = await ctx.runQuery(internal.queries.getBookingPaymentState, {
      bookingId: args.bookingId,
    });
    if (!state) return { released: false };
    if (state.paymentStatus === "paid") throw new ConvexError("This booking is already paid.");
    if (state.status === "cancelled") return { released: true };
    if (state.status !== "pending_payment" && state.status !== "pending")
      throw new ConvexError("This booking is not awaiting payment.");

    if (state.stripeSessionId) {
      // Same inverse-race guard as the timer path: don't cancel a slot whose
      // payment actually went through but whose webhook hasn't landed yet.
      if (await stripeSessionIsPaid(state.stripeSessionId))
        throw new ConvexError("Your payment is being confirmed — please refresh in a moment.");
      try {
        await getStripe().checkout.sessions.expire(state.stripeSessionId);
      } catch {
        /* best-effort */
      }
    }
    await ctx.runMutation(internal.slotHolds.releaseCheckoutBooking, {
      bookingId: args.bookingId,
    });
    return { released: true };
  },
});

export const verifySession = action({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    // MON-3 (audit 2026-06): was unauthenticated — anyone with a (guessable/leaked
    // via success_url/referrer) session id could trigger a confirmation email to
    // that booking's customer and read back their PII. Now (a) auth-gated, (b) no
    // longer sends email (the Stripe webhook already does so idempotently), and
    // (c) returns only {paid,status} (no customer PII).
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required.");
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(args.sessionId);
    return {
      paid: session.payment_status === "paid",
      status: session.status,
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
