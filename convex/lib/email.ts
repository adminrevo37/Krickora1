/**
 * Cricket Revolution email — Resend transport + code-owned template registry.
 *
 * Style: plain text, no fluff (SPEC: Inspector 2026-06-08). No coloured header
 * bars, card shells, filled buttons or banners — just a brand line, a hairline
 * rule, label/value detail rows, a boxed door code, and links shown as plain
 * visible URLs.
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
 *   - EMAIL_FROM       From header, e.g.
 *                      `Cricket Revolution <noreply@cricketrevolution.com.au>`.
 *                      Defaults to the Resend shared sender when unset.
 */

// ── Palette (plain) ──────────────────────────────────────────────────────────
const C = {
  ink: "#23292f",        // body text
  strong: "#10151c",     // headings / detail values
  sub: "#6a7480",        // labels / muted text
  faint: "#8a949f",      // footer
  rule: "#e2e6ea",       // hairlines
  link: "#1554b8",       // links
  codeBorder: "#c4ccd5", // door-code box
  bg: "#ffffff",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

// Public site base (links in emails). Door codes / calendar already default to
// this elsewhere in the codebase.
const SITE = "https://cricketrevolution.com.au";

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

/** A labelled link shown as a plain, fully-visible URL (anti-phishing, old-school). */
function linkLine(label: string, url: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:14.5px;line-height:1.5;color:${C.ink};">${esc(label)}<br><a href="${esc(url)}" style="color:${C.link};word-break:break-all;">${esc(url)}</a></p>`;
}

/** Borderless label/value detail table. Values are escaped. */
function detailRows(rows: Array<[string, string]>): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr>
<td style="padding:3px 24px 3px 0;font-family:${FONT};color:${C.sub};font-size:14px;vertical-align:top;white-space:nowrap;">${esc(label)}</td>
<td style="padding:3px 0;font-family:${FONT};color:${C.strong};font-size:14.5px;font-weight:600;vertical-align:top;">${esc(value)}</td>
</tr>`
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 16px;">${body}</table>`;
}

/** Boxed door-code display (outlined, not filled). */
function codeBox(code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;"><tr>
<td style="border:1.5px solid ${C.codeBorder};border-radius:9px;padding:9px 22px 10px;text-align:center;">
<p style="margin:0 0 3px;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${C.sub};">Door access code</p>
<p style="margin:0;font-family:${MONO};font-size:26px;font-weight:700;letter-spacing:6px;color:${C.strong};">${esc(code)}</p>
</td></tr></table>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 14px;font-family:${FONT};color:${C.ink};font-size:15px;line-height:1.6;">${text}</p>`;
}

function muted(text: string): string {
  return `<p style="margin:0 0 10px;font-family:${FONT};color:${C.sub};font-size:13.5px;line-height:1.5;">${text}</p>`;
}

/** A small bold section label (e.g. "Details"). */
function heading(text: string): string {
  return `<p style="margin:16px 0 6px;font-family:${FONT};color:${C.strong};font-size:14px;font-weight:700;">${esc(text)}</p>`;
}

/** Render free-text (admin-typed) into escaped paragraphs, preserving line breaks. */
function paragraphs(text: string): string {
  const blocks = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return "";
  return blocks
    .map(
      (b) =>
        `<p style="margin:0 0 14px;font-family:${FONT};color:${C.ink};font-size:15px;line-height:1.6;">${esc(b).replace(/\n/g, "<br>")}</p>`
    )
    .join("");
}

/**
 * First-name greeting (SPEC_NAME_SPLIT). Prefers the threaded `firstName` (the
 * real stored field, resolved by the recipient's account); falls back to the
 * first word of the supplied full-name field so pre-migration accounts (no
 * firstName yet) still get a friendly greeting. Returns an escaped value.
 */
