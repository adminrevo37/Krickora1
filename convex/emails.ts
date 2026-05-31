import { internalAction, action } from "./_generated/server";
import { v } from "convex/values";

// Templates that users CANNOT opt out of (transactional/auth + all athlete
// notifications). Athlete emails are MANDATORY per the notifications redesign
// (SPEC_NOTIFICATIONS_REDESIGN #8, A1–A5): the recipient is the parent account,
// a third party to the coach booking, so they are never prefs-gated.
const MANDATORY_TEMPLATES = new Set([
  "password-reset",
  "email-verification",
  "athlete-allocation",
  "athlete-cancellation",
  "athlete-removed",
  "athlete-reschedule",
  "athlete-added",
  "athlete-invite",
]);

// Check if recipient has a specific email template enabled (defaults to true).
// Mandatory transactional templates always send. Otherwise we look up the
// customer's per-template preferences. Falls back to legacy bookingEmailsEnabled
// for any booking-* template.
async function emailEnabledForUser(
  ctx: any,
  email: string,
  templateSlug: string
): Promise<boolean> {
  if (MANDATORY_TEMPLATES.has(templateSlug)) return true;
  try {
    const normalized = email.toLowerCase().trim();
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalized))
      .first();
    if (!customer) return true;
    const prefs: Array<{ slug: string; enabled: boolean }> = customer.emailPrefs ?? [];
    const pref = prefs.find((p) => p.slug === templateSlug);
    if (pref) return pref.enabled;
    // Legacy fallback: bookingEmailsEnabled covered all booking-* emails
    if (templateSlug.startsWith("booking-") && customer.bookingEmailsEnabled === false) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

// Backwards-compat shim
async function bookingEmailsEnabled(ctx: any, email: string): Promise<boolean> {
  return emailEnabledForUser(ctx, email, "booking-confirmation");
}

// ============================================================================
// SHARED EMAIL SENDER HELPER
// ============================================================================

async function sendEmail(templateSlug: string, to: string, templateData: Record<string, string>): Promise<{ success: boolean; skipped?: boolean; reason?: string }> {
  const url = process.env.SHIPPER_EMAIL_URL;
  if (!url || !process.env.SHIPPER_EMAIL_TOKEN) {
    console.error("Email not configured: SHIPPER_EMAIL_URL and SHIPPER_EMAIL_TOKEN must be set");
    return { success: false, reason: "Email not configured" };
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shipper-Token": process.env.SHIPPER_EMAIL_TOKEN,
    },
    body: JSON.stringify({
      to,
      templateSlug,
      templateData,
    }),
  });
  if (!response.ok) {
    let msg = "Email send failed";
    try {
      const err = await response.json();
      msg = err?.error?.message ?? msg;
    } catch {
      msg = `Email send failed: ${response.status} ${response.statusText}`;
    }
    if (response.status === 403) {
      console.warn("Email skipped: recipient not in database —", to);
      return { success: false, reason: "Recipient not in database" };
    }
    if (response.status === 402) {
      console.warn("Email skipped: insufficient credits");
      return { success: false, reason: "Insufficient email credits" };
    }
    if (response.status === 429) {
      console.warn("Email rate limited");
      return { success: false, reason: "Rate limited" };
    }
    console.error("Email send error:", msg);
    return { success: false, reason: msg };
  }
  const data = await response.json();
  if (data.skipped) {
    console.warn(`Email skipped: ${data.reason}`);
    return { success: false, skipped: true, reason: data.reason };
  }
  return { success: true, ...data };
}

// ============================================================================
// PASSWORD RESET EMAIL (called from auth.ts via Better Auth callback)
// ============================================================================

export const sendPasswordResetEmail = internalAction({
  args: {
    to: v.string(),
    name: v.string(),
    resetUrl: v.string(),
  },
  handler: async (_ctx, args) => {
    return await sendEmail("password-reset", args.to, {
      name: args.name,
      appName: "Krickora",
      resetUrl: args.resetUrl,
    });
  },
});

