/**
 * Krickora email — Resend transport + code-owned template registry.
 *
 * Replaces the previous Shipper-hosted template service. Shipper hosted the
 * email HTML by `templateSlug`; Resend has no server-side templates, so every
 * template now lives here as branded, responsive, inline-styled HTML.
 *
 * Used by:
 *   - convex/emails.ts        (all transactional + notification emails)
 *   - convex/auth.ts          (Better Auth password-reset / email-verification)
 *   - convex/weeklySummary.ts (weekly booking summary)
 *
 * Env (set on the Convex deployment, NOT Vercel — email is sent from Convex):
 *   - RESEND_API_KEY   Resend API key. When unset, sendTemplateEmail() no-ops
 *                      gracefully (returns {success:false, reason:"Email not
 *                      configured"}) — same behaviour as the old Shipper path,
 *                      so nothing throws before the key is added.
 *   - EMAIL_FROM       From header, e.g. `Krickora <onboarding@resend.dev>` or
 *                      `Krickora <noreply@krickora.com>` once the domain is
 *                      verified in Resend. Defaults to the Resend shared sender.
 */

// ── Brand ────────────────────────────────────────────────────────────────────
const BRAND = {
  navy: "#1e3a5f",
  navyDark: "#162d49",
  amber: "#f59e0b",
  amberSoft: "#fef3c7",
  amberText: "#92400e",
  ink: "#1a1a1a",
  sub: "#64748b",
  line: "#e2e8f0",
  bg: "#f1f5f9",
  card: "#ffffff",
};

// Public site base (links in emails). Door codes / calendar already default to
// this elsewhere in the codebase. Facility instructions page (#14) is pending —
// the link points at the site root until that page ships.
const SITE = "https://krickora.com";
const FACILITY_URL = `${SITE}/facility-instructions`;

// ── HTML helpers ─────────────────────────────────────────────────────────────
/** HTML-escape a text value. Use for ALL caller-supplied text. */
function esc(s: string | undefined | null): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;"><tr><td style="border-radius:8px;background-color:${BRAND.amber};">
<a href="${esc(url)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:700;color:${BRAND.navyDark};text-decoration:none;border-radius:8px;">${esc(label)}</a>
</td></tr></table>`;
}

/** Label/value detail table. Values are escaped. */
function detailRows(rows: Array<[string, string]>): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr>
<td style="padding:8px 0;color:${BRAND.sub};font-size:13px;vertical-align:top;width:40%;">${esc(label)}</td>
<td style="padding:8px 0;color:${BRAND.ink};font-size:14px;font-weight:600;vertical-align:top;">${esc(value)}</td>
</tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 14px;border-top:1px solid ${BRAND.line};border-bottom:1px solid ${BRAND.line};">${body}</table>`;
}

/** Big door-code display block. */
function codeBox(code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;"><tr>
<td align="center" style="padding:16px;background-color:${BRAND.amberSoft};border-radius:10px;">
<p style="margin:0 0 4px;color:${BRAND.amberText};font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Door access code</p>
<p style="margin:0;color:${BRAND.navyDark};font-size:30px;font-weight:800;letter-spacing:6px;font-family:'Courier New',monospace;">${esc(code)}</p>
</td></tr></table>`;
}

function facilityBanner(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;"><tr>
<td style="padding:10px 14px;background-color:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
<a href="${FACILITY_URL}" style="color:${BRAND.navy};font-size:13px;font-weight:700;text-decoration:none;">&#128205; Facility access &amp; instructions &rarr;</a>
</td></tr></table>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 14px;color:${BRAND.ink};font-size:15px;line-height:1.55;">${text}</p>`;
}

function muted(text: string): string {
  return `<p style="margin:0 0 8px;color:${BRAND.sub};font-size:13px;line-height:1.5;">${text}</p>`;
}

/**
 * Full email document. `bodyHtml` is the inner content (already HTML).
 * `preheader` is the hidden inbox-preview line.
 */
