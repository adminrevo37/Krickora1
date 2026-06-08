// Internal email QA harness — fires EVERY template (the real renderTemplate via
// sendTemplateEmail) to a target inbox so the design/copy can be eyeballed live.
// Internal-only (never customer-callable). Pulls a real recent booking for the
// booking-shaped templates; sample data for the rest. Sends are paced via the
// scheduler (~1.2s apart) so Resend doesn't rate-limit the batch.
//
// Run (prod): CONVEX_DEPLOY_KEY=... npx convex run testEmails:sendAllTemplatesTest
//   (optional arg {"to":"someone@x.com"} — defaults to admin@revolutionsports.com.au)

import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendTemplateEmail } from "./lib/email";

const DEFAULT_TO = "admin@revolutionsports.com.au";

// Display order: booking-shaped first, then athlete, mate, summary, broadcast, auth, ops.
const SLUGS = [
  "booking-confirmation",
  "payment-confirmation",
  "booking-rescheduled",
  "booking-cancellation",
  "booking-reminder",
  "waitlist-confirmation",
  "waitlist-vacancy",
  "athlete-allocation",
  "athlete-added",
  "athlete-invite",
  "athlete-cancellation",
  "athlete-removed",
  "athlete-reschedule",
  "mate-added",
  "mate-removed",
  "mate-left",
  "mate-cancelled",
  "mate-modified",
  "weekly-booking-summary",
  "announcement",
  "password-reset",
  "email-verification",
  "fault-report",
];

// Most recent booking (prefer one carrying a door code) for realistic data.
export const getSampleBooking = internalQuery({
  args: {},
  handler: async (ctx) => {
    const recent = await ctx.db.query("bookings").order("desc").take(30);
    const withCode = recent.find((b: any) => b.accessCode);
    return (withCode ?? recent[0] ?? null) as any;
  },
});

function fmtDate(iso?: string): string {
  if (!iso) return "Monday 9 June 2026";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-AU", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
function fmt12(h: number): string {
  const hr = Math.floor(h);
  const m = Math.round((h - hr) * 60);
  const period = hr >= 12 ? "pm" : "am";
  const disp = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${disp}:${m.toString().padStart(2, "0")}${period}`;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const sendAllTemplatesTest = internalAction({
  args: { to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const to = (args.to ?? DEFAULT_TO).trim();
    const b: any = await ctx.runQuery(internal.testEmails.getSampleBooking, {});

    const lane = b?.laneNameSnapshot ?? b?.laneName ?? "BM 1";
    const date = fmtDate(b?.date);
    const start = typeof b?.startHour === "number" ? b.startHour : 16;
    const durMin = typeof b?.duration === "number" ? b.duration : 60;
    const timeSlot = `${fmt12(start)} - ${fmt12(start + durMin / 60)}`;
    const code = b?.accessCode ?? "4821";
    const cust = b?.customerName ?? "Tom Reed";
    const firstName = (String(cust).trim().split(/\s+/)[0]) || "Tom";

    const slotsHtml =
      `<div style="margin-bottom:10px;"><p style="margin:0 0 2px;font-family:${FONT};color:#10151c;font-size:14px;font-weight:600;">${date}</p><p style="margin:0;font-family:${FONT};color:#23292f;font-size:14px;">${timeSlot}</p></div>`;
    const bookingsHtml =
      `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:2px;"><tr><td style="padding:8px 0;border-bottom:1px solid #e2e6ea;"><p style="margin:0;font-family:${FONT};color:#6a7480;font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${date}</p><p style="margin:2px 0 0;font-family:${FONT};color:#10151c;font-size:14.5px;font-weight:600;">${lane} · ${timeSlot}</p></td></tr></table>`;

    const d: Record<string, string> = {
      firstName,
      name: cust,
      customerName: cust,
      parentName: cust,
      resetUrl: "https://cricketrevolution.au/reset-password?token=TEST123",
      verificationUrl: "https://cricketrevolution.au/verify?token=TEST123",
      signUpUrl: "https://cricketrevolution.au/signup?invite=TEST123",
      bookingUrl: "https://cricketrevolution.au",
      calendarUrl: "https://cricketrevolution.au",
      amount: "$32.00",
      description: `${lane} — ${date}, ${timeSlot}`,
      reference: "CR-TEST-0001",
      paymentDate: date,
      laneName: lane,
      date,
      timeSlot,
      duration: `${durMin} min`,
      accessCode: code,
      oldLaneName: lane,
      oldDate: date,
      oldTimeSlot: timeSlot,
      newLaneName: lane,
      newDate: date,
      newTimeSlot: timeSlot,
      newDuration: `${durMin} min`,
      slotCount: "1",
      slotsHtml,
      offerDeadline: "10:42am AWST",
      otherWaitlistCount: "3",
      athleteName: "Jack",
      coachName: "Dan Roberts",
      childName: "Jack",
      ownerName: "Sam Carter",
      mateName: "Sam Carter",
      weekRange: "9–15 June",
      bookingCount: "1",
      bookingsHtml,
      title: "Holiday hours this weekend",
      body: "We're open 8am–2pm Saturday and closed Sunday.\n\nBook early — nets fill fast over the long weekend.",
      link: "https://cricketrevolution.au",
      ctaLabel: "See the hours",
      childRef: "",
      unsubscribeUrl: "",
      reporterName: "Sam Carter",
      reporterMobile: "0412 345 678",
      reporterEmail: "sam@example.com",
      laneId: lane,
      category: "Equipment",
      sessionInfo: `${lane} · ${date}, ${timeSlot}`,
      createdAtLabel: date,
      details: "Bowling machine feed jammed mid-session — ball stuck in the hopper and it stopped feeding.",
      photoUrl: "https://cricketrevolution.au/storage/test-photo.jpg",
      where: lane,
    };

    // Pace the batch so Resend (≈2/sec) doesn't 429 us. MUST await each schedule
    // — dangling (unawaited) scheduler promises are cancelled by Convex.
    for (let i = 0; i < SLUGS.length; i++) {
      await ctx.scheduler.runAfter(i * 1200, internal.testEmails.sendOneTest, {
        slug: SLUGS[i],
        to,
        d,
      });
    }

    return { scheduled: SLUGS.length, to, usedBookingId: b?._id ?? null, sampleLane: lane, sampleDate: date };
  },
});

export const sendOneTest = internalAction({
  args: { slug: v.string(), to: v.string(), d: v.any() },
  handler: async (_ctx, { slug, to, d }) => {
    const r = await sendTemplateEmail(slug, to, d);
    console.log(`[testEmail] ${slug} -> ${to}: ${r.success ? "sent" : "FAILED " + r.reason}`);
    return r;
  },
});
