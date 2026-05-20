import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

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

const LANE_NAMES: Record<string, string> = {
  bm1: "Bowling Machine 1",
  bm2: "Bowling Machine 2",
  bm3: "Bowling Machine 3",
  ru1: "9m Run Up 1",
  ru2: "9m Run Up 2",
};

function laneName(id: string): string {
  return LANE_NAMES[id] ?? id.toUpperCase();
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
          return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;"><tr><td style="padding:12px 14px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:6px;"><p style="margin:0 0 4px;color:#1e3a5f;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${formatDateLong(b.date)}</p><p style="margin:0;color:#1a1a1a;font-size:14px;font-weight:600;">${laneName(b.laneId)} · ${start} – ${end}</p></td></tr></table>`;
        })
        .join("");

      // Respect per-user email preferences — check opt-out for weekly summaries
      const emailPrefs: Array<{ slug: string; enabled: boolean }> = (customer as any).emailPrefs ?? [];
      const summaryPref = emailPrefs.find((p) => p.slug === "weekly-booking-summary");
      if (summaryPref && !summaryPref.enabled) {
        skipped++;
        continue;
      }

      const result = await ctx.runAction(internal.weeklySummary.sendOne, {
        to: email,
        customerName: customer.name || "there",
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
    bookingCount: v.string(),
    weekRange: v.string(),
    bookingsHtml: v.string(),
  },
  handler: async (_ctx, args): Promise<{ success: boolean; reason?: string }> => {
    const url = process.env.SHIPPER_EMAIL_URL;
    if (!url || !process.env.SHIPPER_EMAIL_TOKEN) {
      return { success: false, reason: "Email not configured" };
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shipper-Token": process.env.SHIPPER_EMAIL_TOKEN,
      },
      body: JSON.stringify({
        to: args.to,
        templateSlug: "weekly-booking-summary",
        templateData: {
          customerName: args.customerName,
          bookingCount: args.bookingCount,
          weekRange: args.weekRange,
          bookingsHtml: args.bookingsHtml,
          bookingUrl: "https://krickora.com",
        },
      }),
    });
    if (!response.ok) {
      return { success: false, reason: `HTTP ${response.status}` };
    }
    const data = await response.json();
    if (data.skipped) return { success: false, reason: data.reason };
    return { success: true };
  },
});
