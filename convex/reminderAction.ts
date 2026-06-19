"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Cron-triggered action: check for bookings needing reminders and send emails
export const sendBookingReminders = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sent: number; total?: number }> => {
    // Get all bookings that need a reminder
    const bookings: any[] = await ctx.runQuery(
      internal.reminderQueries.getBookingsNeedingReminder,
      {}
    );

    if (bookings.length === 0) {
      return { sent: 0 };
    }

    let sent = 0;
    for (const booking of bookings) {
      try {
        // Send the reminder email
        await ctx.runAction(internal.emails.sendBookingReminder, {
          to: booking.customerEmail,
          customerName: booking.customerName,
          laneName: booking.laneName,
          date: booking.date,
          timeSlot: booking.timeSlot,
          duration: booking.durationLabel,
          accessCode: booking.accessCode,
        });

        // SPEC_PUSH_NOTIFICATIONS_V2 §3.3 — session reminder push (~22 min before),
        // DOOR CODE FIRST. The push is now the primary channel (the reminder email
        // is off by default for everyone — §3.4).
        await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
          email: booking.customerEmail,
          category: "session-reminders",
          title: "Your net starts soon 🏏",
          body: `${booking.accessCode ? `Door code ${booking.accessCode} 🔓 — ` : ""}starts in ~22 min · ${booking.laneName} ${booking.timeSlot}`,
          url: "/bookings",
          tag: `reminder-${booking.id}`,
        });

        // Mark as reminded so we don't send again
        await ctx.runMutation(internal.reminderQueries.markReminderSent, {
          bookingId: booking.id,
        });

        sent++;
      } catch (error) {
        console.error(
          `Failed to send reminder for booking ${booking.id}:`,
          error
        );
      }
    }

    // ── Phase 2: FACILITY ACCESS push — ~1 h before a customer's FIRST-ever session.
    // One-time per customer: "how to find us" with a deep link to the /access page
    // (directions, parking, getting in). Separate opt-out category "facility-access".
    try {
      const firstVisits: any[] = await ctx.runQuery(
        internal.reminderQueries.getFirstVisitBookingsForFacilityPush,
        {}
      );
      for (const fv of firstVisits) {
        try {
          await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
            email: fv.customerEmail,
            category: "facility-access",
            title: "Welcome — how to find us 🏏",
            body: `Your first session is in ~1 hour (${fv.laneName} ${fv.timeSlot}). Tap for directions, parking & getting in.`,
            url: "https://cricketrevolution.com.au/access",
            tag: `facility-access-${fv.customerId}`,
          });
          // Mark sent regardless of device availability so we don't re-query every
          // 5 min for an account with no push device (matches the reminder pattern).
          await ctx.runMutation(
            internal.reminderQueries.markFacilityAccessPushSent,
            { customerId: fv.customerId }
          );
        } catch (e) {
          console.error(`Failed facility-access push for ${fv.customerEmail}:`, e);
        }
      }
    } catch (e) {
      console.error("facility-access push phase failed:", e);
    }

    return { sent, total: bookings.length };
  },
});