function layout(opts: { title: string; preheader: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.bg};-webkit-text-size-adjust:100%;">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.bg};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
<!-- header -->
<tr><td style="padding:6px 4px 16px;">
<span style="font-size:22px;font-weight:800;color:${BRAND.navy};letter-spacing:0.5px;">Krickora</span>
</td></tr>
<!-- card -->
<tr><td style="background-color:${BRAND.card};border:1px solid ${BRAND.line};border-radius:12px;padding:28px 26px;">
${opts.bodyHtml}
</td></tr>
<!-- footer -->
<tr><td style="padding:18px 6px;">
<p style="margin:0 0 4px;color:${BRAND.sub};font-size:12px;line-height:1.5;">Krickora &middot; Cricket Revolution, 78 Jones St, Stirling WA</p>
<p style="margin:0;color:${BRAND.sub};font-size:12px;line-height:1.5;"><a href="${SITE}" style="color:${BRAND.sub};">krickora.com</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Template registry ────────────────────────────────────────────────────────
type Rendered = { subject: string; html: string };
type Data = Record<string, string>;

/**
 * Render a template by slug. Returns null for an unknown slug (caller logs +
 * skips). Caller-supplied text is escaped inside the helpers; the few fields
 * that are PRE-RENDERED HTML (slotsHtml, bookingsHtml) are injected verbatim.
 */
export function renderTemplate(slug: string, d: Data): Rendered | null {
  switch (slug) {
    // ── Auth ────────────────────────────────────────────────────────────────
    case "password-reset":
      return {
        subject: "Reset your Krickora password",
        html: layout({
          title: "Reset your password",
          preheader: "Reset your Krickora password.",
          bodyHtml:
            p(`Hi ${esc(d.name)},`) +
            p(`We received a request to reset your Krickora password. Click below to choose a new one — this link expires shortly.`) +
            button("Reset password", d.resetUrl) +
            muted(`If you didn't request this, you can safely ignore this email — your password won't change.`),
        }),
      };
    case "email-verification":
      return {
        subject: "Verify your email for Krickora",
        html: layout({
          title: "Verify your email",
          preheader: "Confirm your email to finish setting up Krickora.",
          bodyHtml:
            p(`Hi ${esc(d.name)},`) +
            p(`Welcome to Krickora. Please confirm your email address to activate your account.`) +
            button("Verify email", d.verificationUrl) +
            muted(`If you didn't create a Krickora account, you can ignore this email.`),
        }),
      };

    // ── Payment ───────────────────────────────────────────────────────────────
    case "payment-confirmation":
      return {
        subject: "Payment received — Krickora",
        html: layout({
          title: "Payment received",
          preheader: `Payment of ${esc(d.amount)} received.`,
          bodyHtml:
            p(`Hi ${esc(d.customerName)},`) +
            p(`Thanks — your payment has been received.`) +
            detailRows([
              ["Amount", d.amount],
              ["For", d.description],
              ["Reference", d.reference],
              ["Date", d.paymentDate],
            ]),
        }),
      };

    // ── Bookings ──────────────────────────────────────────────────────────────
    case "booking-confirmation":
      return {
        subject: `Booking confirmed — ${esc(d.laneName)}, ${esc(d.date)}`,
        html: layout({
          title: "Booking confirmed",
          preheader: `${esc(d.laneName)} on ${esc(d.date)} at ${esc(d.timeSlot)}.`,
          bodyHtml:
            facilityBanner() +
            p(`Hi ${esc(d.customerName)}, your session is confirmed.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
              ["Paid", d.amount],
            ]) +
            codeBox(d.accessCode) +
            button("View / add to calendar", d.calendarUrl || SITE),
        }),
      };
    case "booking-cancellation":
      return {
        subject: `Booking cancelled — ${esc(d.laneName)}, ${esc(d.date)}`,
        html: layout({
          title: "Booking cancelled",
          preheader: `Your ${esc(d.laneName)} session on ${esc(d.date)} was cancelled.`,
          bodyHtml:
            p(`Hi ${esc(d.customerName)}, your session has been cancelled.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
            ]) +
            (d.cancellationReason ? muted(`Reason: ${esc(d.cancellationReason)}`) : "") +
            p(`Any payment has been returned to your account as credit, ready to use on your next booking.`) +
            button("Book again", d.bookingUrl || SITE),
        }),
      };
    case "booking-rescheduled":
      return {
        subject: `Booking updated — ${esc(d.newLaneName)}, ${esc(d.newDate)}`,
        html: layout({
          title: "Booking updated",
          preheader: `Your session is now ${esc(d.newLaneName)} on ${esc(d.newDate)} at ${esc(d.newTimeSlot)}.`,
          bodyHtml:
            facilityBanner() +
            p(`Hi ${esc(d.customerName)}, your booking has been updated.`) +
            muted(`Previously: ${esc(d.oldLaneName)} &middot; ${esc(d.oldDate)} &middot; ${esc(d.oldTimeSlot)}`) +
            detailRows([
              ["Lane", d.newLaneName],
              ["Date", d.newDate],
              ["Time", d.newTimeSlot],
              ["Duration", d.newDuration],
            ]) +
            codeBox(d.accessCode) +
            button("View / add to calendar", d.calendarUrl || SITE),
        }),
      };
    case "booking-reminder":
      return {
        subject: `Reminder — your session ${esc(d.timeSlot)}`,
        html: layout({
          title: "Session reminder",
          preheader: `${esc(d.laneName)} at ${esc(d.timeSlot)}.`,
          bodyHtml:
            facilityBanner() +
            p(`Hi ${esc(d.customerName)}, this is a reminder of your upcoming session.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
            ]) +
            codeBox(d.accessCode) +
            button("View / add to calendar", d.calendarUrl || SITE),
        }),
      };

    // ── Waitlist ──────────────────────────────────────────────────────────────
    case "waitlist-confirmation":
      return {
        subject: "You're on the waitlist — Krickora",
        html: layout({
          title: "You're on the waitlist",
          preheader: `We'll email you if a spot opens for your ${esc(d.slotCount)} requested time(s).`,
          bodyHtml:
            p(`Hi ${esc(d.customerName)}, you're on the waitlist for the following time(s). If a spot opens, we'll email you an exclusive offer to book.`) +
            // slotsHtml is pre-rendered HTML (raw, not escaped)
            (d.slotsHtml || "") +
            muted(`You'll only be charged if you choose to book a slot that's offered to you.`),
        }),
      };
    case "waitlist-vacancy":
      return {
        subject: "A spot opened up — reserved for you",
        html: layout({
          title: "A spot opened up",
          preheader: `${esc(d.laneName)} on ${esc(d.date)} at ${esc(d.timeSlot)} — reserved for you.`,
          bodyHtml:
            p(`Hi ${esc(d.customerName)}, good news — a spot you were waiting for is now available, and it's reserved for <strong>you</strong> first.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
            ]) +
            (d.offerDeadline
              ? p(`This spot is held for you until <strong>${esc(d.offerDeadline)}</strong>. After that it's offered to the next person in line, so book soon to keep it.`)
              : p(`Book soon to secure it — spots are offered on a first-come basis.`)) +
            button("Book this spot", d.bookingUrl || SITE) +
            (Number(d.otherWaitlistCount) > 0
              ? muted(`${esc(d.otherWaitlistCount)} other ${Number(d.otherWaitlistCount) === 1 ? "person is" : "people are"} waiting for this time.`)
              : ""),
        }),
      };

    // ── Athlete / parent (mandatory) ─────────────────────────────────────────
    case "athlete-allocation":
      return {
        subject: `${esc(d.athleteName)} has a session — ${esc(d.date)}`,
        html: layout({
          title: "Session allocated",
          preheader: `${esc(d.athleteName)} with ${esc(d.coachName)} on ${esc(d.date)}.`,
          bodyHtml:
            facilityBanner() +
            p(`${esc(d.coachName)} has allocated <strong>${esc(d.athleteName)}</strong> to a coaching session.`) +
            detailRows([
              ["Athlete", d.athleteName],
              ["Coach", d.coachName],
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
            ]) +
            codeBox(d.accessCode) +
            button("View / add to calendar", d.calendarUrl || SITE),
        }),
      };
    case "athlete-added":
      return {
        subject: `${esc(d.coachName)} added ${esc(d.childName)} to their roster`,
        html: layout({
          title: "Added to a coach's roster",
          preheader: `${esc(d.coachName)} can now allocate sessions for ${esc(d.childName)}.`,
          bodyHtml:
            p(`Hi ${esc(d.parentName)},`) +
            p(`<strong>${esc(d.coachName)}</strong> has added <strong>${esc(d.childName)}</strong> to their athlete roster. They can now book and allocate coaching sessions for ${esc(d.childName)}, and you'll be notified each time.`) +
            button("Manage athletes", `${SITE}`),
        }),
      };
    case "athlete-invite":
      return {
        subject: `${esc(d.coachName)} invited you to Krickora`,
        html: layout({
          title: "You're invited to Krickora",
          preheader: `${esc(d.coachName)} wants to coach ${esc(d.childName)} — create your free account.`,
          bodyHtml:
            p(`<strong>${esc(d.coachName)}</strong> would like to coach <strong>${esc(d.childName)}</strong> at Cricket Revolution.`) +
            p(`Create a free Krickora account to manage ${esc(d.childName)}'s sessions, see booking details and door codes, and stay in the loop.`) +
            button("Create your account", d.signUpUrl || SITE),
        }),
      };
    case "athlete-cancellation":
      return {
        subject: `Session cancelled for ${esc(d.athleteName)}`,
        html: layout({
          title: "Session cancelled",
          preheader: `${esc(d.coachName)} cancelled ${esc(d.athleteName)}'s session on ${esc(d.date)}.`,
          bodyHtml:
            p(`<strong>${esc(d.coachName)}</strong> has cancelled the following session for <strong>${esc(d.athleteName)}</strong>.`) +
            detailRows([
              ["Athlete", d.athleteName],
              ["Coach", d.coachName],
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
            ]) +
            muted(`No action is needed. Your coach will be in touch about any replacement session.`),
        }),
      };
    case "athlete-removed":
      return {
        subject: `${esc(d.athleteName)} removed from a session`,
        html: layout({
          title: "Removed from a session",
          preheader: `${esc(d.athleteName)} is no longer in the ${esc(d.date)} session.`,
          bodyHtml:
            p(`<strong>${esc(d.athleteName)}</strong> has been removed from the following session by <strong>${esc(d.coachName)}</strong>.`) +
            detailRows([
              ["Athlete", d.athleteName],
              ["Coach", d.coachName],
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
            ]) +
            muted(`No action is needed. Reach out to your coach with any questions.`),
        }),
      };
    case "athlete-reschedule":
      return {
        subject: `${esc(d.athleteName)}'s session has moved`,
        html: layout({
          title: "Session rescheduled",
          preheader: `${esc(d.athleteName)} is now on ${esc(d.newDate)} at ${esc(d.timeSlot)}.`,
          bodyHtml:
            facilityBanner() +
            p(`<strong>${esc(d.coachName)}</strong> has moved <strong>${esc(d.athleteName)}</strong>'s session.`) +
            (d.oldDate ? muted(`Previously: ${esc(d.oldDate)}`) : "") +
            detailRows([
              ["Athlete", d.athleteName],
              ["Coach", d.coachName],
              ["Lane", d.laneName],
              ["Date", d.newDate],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
            ]) +
            codeBox(d.accessCode) +
            button("View / add to calendar", d.calendarUrl || SITE),
        }),
      };

    // ── Mates (mandatory) ─────────────────────────────────────────────────────
    case "mate-added":
      return {
        subject: `${esc(d.ownerName)} added you to a session`,
        html: layout({
          title: "You're in",
          preheader: `${esc(d.ownerName)} added you to ${esc(d.laneName)} on ${esc(d.date)}.`,
          bodyHtml:
            facilityBanner() +
            p(`<strong>${esc(d.ownerName)}</strong> has added you to their session — here are the details and your door code.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
            ]) +
            codeBox(d.accessCode) +
            button("View / add to calendar", d.calendarUrl || SITE),
        }),
      };
    case "mate-removed":
      return {
        subject: "You were removed from a session",
        html: layout({
          title: "Removed from a session",
          preheader: `${esc(d.ownerName)} removed you from the ${esc(d.date)} session.`,
          bodyHtml:
            p(`<strong>${esc(d.ownerName)}</strong> has removed you from the following session.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
            ]) +
            muted(`Your previous door code for this session no longer applies.`),
        }),
      };
    case "mate-left":
      return {
        subject: `${esc(d.mateName)} left your session`,
        html: layout({
          title: "A mate left your session",
          preheader: `${esc(d.mateName)} is no longer joining on ${esc(d.date)}.`,
          bodyHtml:
            p(`<strong>${esc(d.mateName)}</strong> has left the following session.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
            ]) +
            muted(`Your booking is unchanged — no action needed.`),
        }),
      };
    case "mate-cancelled":
      return {
        subject: `Session cancelled — ${esc(d.ownerName)}`,
        html: layout({
          title: "Session cancelled",
          preheader: `${esc(d.ownerName)} cancelled the ${esc(d.date)} session.`,
          bodyHtml:
            p(`The session <strong>${esc(d.ownerName)}</strong> added you to has been cancelled.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
            ]) +
            muted(`No action is needed. Your door code for this session no longer applies.`),
        }),
      };
    case "mate-modified":
      return {
        subject: `Session updated — ${esc(d.ownerName)}`,
        html: layout({
          title: "Session updated",
          preheader: `New details: ${esc(d.newLaneName)} on ${esc(d.newDate)} at ${esc(d.newTimeSlot)}.`,
          bodyHtml:
            facilityBanner() +
            p(`<strong>${esc(d.ownerName)}</strong> updated the session you're part of. Here are the new details and door code.`) +
            detailRows([
              ["Lane", d.newLaneName],
              ["Date", d.newDate],
              ["Time", d.newTimeSlot],
              ["Duration", d.newDuration],
            ]) +
            codeBox(d.accessCode) +
            button("View / add to calendar", d.calendarUrl || SITE),
        }),
      };

    // ── Weekly summary ────────────────────────────────────────────────────────
    case "weekly-booking-summary":
      return {
        subject: `Your week at Krickora — ${esc(d.weekRange)}`,
        html: layout({
          title: "Your week ahead",
          preheader: `You have ${esc(d.bookingCount)} session(s) booked this week.`,
          bodyHtml:
            p(`Hi ${esc(d.customerName)}, here's your week ahead — <strong>${esc(d.bookingCount)}</strong> session(s) booked for ${esc(d.weekRange)}.`) +
            // bookingsHtml is pre-rendered HTML (raw, not escaped)
            (d.bookingsHtml || "") +
            button("Manage bookings", d.bookingUrl || SITE),
        }),
      };

    default:
      return null;
  }
}

