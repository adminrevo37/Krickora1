import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { sendTemplateEmail } from "./lib/email";
// EML-1 (audit 2026-06): shared snapshot-aware lane name (the local map below used
// yet another spelling — "Run-up Lane N" — and ignored laneNameSnapshot).
import { laneNameForBooking } from "./lib/lanes";

// AWST = UTC+8, no DST
function nowInAWST(): Date {
  const now = new Date();
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
}

function formatDateLong(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatHour(h: number): string {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  const period = hr >= 12 ? "PM" : "AM";
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${display}:${min.toString().padStart(2, "0")} ${period}`;
}

export const sendWeeklyBookingSummaries = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sent: number; skipped: number }> => {
    // Compute week ahead in AWST: today through today + 6 days
    const awstNow = nowInAWST();
    const startDate = ymd(awstNow);
    const endDateObj = addDays(awstNow, 6);
    const endDate = ymd(endDateObj);

    const weekRange = `${formatDateLong(startDate)} – ${formatDateLong(endDate)}`;

    // Fetch all bookings and customers
    const allBookings: any[] = await ctx.runQuery(
      internal.weeklySummaryQueries.getUpcomingBookingsForWeek,
      { startDate, endDate }
    );
    const customers: any[] = await ctx.runQuery(
      internal.weeklySummaryQueries.getAllCustomersWithEmail,
      {}
    );

    // Group bookings by customer email (lowercase)
    const byEmail = new Map<string, any[]>();
    for (const b of allBookings) {
      if (b.status === "cancelled") continue;
      const key = (b.customerEmail || "").toLowerCase().trim();
      if (!key) continue;
      if (!byEmail.has(key)) byEmail.set(key, []);
      byEmail.get(key)!.push(b);
    }

    let sent = 0;
    let skipped = 0;

    for (const customer of customers) {
      const email = (customer.email || "").toLowerCase().trim();
      if (!email) continue;
      const bookings = byEmail.get(email);
      if (!bookings || bookings.length === 0) {
        skipped++;
        continue;
      }

      // Sort by date then startHour
      bookings.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.startHour - b.startHour;
      });

      const rowsHtml = bookings
        .map((b) => {
          const start = formatHour(b.startHour);
          const end = formatHour(b.startHour + b.duration / 60);
          return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:2px;"><tr><td style="padding:8px 0;border-bottom:1px solid #e2e6ea;"><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#6a7480;font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${formatDateLong(b.date)}</p><p style="margin:2px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#10151c;font-size:14.5px;font-weight:600;">${laneNameForBooking(b)} · ${start} – ${end}</p></td></tr></table>`;
        })
        .join("");

      const result = await ctx.runAction(internal.weeklySummary.sendOne, {
        to: email,
        customerName: customer.name || "there",
        // SPEC_NAME_SPLIT: thread the real stored firstName for the greeting.
        firstName: (customer as any).firstName ?? "",
        bookingCount: String(bookings.length),
        weekRange,
        bookingsHtml: rowsHtml,
      });
      if (result.success) sent++;
      else skipped++;
    }

    console.log(`[weekly-summary] Sent: ${sent}, Skipped: ${skipped}`);
    return { sent, skipped };
  },
});

import { v } from "convex/values";

export const sendOne = internalAction({
  args: {
    to: v.string(),
    customerName: v.string(),
    firstName: v.optional(v.string()),
    bookingCount: v.string(),
    weekRange: v.string(),
    bookingsHtml: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string }> => {
    // Bug 7: the weekly summary sends DIRECTLY (bypassing emailEnabledForUser), so
    // gate it on the master switch + any per-template opt-out explicitly here.
    const allowed = await ctx
      .runQuery(internal.emails.getEmailPrefInternal, { email: args.to, templateSlug: "weekly-booking-summary" })
      .catch(() => true);
    if (!allowed) return { success: false, reason: "opted_out" };
    const result = await sendTemplateEmail("weekly-booking-summary", args.to, {
      customerName: args.customerName,
      firstName: args.firstName ?? "",
      bookingCount: args.bookingCount,
      weekRange: args.weekRange,
      bookingsHtml: args.bookingsHtml,
      bookingUrl: "https://cricketrevolution.com.au",
    });
    return { success: result.success, reason: result.reason };
  },
});
