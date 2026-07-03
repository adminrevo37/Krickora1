import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { redeemCredit } from "./lib/credit";
import { recordDiscountRedemption } from "./lib/discounts";
import { releaseHoldForBooking } from "./lib/slotHolds";
import { scheduleWaitlistAdvance } from "./waitlist";
import { applyBookingChange, fmtHour12, durationLabel, fmtAwstDateLabel } from "./mutations";
import { laneNameForBooking } from "./lib/lanes";

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
    receiptUrl: v.optional(v.string()),
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

    // SAFETY backstop (audit 2026-06-10 money-hole #1): a payment confirmed for a
    // booking that is no longer live. The abandoned-checkout sweep (or a cancel)
    // already terminated it and its slot may have been re-booked. The timing fix
    // (hold window ≥ Stripe session lifetime, lib/slotHolds.ts) makes this rare,
    // but clock skew / a late Stripe retry could still land here. Do NOT run the
    // normal confirm side-effects — that would send a false "Booking confirmed"
    // and redeem account credit against a dead booking. Instead: record the money
    // so it's traceable, flag the booking for an admin refund, and alert. Setting
    // paymentStatus:"paid" also makes any Stripe retry hit the idempotency no-op
    // above. (Coaches don't pay, so this is customer-only by construction.)
    if (b.status === "cancelled") {
      await ctx.db.patch(booking._id, {
        paymentStatus: "paid",
        stripeSessionId: args.stripeSessionId,
        needsRefund: true,
      } as any);
      if (b.customerEmail) {
        const currency = (args.currency ?? "AUD").toUpperCase();
        const laneName = b.laneNameSnapshot ?? String(b.laneId).toUpperCase();
        await ctx.runMutation(internal.mutations.recordStripePaymentInternal, {
          bookingId: booking._id.toString(),
          stripeSessionId: args.stripeSessionId,
          customerEmail: b.customerEmail,
          customerName: b.customerName ?? "Customer",
          amount: args.amountPaid / 100,
          currency,
          // MON-5 (audit 2026-06): this charge is awaiting refund, NOT revenue. A
          // distinct status keeps it out of getRevenueDashboard's paid/complete sum
          // (the description already says REFUND DUE; the booking.needsRefund flag +
          // admin alert still drive the refund workflow).
          status: "refund_due",
          laneName,
          date: b.date,
          description: `REFUND DUE — payment received after booking cancelled (${b.date})`,
          receiptUrl: args.receiptUrl,
        });
      }
      await ctx.scheduler.runAfter(0, internal.push.sendAdminPush, {
        title: "⚠️ Refund needed — paid after cancel",
        body: `${b.customerName ?? b.customerEmail ?? "A customer"} paid for a CANCELLED booking (${b.laneNameSnapshot ?? b.laneId} ${b.date}). Refund required.`,
        url: "/rev-ops-7k2p",
        tag: `refund-${booking._id.toString()}`,
      });
      console.error(
        `[webhook] PAYMENT FOR CANCELLED BOOKING ${booking._id.toString()} — flagged needsRefund, admin alerted`
      );
      return { success: true, orphanedPayment: true };
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
        // Slot now confirmed at the new time — clear any waitlist for it (#6).
        await scheduleWaitlistAdvance(ctx, {
          laneId: newLaneId,
          date: newDate,
          startHour: newStartHour,
          duration: pe.newDuration ?? b.duration,
        });
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

    if (b.status === "pending_payment" || b.status === "pending") {
      patch.status = "confirmed";
      patch.priceInCents = args.amountPaid; // store Stripe-confirmed amount for future edit calculations
    }

    await ctx.db.patch(booking._id, patch);

    // BUGFIX 2026-06-22: create the Google Calendar event now that payment has
    // confirmed. Customer Stripe bookings are created as `pending_payment` with NO
    // calendar event (createBooking only syncs CONFIRMED bookings); coach bookings
    // confirm instantly so they got their event at create time. This step was
    // missing here, so every Stripe-paid customer booking had no GCal event → HA
    // never loaded the door code and never fired the bowling-machine power. Mirrors
    // the createBooking sync. Idempotent: the `paymentStatus === "paid"` guard above
    // means this runs exactly once per booking, so no duplicate events.
    if (patch.status === "confirmed") {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.createCalendarEvent, {
        bookingId: booking._id.toString(),
        laneId: b.laneId,
        variantId: b.variantId,
        date: b.date,
        startHour: b.startHour,
        duration: b.duration,
        customerName: b.customerName ?? "Customer",
        customerEmail: b.customerEmail ?? "",
        customerPhone: b.customerPhone,
        status: "confirmed",
        isCoachBooking: b.isCoachBooking === true,
        accessCode: b.accessCode,
        additionalLaneIds: b.additionalLaneIds,
        laneNameSnapshot: b.laneNameSnapshot,
        variantLabelSnapshot: b.variantLabelSnapshot,
        // CAL-1: strip to the validator's shape (raw stored slots carry athleteId/
        // suburb that fail createCalendarEvent's arg validation → no event).
        athleteSlots: (b.athleteSlots as any[] | undefined)?.map((s: any) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
      });
    }

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

    // SPEC_WAITLIST_OFFER_REDESIGN #6: the slot is now confirmed/paid — clear the
    // waitlist for it (waiting on a filled slot is moot; members re-add if it
    // reopens). If the booker was the offeree, this also retires the queue.
    if (patch.status === "confirmed") {
      await scheduleWaitlistAdvance(ctx, {
        laneId: b.laneId,
        date: b.date,
        startHour: b.startHour,
        duration: b.duration,
      });
    }

    // Send payment confirmation email
    if (b.customerEmail) {
      const currency = (args.currency ?? "AUD").toUpperCase();
      const amount = `$${(args.amountPaid / 100).toFixed(2)} ${currency}`;
      // EML-1 (audit 2026-06): shared snapshot-aware resolver (was a 4th local
      // lane-name map with yet another spelling — "Bowling Machine Lane 1"). Still
      // snapshot-first; legacy snapshot-less rows now get the canonical default name.
      const laneName = laneNameForBooking(b);
      const description = `${laneName} — ${b.date}`;
      const paymentDate = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      // ONE merged email: door code + session details up top, payment receipt
      // below. The paid-booking path (this branch) always has the session +
      // door code, so the customer's single confirmation email carries the code.
      const endHour = b.startHour + b.duration / 60;
      await ctx.scheduler.runAfter(0, internal.emails.sendPaymentConfirmation, {
        to: b.customerEmail,
        customerName: b.customerName ?? "there",
        amount,
        description,
        reference: args.stripeSessionId,
        paymentDate,
        laneName,
        date: fmtAwstDateLabel(b.date),
        timeSlot: `${fmtHour12(b.startHour)} - ${fmtHour12(endHour)}`,
        duration: durationLabel(b.duration),
        ...(b.accessCode ? { accessCode: String(b.accessCode) } : {}),
      });

      // R4: record the authoritative payment row (Stripe-verified amount/status)
      // so customer-revenue analytics has a data source. Idempotent per booking.
      await ctx.runMutation(internal.mutations.recordStripePaymentInternal, {
        bookingId: booking._id.toString(),
        stripeSessionId: args.stripeSessionId,
        customerEmail: b.customerEmail,
        customerName: b.customerName ?? "Customer",
        amount: args.amountPaid / 100, // dollars (analytics sums this alongside coach $)
        currency,
        status: "paid",
        laneName,
        date: b.date,
        description,
        receiptUrl: args.receiptUrl,
      });

      // SPEC_PWA_PUSH §5.1 — booking confirmation + door code push (customer).
      // The email receipt above is the payment confirmation; this is the
      // booking-confirmation push the customer sees once the card payment clears.
      if (patch.status === "confirmed" && !b.isCoachBooking) {
        await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
          email: b.customerEmail,
          category: "booking-confirmation",
          title: "Booking confirmed 🏏",
          body: `${b.laneNameSnapshot ?? laneName} · ${b.date}${b.accessCode ? ` · Door code ${b.accessCode}` : ""}`,
          url: "/bookings",
          tag: `booking-${booking._id.toString()}`,
        });
      }
    }

    return { success: true, alreadyPaid: false };
  },
});