// ── Resend transport ─────────────────────────────────────────────────────────
export type SendResult = { success: boolean; skipped?: boolean; reason?: string; id?: string };

/**
 * Render `slug` with `data` and send to `to` via Resend.
 * No-ops gracefully (success:false, reason:"Email not configured") when
 * RESEND_API_KEY is unset, so callers never throw pre-activation.
 */
export async function sendTemplateEmail(
  slug: string,
  to: string,
  data: Data
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY unset — skipped "${slug}" to ${to}`);
    return { success: false, reason: "Email not configured" };
  }
  const from = process.env.EMAIL_FROM || "Krickora <onboarding@resend.dev>";

  const rendered = renderTemplate(slug, data);
  if (!rendered) {
    console.error(`[email] Unknown template slug "${slug}" — not sent to ${to}`);
    return { success: false, reason: `Unknown template: ${slug}` };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: rendered.subject,
        html: rendered.html,
      }),
    });

    if (!response.ok) {
      let msg = `Resend ${response.status} ${response.statusText}`;
      try {
        const err = await response.json();
        msg = err?.message || err?.error?.message || msg;
      } catch {}
      if (response.status === 429) {
        console.warn(`[email] Rate limited sending "${slug}" to ${to}`);
        return { success: false, reason: "Rate limited" };
      }
      console.error(`[email] Send failed "${slug}" to ${to}: ${msg}`);
      return { success: false, reason: msg };
    }

    const out = await response.json().catch(() => ({}));
    return { success: true, id: out?.id };
  } catch (e: any) {
    console.error(`[email] Network error sending "${slug}" to ${to}:`, e?.message ?? e);
    return { success: false, reason: e?.message ?? "Network error" };
  }
}
