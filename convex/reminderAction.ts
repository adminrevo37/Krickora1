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
          calendarUrl: "https://krickora.com",
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
