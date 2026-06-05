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

    return { sent, total: bookings.length };
  },
});
