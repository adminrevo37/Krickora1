import { internalAction, action, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { sendTemplateEmail } from "./lib/email";

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
  // SPEC_ADD_A_MATE M1–M5: the recipient is a mate (or the owner being told a
  // mate left) — a third party with no other UI signal, so mandatory.
  "mate-added",
  "mate-removed",
  "mate-left",
  "mate-cancelled",
  "mate-modified",
]);

// Check if recipient has a specific email template enabled (defaults to true).
// Mandatory transactional templates always send. Otherwise we look up the
// customer's per-template preferences via an internalQuery.
//
// M7 (SEC audit 2026-06-03): every caller of this helper is an ACTION
// (internalAction), which has NO `ctx.db`. The old body queried `ctx.db`
// directly, so it ALWAYS threw, the catch returned `true`, and per-template
// opt-out was silently bypassed (every email sent regardless of prefs). The fix
// is to read prefs through `ctx.runQuery` (the only DB access an action has).
async function emailEnabledForUser(
  ctx: any,
  email: string,
  templateSlug: string
): Promise<boolean> {
  if (MANDATORY_TEMPLATES.has(templateSlug)) return true;
  try {
    return await ctx.runQuery(internal.emails.getEmailPrefInternal, {
      email,
      templateSlug,
    });
  } catch {
    // Fail open: a prefs-lookup bug must never block a transactional email.
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

// Transport is now Resend (see convex/lib/email.ts). Per-recipient preference
// gating still happens in each action below via emailEnabledForUser(); this just
// renders the code-owned template for `templateSlug` and sends it.
async function sendEmail(
  templateSlug: string,
  to: string,
  templateData: Record<string, string>
): Promise<{ success: boolean; skipped?: boolean; reason?: string }> {
  return await sendTemplateEmail(templateSlug, to, templateData);
}

// ============================================================================
// SPEC_NAME_SPLIT — first-name greeting resolution
// These send-actions run as Convex ACTIONS (no ctx.db). To greet "Hi John" with
// the recipient's REAL stored firstName, we read it by email via this internal
// query and thread it into the template data. A first-word-of-name fallback in
// the template covers accounts created before the name-split migration.
// ============================================================================

// M7: per-template opt-out lookup, runnable from an action via ctx.runQuery.
// Returns true (send) unless the customer has explicitly disabled this template
// (or the legacy bookingEmailsEnabled=false covers a booking-* template).
export const getEmailPrefInternal = internalQuery({
  args: { email: v.string(), templateSlug: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const normalized = args.email.toLowerCase().trim();
    if (!normalized) return true;
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalized))
      .first();
    if (!customer) return true;
    // Bug 7: master email switch. When explicitly off, silence every
    // preference-gated email (regular notifications + the weekly summary, which
    // routes through here too). Strict === false so legacy/absent = ON. Mandatory
    // transactional/athlete/mate emails short-circuit BEFORE this query is called
    // (emailEnabledForUser), and admin broadcasts/announcements send via
    // sendTemplateEmail directly — so neither is affected by this switch.
    if (customer.emailNotificationsEnabled === false) return false;
    const prefs: Array<{ slug: string; enabled: boolean }> = customer.emailPrefs ?? [];
    const pref = prefs.find((p) => p.slug === args.templateSlug);
    if (pref) return pref.enabled;
    // Legacy fallback: bookingEmailsEnabled covered all booking-* emails.
    if (args.templateSlug.startsWith("booking-") && customer.bookingEmailsEnabled === false) {
      return false;
    }
    return true;
  },
});

// SPEC fault-report (2026-06): email the full fault/service report + a link to the
// attached photo to the ops inbox. Internal ops alert to a FIXED address — NOT
// prefs-gated (sent via sendTemplateEmail directly, like admin broadcasts), so it
// can't be silenced by any per-user email preference.
export const sendFaultReportEmail = internalAction({
  args: {
    to: v.string(),
    reporterName: v.string(),
    reporterEmail: v.string(),
    reporterMobile: v.string(),
    laneId: v.string(),
    category: v.string(),
    sessionInfo: v.string(),
    where: v.string(),
    details: v.string(),
    photoUrl: v.string(),
    createdAtLabel: v.string(),
  },
  handler: async (
    _ctx,
    args
  ): Promise<{ success: boolean; skipped?: boolean; reason?: string }> => {
    return await sendTemplateEmail("fault-report", args.to, {
      reporterName: args.reporterName,
      reporterEmail: args.reporterEmail,
      reporterMobile: args.reporterMobile,
      laneId: args.laneId,
      category: args.category,
      sessionInfo: args.sessionInfo,
      where: args.where,
      details: args.details,
      photoUrl: args.photoUrl,
      createdAtLabel: args.createdAtLabel,
    });
  },
});

export const getGreetingFirstNameInternal = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const normalized = args.email.toLowerCase().trim();
    if (!normalized) return null;
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalized))
      .first();
    const fn = (customer?.firstName ?? "").trim();
    return fn || null;
  },
});