// ============================================================================
// EMAIL VERIFICATION (called from auth.ts via Better Auth callback)
// ============================================================================

export const sendVerificationEmail = internalAction({
  args: {
    to: v.string(),
    name: v.string(),
    verificationUrl: v.string(),
  },
  handler: async (_ctx, args) => {
    return await sendEmail("email-verification", args.to, {
      name: args.name,
      appName: "Krickora",
      verificationUrl: args.verificationUrl,
    });
  },
});

// ============================================================================
// PAYMENT CONFIRMATION EMAIL
// ============================================================================

export const sendPaymentConfirmation = internalAction({
  args: {
    to: v.string(),
    customerName: v.string(),
    amount: v.string(),
    description: v.string(),
    reference: v.string(),
    paymentDate: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "payment-confirmation"))) {
      console.log(`[payment-confirmation] Skipped — user disabled this email: ${args.to}`);
      return { success: false, skipped: true, reason: "User disabled this email" };
    }
    return await sendEmail("payment-confirmation", args.to, {
      customerName: args.customerName,
      amount: args.amount,
      description: args.description,
      reference: args.reference,
      paymentDate: args.paymentDate,
    });
  },
});

// ============================================================================
// BOOKING CONFIRMATION EMAIL
// ============================================================================

export const sendBookingConfirmation = internalAction({
  args: {
    to: v.string(),
    customerName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
    duration: v.string(),
    amount: v.string(),
    accessCode: v.string(),
    calendarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "booking-confirmation"))) {
      console.log(`[booking-confirmation] Skipped — user disabled this email: ${args.to}`);
      return { success: false, skipped: true, reason: "User disabled this email" };
    }
    return await sendEmail("booking-confirmation", args.to, {
      customerName: args.customerName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
      duration: args.duration,
      amount: args.amount,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://krickora.com",
    });
  },
});

// ============================================================================
// BOOKING CANCELLATION EMAIL
// ============================================================================

export const sendBookingCancellation = internalAction({
  args: {
    to: v.string(),
    customerName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
    duration: v.string(),
    calendarUrl: v.optional(v.string()),
    // Optional human reason (e.g. closure / maintenance). Forward-compatible:
    // passed to the template as `cancellationReason` for it to render if present.
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "booking-cancellation"))) {
      console.log(`[booking-cancellation] Skipped — user disabled this email: ${args.to}`);
      return { success: false, skipped: true, reason: "User disabled this email" };
    }
    return await sendEmail("booking-cancellation", args.to, {
      customerName: args.customerName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
      duration: args.duration,
      cancellationReason: args.reason ?? "",
      bookingUrl: "https://krickora.com",
      calendarUrl: args.calendarUrl ?? "https://krickora.com",
    });
  },
});

// ============================================================================
// BOOKING RESCHEDULED EMAIL
// ============================================================================

export const sendBookingRescheduled = internalAction({
  args: {
    to: v.string(),
    customerName: v.string(),
    oldLaneName: v.string(),
    oldDate: v.string(),
    oldTimeSlot: v.string(),
    newLaneName: v.string(),
    newDate: v.string(),
    newTimeSlot: v.string(),
    newDuration: v.string(),
    accessCode: v.string(),
    calendarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "booking-rescheduled"))) {
      console.log(`[booking-rescheduled] Skipped — user disabled this email: ${args.to}`);
      return { success: false, skipped: true, reason: "User disabled this email" };
    }
    return await sendEmail("booking-rescheduled", args.to, {
      customerName: args.customerName,
      oldLaneName: args.oldLaneName,
      oldDate: args.oldDate,
      oldTimeSlot: args.oldTimeSlot,
      newLaneName: args.newLaneName,
      newDate: args.newDate,
      newTimeSlot: args.newTimeSlot,
      newDuration: args.newDuration,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://krickora.com",
    });
  },
});

// ============================================================================
// BOOKING REMINDER EMAIL (6 hours before)
// ============================================================================