/**
 * Reconcile a TOP-UP payment on an ALREADY-CONFIRMED booking (e.g. an admin
 * extended a customer's session and sent them a payment link for the difference).
 * Deliberately NOT confirmBookingPayment: that path no-ops on an already-paid
 * booking, re-confirms, and re-syncs the calendar — none of which we want for a
 * top-up. Here we just record the extra payment as a DISTINCT row and bump the
 * stored price so future edit-diffs are correct. The booking/calendar/door code are
 * already correct (the admin's modify did that). Idempotent on the Stripe session id
 * (recordStripePaymentInternal dedupes by bookingId, so a top-up — which shares the
 * booking with the original payment — needs session-level dedup instead).
 */
export const recordTopUpPayment = internalMutation({
  args: {
    bookingId: v.string(),
    stripeSessionId: v.string(),
    amountPaid: v.number(), // cents
    currency: v.optional(v.string()),
    receiptUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId as any);
    if (!booking) {
      console.warn(`[webhook] Top-up for missing booking: ${args.bookingId}`);
      return { success: false, reason: "booking_not_found" };
    }
    const b = booking as any;

    // Idempotency: a webhook retry of the SAME top-up session must not double-record
    // the payment or double-bump the price.
    const existingForBooking = await ctx.db
      .query("stripePayments")
      .withIndex("by_bookingId", (q: any) => q.eq("bookingId", args.bookingId))
      .collect();
    if (existingForBooking.some((p: any) => p.stripeSessionId === args.stripeSessionId)) {
      return { success: true, alreadyRecorded: true };
    }

    const currency = (args.currency ?? "AUD").toUpperCase();
    const laneName = laneNameForBooking(b);
    const amountDollars = args.amountPaid / 100;

    // Record the extra payment as its own row (revenue/statements/receipts).
    await ctx.db.insert("stripePayments", {
      bookingId: args.bookingId,
      stripeSessionId: args.stripeSessionId,
      customerEmail: (b.customerEmail ?? "").toLowerCase().trim(),
      customerName: b.customerName ?? "Customer",
      amount: amountDollars,
      currency,
      status: "paid",
      laneName,
      date: b.date,
      description: `Session extension top-up — ${laneName} ${b.date}`,
      receiptUrl: args.receiptUrl,
    } as any);

    // Reflect the new total paid on the booking so a later edit-diff is correct.
    await ctx.db.patch(booking._id, {
      priceInCents: (b.priceInCents ?? 0) + args.amountPaid,
    } as any);

    // Receipt to the customer.
    if (b.customerEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendPaymentConfirmation, {
        to: b.customerEmail,
        customerName: b.customerName ?? "there",
        amount: `$${amountDollars.toFixed(2)} ${currency}`,
        description: `Session extension — ${laneName} ${b.date}`,
        reference: args.stripeSessionId,
        paymentDate: new Date().toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
      });
    }

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

    // C4: a failed MODIFY top-up must not wedge the booking. The original slot is
    // still a valid CONFIRMED (already-paid) booking — only the unpaid change is
    // abandoned. Revert to confirmed + clear the pending edit + drop the edit's
    // checkout hold (mirrors releaseAbandonedBooking), and do NOT mark the original
    // as failed. Handled before the paid/failed noop guard, since the original is paid.
    if (b.status === "pending_edit_payment") {
      await ctx.db.patch(booking._id, { status: "confirmed", pendingEdit: undefined });
      const editHolds = await ctx.db
        .query("slotHolds")
        .withIndex("by_bookingId", (q: any) => q.eq("bookingId", booking._id.toString()))
        .collect();
      for (const h of editHolds) await ctx.db.delete(h._id);
      return { success: true, reverted: true };
    }

    if (b.paymentStatus === "failed" || b.paymentStatus === "paid") {
      return { success: true, noop: true };
    }

    await ctx.db.patch(booking._id, {
      paymentStatus: "failed",
      ...(args.stripeSessionId ? { stripeSessionId: args.stripeSessionId } : {}),
    });

    // SPEC_PWA_PUSH §5.1 — admin operational alert (payment failed).
    await ctx.scheduler.runAfter(0, internal.push.sendAdminPush, {
      title: "Payment failed",
      body: `${b.customerName ?? b.customerEmail ?? "A customer"} — ${b.laneNameSnapshot ?? b.laneId} ${b.date}.`,
      url: "/rev-ops-7k2p",
      tag: `payfail-${booking._id.toString()}`,
    });

    return { success: true };
  },
});