// Resolve the recipient's stored firstName (real field) for greeting. Never
// throws — returns "" on any failure so the template's own fallback applies.
async function resolveFirstName(ctx: any, email: string): Promise<string> {
  try {
    const fn: string | null = await ctx.runQuery(
      internal.emails.getGreetingFirstNameInternal,
      { email }
    );
    return (fn ?? "").trim();
  } catch {
    return "";
  }
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
  handler: async (ctx, args) => {
    return await sendEmail("password-reset", args.to, {
      name: args.name,
      firstName: await resolveFirstName(ctx, args.to),
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
  handler: async (ctx, args) => {
    return await sendEmail("email-verification", args.to, {
      name: args.name,
      firstName: await resolveFirstName(ctx, args.to),
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
      firstName: await resolveFirstName(ctx, args.to),
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
      firstName: await resolveFirstName(ctx, args.to),
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
      duration: args.duration,
      amount: args.amount,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://cricketrevolution.au",
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
      firstName: await resolveFirstName(ctx, args.to),
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
      duration: args.duration,
      cancellationReason: args.reason ?? "",
      bookingUrl: "https://cricketrevolution.au",
      calendarUrl: args.calendarUrl ?? "https://cricketrevolution.au",
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
      firstName: await resolveFirstName(ctx, args.to),
      oldLaneName: args.oldLaneName,
      oldDate: args.oldDate,
      oldTimeSlot: args.oldTimeSlot,
      newLaneName: args.newLaneName,
      newDate: args.newDate,
      newTimeSlot: args.newTimeSlot,
      newDuration: args.newDuration,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://cricketrevolution.au",
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
      firstName: await resolveFirstName(ctx, args.to),
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
      duration: args.duration,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://cricketrevolution.au",
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
      const times = hours.map((h) => `${fmtHour(h)} – ${fmtHour(h + 1)}`).join(", ");
      return `<div style=\"margin-bottom:10px;\"><p style=\"margin:0 0 2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#10151c;font-size:14px;font-weight:600;\">${formattedDate}</p><p style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#23292f;font-size:14px;\">${times}</p></div>`;
    }).join("");
    const cleanedHtml = slotsHtml;
    const result = await sendEmail("waitlist-confirmation", recipient, {
      customerName: args.customerName,
      firstName: await resolveFirstName(ctx, recipient),
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
      firstName: await resolveFirstName(ctx, args.to),
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
      calendarUrl: args.calendarUrl ?? "https://cricketrevolution.au",
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
  handler: async (ctx, args) => {
    return await sendEmail("athlete-added", args.to, {
      parentName: args.parentName,
      firstName: await resolveFirstName(ctx, args.to),
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
      signUpUrl: "https://cricketrevolution.au",
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
      calendarUrl: args.calendarUrl ?? "https://cricketrevolution.au",
    });
  },
});

// ============================================================================
// MATE NOTIFICATIONS (SPEC_ADD_A_MATE M1–M5). All mandatory — the recipient is
// a mate (or the owner being told a mate left), a third party to the booking
// flow. M1/M5 carry the door code + Facility Instructions link (they ARE
// attending); M2/M3/M4 do not (removal / cancellation).
// ============================================================================

// M1 — owner added this person to a booking. Booking-confirmation layout minus
// payment lines, with the door code + "added you" framing.
export const sendMateAdded = internalAction({
  args: {
    to: v.string(),
    ownerName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
    duration: v.string(),
    accessCode: v.string(),
    calendarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "mate-alerts"))) {
      return { success: true, skipped: true, reason: "mate emails off" };
    }
    return await sendEmail("mate-added", args.to, {
      ownerName: args.ownerName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
      duration: args.duration,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://cricketrevolution.au",
    });
  },
});

// M2 — owner removed this mate from the booking. No door code / instructions.
export const sendMateRemoved = internalAction({
  args: {
    to: v.string(),
    ownerName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "mate-alerts"))) {
      return { success: true, skipped: true, reason: "mate emails off" };
    }
    return await sendEmail("mate-removed", args.to, {
      ownerName: args.ownerName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
    });
  },
});

// M3 — a mate removed themselves; tell the owner. No door code / instructions.
export const sendMateLeft = internalAction({
  args: {
    to: v.string(),
    mateName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "mate-alerts"))) {
      return { success: true, skipped: true, reason: "mate emails off" };
    }
    return await sendEmail("mate-left", args.to, {
      mateName: args.mateName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
    });
  },
});

// M4 — owner (or admin) cancelled the whole booking; tell every mate. No code.
export const sendMateCancelled = internalAction({
  args: {
    to: v.string(),
    ownerName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "mate-alerts"))) {
      return { success: true, skipped: true, reason: "mate emails off" };
    }
    return await sendEmail("mate-cancelled", args.to, {
      ownerName: args.ownerName,
      laneName: args.laneName,
      date: args.date,
      timeSlot: args.timeSlot,
    });
  },
});

// M5 — owner modified the booking; tell every mate the new details. Same layout
// as the Booking Modified email (#7) minus payment lines. Carries the new code.
export const sendMateModified = internalAction({
  args: {
    to: v.string(),
    ownerName: v.string(),
    newLaneName: v.string(),
    newDate: v.string(),
    newTimeSlot: v.string(),
    newDuration: v.string(),
    accessCode: v.string(),
    calendarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await emailEnabledForUser(ctx, args.to, "mate-alerts"))) {
      return { success: true, skipped: true, reason: "mate emails off" };
    }
    return await sendEmail("mate-modified", args.to, {
      ownerName: args.ownerName,
      newLaneName: args.newLaneName,
      newDate: args.newDate,
      newTimeSlot: args.newTimeSlot,
      newDuration: args.newDuration,
      accessCode: args.accessCode,
      calendarUrl: args.calendarUrl ?? "https://cricketrevolution.au",
    });
  },
});