function greetFirst(d: Data, fullField: string): string {
  const fn = String(d.firstName ?? "").trim();
  if (fn) return esc(fn);
  const full = String(d[fullField] ?? "").trim();
  return esc(full.split(/\s+/)[0] || full);
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
<body style="margin:0;padding:0;background-color:${C.bg};color:${C.ink};-webkit-text-size-adjust:100%;">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${C.bg};">
<tr><td align="center" style="padding:28px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
<tr><td>
<!-- brand -->
<p style="margin:0;font-family:${FONT};font-size:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.strong};">Cricket Revolution</p>
<hr style="border:0;border-top:1px solid ${C.rule};margin:11px 0 18px;">
<!-- body -->
${opts.bodyHtml}
<!-- footer -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="border-top:1px solid ${C.rule};padding-top:14px;">
<p style="margin:0 0 8px;font-family:${FONT};color:${C.faint};font-size:12px;line-height:1.55;">Prefer push notifications? <a href="${SITE}/profile#email-notifications" style="color:${C.faint};text-decoration:underline;">Manage your email notifications</a> in your profile.</p>
<p style="margin:0 0 3px;font-family:${FONT};color:${C.faint};font-size:12px;line-height:1.55;">Cricket Revolution &middot; 78 Jones St, Stirling WA</p>
<p style="margin:0;font-family:${FONT};color:${C.faint};font-size:12px;"><a href="${SITE}" style="color:${C.faint};">cricketrevolution.com.au</a></p>
</td></tr></table>
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
        subject: "Reset your Cricket Revolution password",
        html: layout({
          title: "Reset your password",
          preheader: "Reset your Cricket Revolution password.",
          bodyHtml:
            p(`Hi ${greetFirst(d, "name")},`) +
            p(`We received a request to reset your password. Open the link below to choose a new one — it expires shortly.`) +
            linkLine("Reset your password:", d.resetUrl) +
            muted(`If you didn't request this, ignore this email — your password won't change.`),
        }),
      };
    case "email-verification":
      return {
        subject: "Verify your email for Cricket Revolution",
        html: layout({
          title: "Verify your email",
          preheader: "Confirm your email to finish setting up your account.",
          bodyHtml:
            p(`Hi ${greetFirst(d, "name")},`) +
            p(`Welcome to Cricket Revolution. Please confirm your email address to activate your account.`) +
            linkLine("Verify your email:", d.verificationUrl) +
            muted(`If you didn't create an account, you can ignore this email.`),
        }),
      };

    // ── Payment ───────────────────────────────────────────────────────────────
    case "payment-confirmation": {
      // Merged confirmation: when the paid-booking session details are present,
      // this is the customer's ONE booking email — door code + session up top,
      // payment receipt below. Falls back to the plain receipt (e.g. a top-up)
      // when no session details were supplied.
      const isBooking = Boolean(d.laneName);
      if (isBooking) {
        return {
          subject: `Booking confirmed — ${esc(d.laneName)}, ${esc(d.date)}`,
          html: layout({
            title: "Booking confirmed",
            preheader: `${esc(d.laneName)} on ${esc(d.date)}${d.accessCode ? ` — door code ${esc(d.accessCode)}` : ""}.`,
            bodyHtml:
              p(`Hi ${greetFirst(d, "customerName")}, your session is confirmed and your payment has been received.`) +
              (d.accessCode ? codeBox(d.accessCode) : "") +
              detailRows([
                ["Lane", d.laneName],
                ["Date", d.date],
                ["Time", d.timeSlot],
                ["Duration", d.duration],
              ]) +
              linkLine("How to find us — directions, parking & getting in:", `${SITE}/access`) +
              heading("Payment") +
              detailRows([
                ["Amount", d.amount],
                ["Reference", d.reference],
                ["Date", d.paymentDate],
              ]),
          }),
        };
      }
      return {
        subject: "Payment received — Cricket Revolution",
        html: layout({
          title: "Payment received",
          preheader: `Payment of ${esc(d.amount)} received.`,
          bodyHtml:
            p(`Hi ${greetFirst(d, "customerName")}, thanks — your payment has been received.`) +
            detailRows([
              ["Amount", d.amount],
              ["For", d.description],
              ["Reference", d.reference],
              ["Date", d.paymentDate],
            ]),
        }),
      };
    }

    // Admin-sent payment request (e.g. a top-up for an extended session).
    case "payment-link":
      return {
        subject: "Payment link for your session — Cricket Revolution",
        html: layout({
          title: "Payment for your session",
          preheader: `A balance of ${esc(d.amount)} is due.`,
          bodyHtml:
            p(`Hi ${greetFirst(d, "customerName")}, there's a balance of ${esc(d.amount)} to pay for your session.`) +
            p(`Tap the link below to pay securely:`) +
            linkLine("Pay now:", d.paymentUrl) +
            detailRows([
              ["Amount due", d.amount],
              ["For", d.description],
            ]) +
            muted(`If you've already paid this, you can ignore this email.`),
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
            p(`Hi ${greetFirst(d, "customerName")}, your session is confirmed.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
              ["Paid", d.amount],
            ]) +
            codeBox(d.accessCode) +
            linkLine("How to find us — directions, parking & getting in:", `${SITE}/access`) +
            linkLine("Add to calendar:", d.calendarUrl || SITE),
        }),
      };
    case "booking-cancellation":
      return {
        subject: `Booking cancelled — ${esc(d.laneName)}, ${esc(d.date)}`,
        html: layout({
          title: "Booking cancelled",
          preheader: `Your ${esc(d.laneName)} session on ${esc(d.date)} was cancelled.`,
          bodyHtml:
            p(`Hi ${greetFirst(d, "customerName")}, your session has been cancelled.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
            ]) +
            (d.cancellationReason ? muted(`Reason: ${esc(d.cancellationReason)}`) : "") +
            p(`Any payment has been returned to your account as credit, ready to use on your next booking.`) +
            linkLine("Book again:", d.bookingUrl || SITE),
        }),
      };
    case "booking-rescheduled":
      return {
        subject: `Booking updated — ${esc(d.newLaneName)}, ${esc(d.newDate)}`,
        html: layout({
          title: "Booking updated",
          preheader: `Your session is now ${esc(d.newLaneName)} on ${esc(d.newDate)} at ${esc(d.newTimeSlot)}.`,
          bodyHtml:
            p(`Hi ${greetFirst(d, "customerName")}, your booking has been updated.`) +
            muted(`Previously: ${esc(d.oldLaneName)} &middot; ${esc(d.oldDate)} &middot; ${esc(d.oldTimeSlot)}`) +
            detailRows([
              ["Lane", d.newLaneName],
              ["Date", d.newDate],
              ["Time", d.newTimeSlot],
              ["Duration", d.newDuration],
            ]) +
            codeBox(d.accessCode) +
            linkLine("How to find us — directions, parking & getting in:", `${SITE}/access`) +
            linkLine("Add to calendar:", d.calendarUrl || SITE),
        }),
      };
    case "booking-reminder":
      return {
        subject: `Reminder — your session ${esc(d.timeSlot)}`,
        html: layout({
          title: "Session reminder",
          preheader: `${esc(d.laneName)} at ${esc(d.timeSlot)}.`,
          bodyHtml:
            p(`Hi ${greetFirst(d, "customerName")}, this is a reminder of your upcoming session.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
            ]) +
            codeBox(d.accessCode) +
            linkLine("How to find us — directions, parking & getting in:", `${SITE}/access`) +
            linkLine("Add to calendar:", d.calendarUrl || SITE),
        }),
      };

    // ── Waitlist ──────────────────────────────────────────────────────────────
    case "waitlist-confirmation":
      return {
        subject: "You're on the waitlist — Cricket Revolution",
        html: layout({
          title: "You're on the waitlist",
          preheader: `We'll email you if a spot opens for your ${esc(d.slotCount)} requested time(s).`,
          bodyHtml:
            p(`Hi ${greetFirst(d, "customerName")}, you're on the waitlist for the following time(s). If a spot opens, we'll email you an exclusive offer to book.`) +
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
            p(`Hi ${greetFirst(d, "customerName")}, good news — a spot you were waiting for is now available, and it's reserved for <strong>you</strong> first.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
            ]) +
            (d.offerDeadline
              ? p(`This spot is held for you until <strong>${esc(d.offerDeadline)}</strong>. After that it's offered to the next person in line, so book soon to keep it.`)
              : p(`Book soon to secure it — spots are offered on a first-come basis.`)) +
            linkLine("Book this spot:", d.bookingUrl || SITE) +
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
            linkLine("How to find us — directions, parking & getting in:", `${SITE}/access`) +
            linkLine("Add to calendar:", d.calendarUrl || SITE),
        }),
      };
    case "athlete-added":
      return {
        subject: `${esc(d.coachName)} added ${esc(d.childName)} to their roster`,
        html: layout({
          title: "Added to a coach's roster",
          preheader: `${esc(d.coachName)} can now allocate sessions for ${esc(d.childName)}.`,
          bodyHtml:
            p(`Hi ${greetFirst(d, "parentName")},`) +
            p(`<strong>${esc(d.coachName)}</strong> has added <strong>${esc(d.childName)}</strong> to their athlete roster. They can now book and allocate coaching sessions for ${esc(d.childName)}, and you'll be notified each time.`) +
            linkLine("Manage athletes:", SITE),
        }),
      };
    case "athlete-invite":
      return {
        subject: `${esc(d.coachName)} invited you to Cricket Revolution`,
        html: layout({
          title: "You're invited to Cricket Revolution",
          preheader: `${esc(d.coachName)} wants to coach ${esc(d.childName)} — create your free account.`,
          bodyHtml:
            p(`<strong>${esc(d.coachName)}</strong> would like to coach <strong>${esc(d.childName)}</strong> at Cricket Revolution.`) +
            p(`Create a free account to manage ${esc(d.childName)}'s sessions, see booking details and door codes, and stay in the loop.`) +
            linkLine("Create your account:", d.signUpUrl || SITE),
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
            linkLine("How to find us — directions, parking & getting in:", `${SITE}/access`) +
            linkLine("Add to calendar:", d.calendarUrl || SITE),
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
            p(`<strong>${esc(d.ownerName)}</strong> has added you to their session — here are the details and your door code.`) +
            detailRows([
              ["Lane", d.laneName],
              ["Date", d.date],
              ["Time", d.timeSlot],
              ["Duration", d.duration],
            ]) +
            codeBox(d.accessCode) +
            linkLine("How to find us — directions, parking & getting in:", `${SITE}/access`) +
            linkLine("Add to calendar:", d.calendarUrl || SITE),
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
            p(`<strong>${esc(d.ownerName)}</strong> updated the session you're part of. Here are the new details and door code.`) +
            detailRows([
              ["Lane", d.newLaneName],
              ["Date", d.newDate],
              ["Time", d.newTimeSlot],
              ["Duration", d.newDuration],
            ]) +
            codeBox(d.accessCode) +
            linkLine("How to find us — directions, parking & getting in:", `${SITE}/access`) +
            linkLine("Add to calendar:", d.calendarUrl || SITE),
        }),
      };

    // ── Weekly summary ────────────────────────────────────────────────────────
    case "weekly-booking-summary":
      return {
        subject: `Your week at Cricket Revolution — ${esc(d.weekRange)}`,
        html: layout({
          title: "Your week ahead",
          preheader: `You have ${esc(d.bookingCount)} session(s) booked this week.`,
          bodyHtml:
            p(`Hi ${greetFirst(d, "customerName")}, here's your week ahead — <strong>${esc(d.bookingCount)}</strong> session(s) booked for ${esc(d.weekRange)}.`) +
            // bookingsHtml is pre-rendered HTML (raw, not escaped)
            (d.bookingsHtml || "") +
            linkLine("Manage bookings:", d.bookingUrl || SITE),
        }),
      };

    // ── Admin broadcast / announcement (SPEC_ADMIN_BROADCAST) ─────────────────
    // Generic admin-composed message. `title` = subject + heading, `body` =
    // free-text (multi-line). Optional `link` becomes a labelled URL. `childRef` is
    // set when the recipient is a parent of allocated athlete(s) ("Re: <names>").
    // `unsubscribeUrl` is present only for PROMOTIONAL sends (Spam Act).
    case "announcement":
      return {
        subject: d.title || "A message from Cricket Revolution",
        html: layout({
          title: d.title || "Cricket Revolution",
          preheader: (d.body || "").replace(/\s+/g, " ").slice(0, 120),
          bodyHtml:
            (d.childRef ? muted(`Re: ${esc(d.childRef)}`) : "") +
            `<p style="margin:0 0 12px;font-family:${FONT};font-size:18px;font-weight:800;line-height:1.3;color:${C.strong};">${esc(d.title)}</p>` +
            paragraphs(d.body) +
            (d.link ? linkLine(`${d.ctaLabel || "View details"}:`, d.link) : "") +
            (d.unsubscribeUrl
              ? `<p style="margin:18px 0 0;padding-top:14px;border-top:1px solid ${C.rule};font-family:${FONT};color:${C.sub};font-size:12px;line-height:1.5;">You're receiving this because you're a Cricket Revolution customer. <a href="${esc(d.unsubscribeUrl)}" style="color:${C.sub};text-decoration:underline;">Unsubscribe from promotional emails</a>.</p>`
              : ""),
        }),
      };

    // ── Fault / service report (admin ops alert) ──────────────────────────────
    // Internal operations email to the ops inbox when a user reports an issue.
    case "fault-report":
      return {
        subject: `New fault report${d.where ? ` — ${esc(d.where)}` : ""}`,
        html: layout({
          title: "New fault report",
          preheader: (d.details || "").replace(/\s+/g, " ").slice(0, 120),
          bodyHtml:
            p(`A new issue has been reported through the app.`) +
            detailRows(
              ([
                ["Reported by", d.reporterName],
                ["Mobile", d.reporterMobile],
                ["Email", d.reporterEmail],
                ["Lane", d.laneId],
                ["Category", d.category],
                ["Session", d.sessionInfo],
                ["Reported", d.createdAtLabel],
              ] as [string, string][]).filter((r) => r[1]),
            ) +
            heading("Details") +
            paragraphs(d.details) +
            (d.photoUrl ? linkLine("View attached photo:", d.photoUrl) : "") +
            muted("Automated operations alert — triage this in the admin panel."),
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
  const from = process.env.EMAIL_FROM || "Cricket Revolution <onboarding@resend.dev>";

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