export const sendBookingReminder = internalAction({
  args: {
    to: v.string(),
    customerName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
    duration: v.string(),
    accessCode: v.string(),
    calendarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "booking-reminder"))) {
      console.log(`[booking-reminder] Skipped — user disabled this email: ${args.to}`);
      return { success: false, skipped: true, reason: "User disabled this email" };
    }
    return await sendEmail("booking-reminder", args.to, {
      customerName: args.customerName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
      duration: args.duration,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://krickora.com",
    });
  },
});

// ============================================================================
// ATHLETE ALLOCATION EMAIL
// ============================================================================

export const sendWaitlistConfirmation = internalAction({
  args: {
    to: v.string(),
    customerName: v.string(),
    slots: v.array(v.object({
      date: v.string(),
      hour: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    const recipient = args.to;
    if (!(await emailEnabledForUser(ctx, recipient, "waitlist-confirmation"))) {
      console.log(`[waitlist-confirmation] Skipped — user disabled this email: ${recipient}`);
      return { success: false, skipped: true, reason: "User disabled this email" };
    }
    console.log(`[waitlist-confirmation] Sending to ${recipient} for ${args.slots.length} slot(s)`);
    const fmtHour = (h: number) => {
      const hr = Math.floor(h);
      const min = Math.round((h - hr) * 60);
      const period = hr >= 12 ? "PM" : "AM";
      const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
      return `${display}:${min.toString().padStart(2, "0")} ${period}`;
    };
    // Group by date
    const byDate = new Map<string, number[]>();
    for (const s of args.slots) {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date)!.push(s.hour);
    }
    const sortedDates = Array.from(byDate.keys()).sort();
    const slotsHtml = sortedDates.map((date) => {
      const hours = byDate.get(date)!.sort((a, b) => a - b);
      const formattedDate = new Date(date + "T00:00:00").toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
      const timeChips = hours.map((h) => `<span style=\"display:inline-block;background-color:#fef3c7;color:#92400e;padding:4px 10px;border-radius:12px;font-size:13px;font-weight:600;margin:2px 4px 2px 0;\">${fmtHour(h)} - ${fmtHour(h + 1)}</span>`).join("");
      return `<div style=\"margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #fde68a;\"><p style=\"margin:0 0 6px;color:#1a1a1a;font-size:14px;font-weight:600;\">📅 ${formattedDate}</p><div>${timeChips}</div></div>`;
    }).join("");
    const cleanedHtml = slotsHtml.replace(/border-bottom:1px solid #fde68a;(?=[^<]*$)/, "");
    const result = await sendEmail("waitlist-confirmation", recipient, {
      customerName: args.customerName,
      slotCount: String(args.slots.length),
      slotsHtml: cleanedHtml,
    });
    if (!result.success) {
      console.error(`[waitlist-confirmation] Failed: ${result.reason}`);
    } else {
      console.log(`[waitlist-confirmation] Sent successfully to ${recipient}`);
    }
    return result;
  },
});

export const sendWaitlistVacancy = internalAction({
  args: {
    to: v.string(),
    customerName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
    bookingUrl: v.string(),
    otherWaitlistCount: v.string(),
    // SPEC_WAITLIST_OFFER_REDESIGN: exclusive first-refusal offer. The slot is
    // held for THIS member only until offerDeadline (AWST), then it rolls to the
    // next person. Template copy must convey "reserved for you until {deadline}".
    offerDeadline: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "waitlist-vacancy"))) {
      console.log(`[waitlist-vacancy] Skipped — user disabled this email: ${args.to}`);
      return { success: false, skipped: true, reason: "User disabled this email" };
    }
    console.log(`[waitlist-vacancy] Sending to ${args.to} for ${args.laneName} ${args.date} ${args.timeSlot} (held until ${args.offerDeadline ?? "n/a"})`);
    const result = await sendEmail("waitlist-vacancy", args.to, {
      customerName: args.customerName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
      bookingUrl: args.bookingUrl,
      otherWaitlistCount: args.otherWaitlistCount,
      offerDeadline: args.offerDeadline ?? "",
    });
    if (!result.success) {
      console.error(`[waitlist-vacancy] Failed to ${args.to}: ${result.reason}`);
    } else {
      console.log(`[waitlist-vacancy] Sent successfully to ${args.to}`);
    }
    return result;
  },
});

export const sendAthleteAllocation = internalAction({
  args: {
    to: v.string(),
    athleteName: v.string(),
    coachName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
    duration: v.string(),
    accessCode: v.string(),
    calendarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "athlete-allocation"))) {
      console.log(`[athlete-allocation] Skipped — user disabled this email: ${args.to}`);
      return { success: false, skipped: true, reason: "User disabled this email" };
    }
    return await sendEmail("athlete-allocation", args.to, {
      athleteName: args.athleteName,
      coachName: args.coachName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
      duration: args.duration,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://krickora.com",
    });
  },
});

// Parent notification: a coach added one of their children as an athlete
// (SPEC_PARENT_ATHLETE_MODEL — coach-add path, account already exists).
// Mandatory (parent is a third party to the coach action) — not prefs-gated.
export const sendAthleteAdded = internalAction({
  args: {
    to: v.string(),
    parentName: v.string(),
    childName: v.string(),
    coachName: v.string(),
  },
  handler: async (_ctx, args) => {
    return await sendEmail("athlete-added", args.to, {
      parentName: args.parentName,
      childName: args.childName,
      coachName: args.coachName,
    });
  },
});

// Invite a parent whose account doesn't exist yet to register so their child
// can be coached (SPEC_PARENT_ATHLETE_MODEL — coach-add path, no account).
export const sendAthleteInvite = internalAction({
  args: {
    to: v.string(),
    childName: v.string(),
    coachName: v.string(),
  },
  handler: async (_ctx, args) => {
    return await sendEmail("athlete-invite", args.to, {
      childName: args.childName,
      coachName: args.coachName,
      signUpUrl: "https://krickora.com",
    });
  },
});

// Coach cancelled a session an athlete was allocated to (Bug #1). The session
// is off for them — no instructions link / door code / add-to-calendar. Sent to
// the parent account, addressed with the child's name (sibling-consolidated by
// the caller). Mandatory.
export const sendAthleteCancellation = internalAction({
  args: {
    to: v.string(),
    athleteName: v.string(),
    coachName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
  },
  handler: async (_ctx, args) => {
    return await sendEmail("athlete-cancellation", args.to, {
      athleteName: args.athleteName,
      coachName: args.coachName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
    });
  },
});

// Athlete dropped from a coach session during an edit (decision #3a). No
// instructions link / door code — they are no longer attending. Mandatory.
export const sendAthleteRemoved = internalAction({
  args: {
    to: v.string(),
    athleteName: v.string(),
    coachName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
  },
  handler: async (_ctx, args) => {
    return await sendEmail("athlete-removed", args.to, {
      athleteName: args.athleteName,
      coachName: args.coachName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
    });
  },
});

// Coach session moved (reschedule / time change) affecting an athlete's slot
// (decision #3b). Carries the new time + door code + Facility Instructions link
// (attend-a-session layout). Sent to the parent account. Mandatory.
export const sendAthleteReschedule = internalAction({
  args: {
    to: v.string(),
    athleteName: v.string(),
    coachName: v.string(),
    laneName: v.string(),
    oldDate: v.optional(v.string()),
    newDate: v.string(),
    timeSlot: v.string(),
    duration: v.string(),
    accessCode: v.string(),
    calendarUrl: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    return await sendEmail("athlete-reschedule", args.to, {
      athleteName: args.athleteName,
      coachName: args.coachName,
      laneName: args.laneName,
      oldDate: args.oldDate ?? "",
      newDate: args.newDate,
      timeSlot: args.timeSlot,
      duration: args.duration,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://krickora.com",
    });
  },
});
