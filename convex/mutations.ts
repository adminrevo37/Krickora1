import { mutation, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal, components } from "./_generated/api";
import { requireAdmin, requireAdminUnlocked, getAuthUserSafe } from "./lib/adminGuard";
import { issueCredit, redeemCredit, recordCreditMovement } from "./lib/credit";
import { recordDiscountRedemption, validateDiscount, discountAmountCents } from "./lib/discounts";
import {
  abandonedCheckoutMs,
  createCheckoutHold,
  releaseHoldForBooking,
  hasActiveHoldConflict,
} from "./lib/slotHolds";
import {
  scheduleWaitlistAdvance,
  consumeWaitlistHoldForBooking,
} from "./waitlist";
import {
  getAWSTNow,
  checkBookingHorizon,
  checkLeadTime,
  type WindowRole,
  type WindowTier,
} from "./lib/bookingWindow";
import { computeCustomerPriceCents, decreaseCreditCents } from "./lib/pricing";
import { PRICE_DEFAULTS } from "./lib/priceDefaults";
import { composeName, splitName } from "./lib/names";
import { assertValidLocation, validateLocationIfProvided, normalizePostcode, normalizeSuburb } from "./lib/locations";
import { notifyMatesOnCancel, notifyMatesOnModify } from "./mates";

// ============================================================================
// SHARED HELPERS
// ============================================================================

const LANE_NAME_MAP: Record<string, string> = {
  bm1: "Bowling Machine Lane 1",
  bm2: "Bowling Machine Lane 2",
  bm3: "Bowling Machine Lane 3",
  ru1: "Run-Up Lane 1",
  ru2: "Run-Up Lane 2",
};

function fmtHour12(h: number): string {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  const period = hr >= 12 ? "PM" : "AM";
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${display}:${min.toString().padStart(2, "0")} ${period}`;
}

function durationLabel(m: number): string {
  return m === 60 ? "1 hour" : m === 90 ? "1.5 hours" : m === 120 ? "2 hours" : `${m} minutes`;
}

// Format a YYYY-MM-DD booking date as a weekday-long label in AWST (Bug #4).
// toLocaleDateString without an explicit timeZone uses the Convex server zone
// (UTC), which can flip the weekday at the day boundary for AWST recipients.
function fmtAwstDateLabel(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    timeZone: "Australia/Perth",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Build the booking-confirmation email payload from a booking-like object.
// Shared by createBooking and the admin resend (resendBookingConfirmation) so the
// email content + door code stay in sync across both call sites.
function buildConfirmationEmailArgs(b: {
  customerEmail: string;
  customerName: string;
  laneId: string;
  date: string;
  startHour: number;
  duration: number;
  accessCode?: string | null;
  coachPrice?: number | null;
  creditApplied?: number | null;
}) {
  const laneName = LANE_NAME_MAP[b.laneId] ?? b.laneId.toUpperCase();
  const endHour = b.startHour + b.duration / 60;
  const amount =
    b.coachPrice != null
      ? `$${b.coachPrice.toFixed(2)}`
      : b.creditApplied != null
        ? `$${b.creditApplied.toFixed(2)} (credit applied)`
        : "Paid";
  return {
    to: b.customerEmail,
    customerName: b.customerName,
    laneName,
    date: fmtAwstDateLabel(b.date),
    timeSlot: `${fmtHour12(b.startHour)} - ${fmtHour12(endHour)}`,
    duration: durationLabel(b.duration),
    amount,
    accessCode: b.accessCode ?? "N/A",
  };
}

// Resolve athlete slots to their owning ACCOUNT (parent) email + child name and
// group them per account (sibling consolidation) — SPEC_PARENT_ATHLETE_MODEL.
// Recipient = the account email; addressed with the child's name. Falls back to
// a name->customer match for legacy slots with no athleteId. Shared by every
// athlete-email helper below so recipient resolution never drifts.
async function groupSlotsByAccount(
  ctx: any,
  slots: Array<{
    athleteId?: string;
    athleteName: string;
    startHour: number;
    durationMinutes: number;
    accessCode?: string;
  }>
): Promise<
  Array<{
    to: string;
    entries: Array<{ name: string; startHour: number; durationMinutes: number; accessCode?: string }>;
  }>
> {
  const groups = new Map<
    string,
    Array<{ name: string; startHour: number; durationMinutes: number; accessCode?: string }>
  >();
  for (const slot of slots) {
    let to = "";
    let name = slot.athleteName;
    if (slot.athleteId) {
      const athlete = await ctx.db.get(slot.athleteId as any);
      if (athlete) {
        name = athlete.name;
        const account = await ctx.db.get(athlete.accountCustomerId);
        to = account?.email ?? "";
      }
    }
    // A-5: do NOT fall back to a name match. A legacy slot with no athleteId
    // could otherwise resolve to a SAME-NAMED stranger's account and email them
    // the door access code. This resolver backs every athlete email (allocation
    // /cancellation/removed/reschedule), so the mis-resolution would affect all
    // of them. New allocations always carry athleteId; legacy rows without one
    // simply get no athlete email (owner/booking emails are unaffected).
    if (!to) continue;
    const list = groups.get(to) ?? [];
    list.push({
      name,
      startHour: slot.startHour,
      durationMinutes: slot.durationMinutes,
      accessCode: slot.accessCode,
    });
    groups.set(to, list);
  }
  return Array.from(groups.entries()).map(([to, entries]) => ({ to, entries }));
}

const fmtTimeRange = (startHour: number, durationMinutes: number): string =>
  `${fmtHour12(startHour)} - ${fmtHour12(startHour + durationMinutes / 60)}`;

// Schedule ONE consolidated allocation email per account. Recipient = parent
// account email, addressed with the child's name. Mandatory (NOT prefs-gated).
async function scheduleAllocationEmails(
  ctx: any,
  opts: {
    slots: Array<{
      athleteId?: string;
      athleteName: string;
      startHour: number;
      durationMinutes: number;
      accessCode?: string;
    }>;
    laneId: string;
    date: string;
    bookingAccessCode?: string;
    coachName: string;
  }
): Promise<void> {
  const laneName = LANE_NAME_MAP[opts.laneId] ?? opts.laneId.toUpperCase();
  const formattedDate = fmtAwstDateLabel(opts.date);
  const groups = await groupSlotsByAccount(ctx, opts.slots);
  for (const { to, entries } of groups) {
    const code = entries[0].accessCode ?? opts.bookingAccessCode ?? "N/A";
    if (entries.length === 1) {
      const s = entries[0];
      await ctx.scheduler.runAfter(0, internal.emails.sendAthleteAllocation, {
        to,
        athleteName: s.name,
        coachName: opts.coachName,
        laneName,
        date: formattedDate,
        timeSlot: fmtTimeRange(s.startHour, s.durationMinutes),
        duration: durationLabel(s.durationMinutes),
        accessCode: s.accessCode ?? code,
      });
    } else {
      const names = entries.map((s) => s.name).join(" & ");
      const combinedTime = entries
        .map((s) => `${s.name}: ${fmtTimeRange(s.startHour, s.durationMinutes)}`)
        .join("; ");
      const totalDur = entries.reduce((a, s) => a + s.durationMinutes, 0);
      await ctx.scheduler.runAfter(0, internal.emails.sendAthleteAllocation, {
        to,
        athleteName: names,
        coachName: opts.coachName,
        laneName,
        date: formattedDate,
        timeSlot: combinedTime,
        duration: durationLabel(totalDur),
        accessCode: code,
      });
    }
  }
}

// Notify athletes that a coach session was cancelled (Bug #1) — no door code /
// instructions (the session is off for them). One email per account.
async function scheduleAthleteCancellationEmails(
  ctx: any,
  opts: {
    slots: Array<{ athleteId?: string; athleteName: string; startHour: number; durationMinutes: number }>;
    laneId: string;
    date: string;
    coachName: string;
  }
): Promise<void> {
  const laneName = LANE_NAME_MAP[opts.laneId] ?? opts.laneId.toUpperCase();
  const formattedDate = fmtAwstDateLabel(opts.date);
  const groups = await groupSlotsByAccount(ctx, opts.slots);
  for (const { to, entries } of groups) {
    const names = entries.map((s) => s.name).join(" & ");
    const timeSlot = entries
      .map((s) => fmtTimeRange(s.startHour, s.durationMinutes))
      .join("; ");
    await ctx.scheduler.runAfter(0, internal.emails.sendAthleteCancellation, {
      to,
      athleteName: names,
      coachName: opts.coachName,
      laneName,
      date: formattedDate,
      timeSlot,
    });
  }
}

// Notify athletes dropped from a coach session during an edit (decision #3a).
async function scheduleAthleteRemovedEmails(
  ctx: any,
  opts: {
    slots: Array<{ athleteId?: string; athleteName: string; startHour: number; durationMinutes: number }>;
    laneId: string;
    date: string;
    coachName: string;
  }
): Promise<void> {
  const laneName = LANE_NAME_MAP[opts.laneId] ?? opts.laneId.toUpperCase();
  const formattedDate = fmtAwstDateLabel(opts.date);
  const groups = await groupSlotsByAccount(ctx, opts.slots);
  for (const { to, entries } of groups) {
    const names = entries.map((s) => s.name).join(" & ");
    const timeSlot = entries
      .map((s) => fmtTimeRange(s.startHour, s.durationMinutes))
      .join("; ");
    await ctx.scheduler.runAfter(0, internal.emails.sendAthleteRemoved, {
      to,
      athleteName: names,
      coachName: opts.coachName,
      laneName,
      date: formattedDate,
      timeSlot,
    });
  }
}

// Notify athletes whose coach session moved (decision #3b) — carries the new
// time + door code. Slots passed are already shifted to the new window.
async function scheduleAthleteRescheduleEmails(
  ctx: any,
  opts: {
    slots: Array<{ athleteId?: string; athleteName: string; startHour: number; durationMinutes: number }>;
    laneId: string;
    oldDate?: string;
    newDate: string;
    bookingAccessCode?: string;
    coachName: string;
  }
): Promise<void> {
  const laneName = LANE_NAME_MAP[opts.laneId] ?? opts.laneId.toUpperCase();
  const formattedOld = opts.oldDate ? fmtAwstDateLabel(opts.oldDate) : undefined;
  const formattedNew = fmtAwstDateLabel(opts.newDate);
  const code = opts.bookingAccessCode ?? "N/A";
  const groups = await groupSlotsByAccount(ctx, opts.slots);
  for (const { to, entries } of groups) {
    const names = entries.map((s) => s.name).join(" & ");
    const timeSlot = entries
      .map((s) => fmtTimeRange(s.startHour, s.durationMinutes))
      .join("; ");
    const totalDur = entries.reduce((a, s) => a + s.durationMinutes, 0);
    await ctx.scheduler.runAfter(0, internal.emails.sendAthleteReschedule, {
      to,
      athleteName: names,
      coachName: opts.coachName,
      laneName,
      oldDate: formattedOld,
      newDate: formattedNew,
      timeSlot,
      duration: durationLabel(totalDur),
      accessCode: code,
    });
  }
}

// ── Allocation audit log (Part 2) ───────────────────────────────────────────
// Append one entry recording an allocation change on a booking. Best-effort —
// never blocks the mutation. Kept forever (low volume; useful for disputes).
async function writeAllocationAudit(
  ctx: any,
  opts: {
    bookingId: string;
    actorUserId?: string;
    actorName?: string;
    action: "allocate" | "reallocate" | "remove" | "cancel" | "reschedule";
    before?: any[];
    after?: any[];
  }
): Promise<void> {
  try {
    await ctx.db.insert("allocationAuditLog", {
      bookingId: opts.bookingId,
      at: new Date().toISOString(),
      actorUserId: opts.actorUserId,
      actorName: opts.actorName,
      action: opts.action,
      before: opts.before,
      after: opts.after,
    });
  } catch (e) {
    console.error("[allocationAudit] failed to write entry:", e);
  }
}

// Bug #3: find same-athlete time conflicts across OTHER active coach bookings on
// the same date. Returns human-readable warning strings (empty = no clash). Only
// athleteId-bearing slots can be matched reliably across bookings.
async function detectAthleteConflicts(
  ctx: any,
  opts: {
    excludeBookingId: any;
    date: string;
    slots: Array<{ athleteId?: string; athleteName: string; startHour: number; durationMinutes: number }>;
  }
): Promise<string[]> {
  const candidateById = new Map<string, Array<{ name: string; start: number; end: number }>>();
  for (const s of opts.slots) {
    if (!s.athleteId) continue;
    const list = candidateById.get(s.athleteId as string) ?? [];
    list.push({ name: s.athleteName, start: s.startHour, end: s.startHour + s.durationMinutes / 60 });
    candidateById.set(s.athleteId as string, list);
  }
  if (candidateById.size === 0) return [];

  const sameDay = await ctx.db
    .query("bookings")
    .withIndex("by_date", (q: any) => q.eq("date", opts.date))
    .collect();

  const warnings: string[] = [];
  const seen = new Set<string>();

  // A-2: same athlete placed on two OVERLAPPING slots within THIS submission
  // (e.g. one child put on two lanes at the same time in one coach booking) —
  // the cross-booking loop below can't catch this, so check the candidates
  // against each other first.
  for (const [aid, list] of candidateById) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].start < list[j].end && list[j].start < list[i].end) {
          const key = `self:${aid}`;
          if (!seen.has(key)) {
            seen.add(key);
            warnings.push(`${list[i].name} is allocated to two overlapping slots in this session.`);
          }
        }
      }
    }
  }

  for (const other of sameDay) {
    if (other._id === opts.excludeBookingId) continue;
    if (other.status === "cancelled" || !other.isCoachBooking) continue;
    for (const os of other.athleteSlots ?? []) {
      if (!os.athleteId) continue;
      const candidates = candidateById.get(os.athleteId as string);
      if (!candidates) continue;
      const oStart = os.startHour;
      const oEnd = os.startHour + os.durationMinutes / 60;
      for (const c of candidates) {
        if (c.start < oEnd && oStart < c.end) {
          const key = `${os.athleteId}:${other._id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          warnings.push(
            `${c.name} is already booked with ${other.customerName} at ${fmtHour12(oStart)}.`
          );
        }
      }
    }
  }
  return warnings;
}

// ── Unified modify apply (SPEC_MODIFY_BOOKING_UPGRADE) ───────────────────────
// Applies a resolved change-set to a booking and runs every side-effect:
//   • athlete keep-what-fits (Bug #7 — shift slots, drop those that no longer fit)
//   • door-code swap (when the slot identity changes) + lock re-sync flag
//   • Google Calendar resync (always — start/end/lane may have changed)
//   • owner "rescheduled" email + coach athlete reschedule/removed emails + audit
//   • reminder reset
// Pricing/credit/payment decisions are made by the CALLERS (modifyBooking for the
// immediate path; confirmBookingPayment after a Stripe top-up) — this helper only
// applies the change. Exported so the webhook can reuse it verbatim.
export async function applyBookingChange(
  ctx: any,
  booking: any,
  change: {
    newDate: string;
    newStartHour: number;
    newDuration: number;
    newLaneId: string;
    newVariantId?: string;
    newAdditionalLaneIds?: string[];
    newAccessCode?: string;       // used when regenCode is true
    regenCode: boolean;           // slot identity changed → new door code + lock re-sync
    newCoachPrice?: number;       // coach bookings
    newPriceInCents?: number;     // customer bookings — stored for future diff
    actorUserId?: string;
    actorName: string;
  }
): Promise<{ droppedAthletes: string[] }> {
  // C3 (SECURITY): on a slot-identity change the server mints the new door code —
  // the client-supplied `change.newAccessCode` is IGNORED.
  const accessCode = change.regenCode
    ? generateServerAccessCode(await collectActiveAccessCodes(ctx), await getReservedCodes(ctx))
    : booking.accessCode;

  // Bug #7 keep-what-fits: shift every athlete slot by the time delta and keep
  // those that still fit the new window. Dropped slots are reported (never silent).
  const prevAthleteSlots = booking.athleteSlots ?? [];
  const keptSlots: any[] = [];
  const droppedSlots: any[] = [];
  let adjustedAthleteSlots: any = booking.athleteSlots;
  if (prevAthleteSlots.length > 0) {
    const timeDiff = change.newStartHour - booking.startHour;
    const newBookingEnd = change.newStartHour + change.newDuration / 60;
    for (const slot of prevAthleteSlots) {
      const shifted = {
        ...slot,
        startHour: slot.startHour + timeDiff,
        // athletes share the booking's door code — follow a regenerated code
        ...(change.regenCode
          ? { accessCode, codeGeneratedAt: new Date().toISOString() }
          : {}),
      };
      const slotEnd = shifted.startHour + shifted.durationMinutes / 60;
      if (shifted.startHour < change.newStartHour - 0.001 || slotEnd > newBookingEnd + 0.001) {
        droppedSlots.push(slot); // report the original (pre-shift) slot
      } else {
        keptSlots.push(shifted);
      }
    }
    adjustedAthleteSlots = keptSlots.length > 0 ? keptSlots : undefined;
  }

  // Capture old calendar event ids BEFORE patching.
  const oldCalEventId = booking.googleCalendarEventId;
  const oldCalEventIds = booking.googleCalendarEventIds;
  // Did the LANE SET change? Same lanes → update the existing event(s) in place
  // (time/duration/details). Changed lanes → MOVE the event to the new lane's
  // (different) Google Calendar: delete the old event(s), create fresh ones.
  const oldLaneKey = [booking.laneId, ...((booking.additionalLaneIds ?? []) as string[])].slice().sort().join(",");
  const newLaneKey = [change.newLaneId, ...((change.newAdditionalLaneIds ?? booking.additionalLaneIds ?? []) as string[])].slice().sort().join(",");
  const laneSetChanged = oldLaneKey !== newLaneKey;

  await ctx.db.patch(booking._id, {
    date: change.newDate,
    startHour: change.newStartHour,
    duration: change.newDuration,
    laneId: change.newLaneId,
    variantId: change.newVariantId ?? booking.variantId,
    additionalLaneIds: change.newAdditionalLaneIds ?? booking.additionalLaneIds,
    ...(change.newCoachPrice !== undefined ? { coachPrice: change.newCoachPrice } : {}),
    ...(change.newPriceInCents !== undefined ? { priceInCents: change.newPriceInCents } : {}),
    athleteSlots: adjustedAthleteSlots,
    accessCode,
    // On a lane MOVE we recreate the events (new ids) so clear the old ones; on an
    // in-place update we keep the existing event ids and PUT the new details.
    ...(laneSetChanged ? { googleCalendarEventId: undefined, googleCalendarEventIds: undefined } : {}),
    ...(change.regenCode ? { lockSyncStatus: "pending" } : {}),
    reminderSent: false,
  });

  // SPEC_WAITLIST_OFFER_REDESIGN: a reschedule/modify away from the old slot
  // frees it — offer it to the next waitlisted member. `booking.*` here still
  // holds the PRE-patch (old) slot. An in-place extend leaves the booking
  // covering the old hours, so the engine just sees it filled and no-ops.
  await scheduleWaitlistAdvance(ctx, {
    laneId: booking.laneId,
    date: booking.date,
    startHour: booking.startHour,
    duration: booking.duration,
  });
  // The NEW slot is now filled by this booking — clear any waitlist on it (#6).
  await scheduleWaitlistAdvance(ctx, {
    laneId: change.newLaneId,
    date: change.newDate,
    startHour: change.newStartHour,
    duration: change.newDuration,
  });

  // SPEC_ADD_A_MATE M5: tell every mate the new details + re-anchor pending SMS
  // invite expiry to the new start (customer bookings only; coach bookings have
  // no mates). `booking.*` is still the PRE-patch doc, so booking.mates is intact.
  if (!booking.isCoachBooking) {
    await notifyMatesOnModify(ctx, booking, {
      newDate: change.newDate,
      newStartHour: change.newStartHour,
      newDuration: change.newDuration,
      newLaneId: change.newLaneId,
      newAccessCode: accessCode,
    });
  }

  // ── Google Calendar sync ────────────────────────────────────────────────
  // Same lane(s): UPDATE the existing event(s) in place with the new time /
  // duration / details. Lane change: MOVE — delete the old event(s) from the old
  // lane's calendar and create fresh ones on the new lane's (different) calendar.
  const calStatus = booking.status === "pending_edit_payment" ? "confirmed" : booking.status;
  const calAthleteSlots = (adjustedAthleteSlots ?? []).map((s: any) => ({
    athleteName: s.athleteName,
    startHour: s.startHour,
    durationMinutes: s.durationMinutes,
  }));
  const hadEvents = !!oldCalEventId || (Array.isArray(oldCalEventIds) && oldCalEventIds.length > 0);

  if (!laneSetChanged && hadEvents) {
    // In-place update — keeps the same event ids on the same calendars.
    await ctx.scheduler.runAfter(0, internal.googleCalendar.updateCalendarEvent, {
      googleCalendarEventId: oldCalEventId ?? "",
      laneId: change.newLaneId,
      variantId: change.newVariantId ?? booking.variantId,
      date: change.newDate,
      startHour: change.newStartHour,
      duration: change.newDuration,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      status: calStatus,
      isCoachBooking: booking.isCoachBooking,
      accessCode,
      additionalLaneIds: change.newAdditionalLaneIds ?? booking.additionalLaneIds,
      athleteSlots: calAthleteSlots,
      laneCalendarEventIds: oldCalEventIds,
    });
  } else {
    // Lane move (or no prior events): delete old, create fresh on the new lane(s).
    if (hadEvents) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
        googleCalendarEventId: oldCalEventId ?? "",
        laneCalendarEventIds: oldCalEventIds,
      });
    }
    await ctx.scheduler.runAfter(500, internal.googleCalendar.createCalendarEvent, {
      bookingId: booking._id.toString(),
      laneId: change.newLaneId,
      variantId: change.newVariantId ?? booking.variantId,
      date: change.newDate,
      startHour: change.newStartHour,
      duration: change.newDuration,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      status: calStatus,
      isCoachBooking: booking.isCoachBooking,
      accessCode,
      additionalLaneIds: change.newAdditionalLaneIds ?? booking.additionalLaneIds,
      athleteSlots: calAthleteSlots,
    });
  }

  // Owner "booking modified" email (reuses the rescheduled template).
  if (booking.customerEmail) {
    await ctx.scheduler.runAfter(0, internal.emails.sendBookingRescheduled, {
      to: booking.customerEmail,
      customerName: booking.customerName || "Valued Customer",
      oldLaneName: LANE_NAME_MAP[booking.laneId] ?? booking.laneId,
      oldDate: booking.date,
      oldTimeSlot: fmtHour12(booking.startHour),
      newLaneName: LANE_NAME_MAP[change.newLaneId] ?? change.newLaneId,
      newDate: change.newDate,
      newTimeSlot: fmtHour12(change.newStartHour),
      newDuration: durationLabel(change.newDuration),
      accessCode: accessCode ?? "",
    });
  }

  // Coach bookings: notify affected athletes' parents + write the audit entry.
  if (booking.isCoachBooking) {
    if (keptSlots.length > 0) {
      await scheduleAthleteRescheduleEmails(ctx, {
        slots: keptSlots,
        laneId: change.newLaneId,
        oldDate: booking.date,
        newDate: change.newDate,
        bookingAccessCode: accessCode,
        coachName: booking.customerName,
      });
    }
    if (droppedSlots.length > 0) {
      await scheduleAthleteRemovedEmails(ctx, {
        slots: droppedSlots,
        laneId: booking.laneId,
        date: booking.date,
        coachName: booking.customerName,
      });
    }
    if (keptSlots.length > 0 || droppedSlots.length > 0) {
      await writeAllocationAudit(ctx, {
        bookingId: booking._id.toString(),
        actorUserId: change.actorUserId,
        actorName: booking.customerName,
        action: "reschedule",
        before: prevAthleteSlots,
        after: keptSlots,
      });
    }
  }

  return { droppedAthletes: droppedSlots.map((s: any) => s.athleteName) };
}

// ============================================================================
// BOOKING MUTATIONS
// ============================================================================

// Create a new booking
export const createBooking = mutation({
  args: {
    laneId: v.string(),
    variantId: v.optional(v.string()),
    date: v.string(),
    startHour: v.number(),
    duration: v.number(),
    customerName: v.string(),
    customerEmail: v.string(),
    customerPhone: v.optional(v.string()),
    userId: v.optional(v.string()),
    status: v.string(),
    stripeSessionId: v.optional(v.string()),
    isCoachBooking: v.optional(v.boolean()),
    coachPrice: v.optional(v.number()),
    additionalLaneIds: v.optional(v.array(v.string())),
    athleteSlots: v.optional(
      v.array(
        v.object({
          athleteId: v.optional(v.id("athletes")),
          athleteName: v.string(),
          startHour: v.number(),
          durationMinutes: v.number(),
          accessCode: v.optional(v.string()),
          codeGeneratedAt: v.optional(v.string()),
        })
      )
    ),
    creditApplied: v.optional(v.number()),
    accessCode: v.optional(v.string()),
    discountCode: v.optional(v.string()),
    tentativeSourceId: v.optional(v.string()),
    tentativeForDate: v.optional(v.string()),
    notes: v.optional(v.string()),
    // Admin manual booking (SPEC_ADMIN_AND_SETTINGS #2): comp / paid-offline record
    // a price + paid status with no Stripe; send-payment-request creates a pending
    // booking. These let the admin stamp the booking without going through checkout.
    paymentStatus: v.optional(v.string()),
    priceInCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // SEC-1: Auth guard — logged-in users may only book for themselves unless admin.
    // Caller role/tier is also used below to enforce the weekly-release horizon,
    // lead time and multi-lane cap (SPEC_BOOKING_WINDOW).
    const createIdentity = await ctx.auth.getUserIdentity();
    // SEC: authentication is REQUIRED. Previously the ownership + email-verify
    // guards lived inside `if (createIdentity)`, so a logged-out caller skipped
    // them entirely and could create bookings impersonating any email/userId.
    if (!createIdentity) throw new ConvexError("Authentication required.");
    let callerCustomer: any = null;
    let isAdminCaller = false;
    if (createIdentity) {
      const callerEmail = createIdentity.email?.toLowerCase().trim() ?? "";
      const isForSelf =
        (args.userId != null && args.userId === createIdentity.subject) ||
        args.customerEmail.toLowerCase() === callerEmail;
      callerCustomer = callerEmail
        ? await ctx.db
            .query("customers")
            .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
            .first()
        : null;
      isAdminCaller = callerCustomer?.role === "admin";
      if (!isForSelf && !isAdminCaller) {
        throw new ConvexError("You can only create bookings for yourself.");
      }

      // SEC decision #4: a verified email is required to COMPLETE the FIRST
      // booking, so the door-code email (email-only delivery) reliably lands.
      // Exempt admins and coach/manual bookings. Later bookings are unaffected.
      if (!isAdminCaller && !args.isCoachBooking) {
        const authUser = await getAuthUserSafe(ctx);
        const verified = (authUser as any)?.emailVerified === true;
        if (!verified) {
          const bookerEmail = args.customerEmail.toLowerCase().trim();
          const priorByEmail = await ctx.db
            .query("bookings")
            .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", bookerEmail))
            .collect();
          const hasPrior = priorByEmail.some((b: any) => b.status !== "cancelled");
          if (!hasPrior) {
            throw new ConvexError(
              "Please verify your email address before making your first booking. Check your inbox for the verification link."
            );
          }
        }
      }
    }

    const siteSettings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const endHour = args.startHour + args.duration / 60;
    if (args.duration < 60) {
      throw new ConvexError("Minimum booking duration is 1 hour.");
    }

    // Per-day operating hours (SSOT — SPEC_BOOKING_WINDOW #2). Resolve the
    // booking day's open/close from dailyHours, falling back to the global pair.
    const DOW_NAMES = [
      "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    ];
    const [yy, mm, dd] = args.date.split("-").map(Number);
    const dowName = DOW_NAMES[new Date(yy, mm - 1, dd).getDay()];
    const dayHours = siteSettings?.dailyHours?.find((h: any) => h.day === dowName);
    const OPENING_HOUR = dayHours ? dayHours.open : (siteSettings?.openingHour ?? 7);
    const CLOSING_HOUR = dayHours ? dayHours.close : (siteSettings?.closingHour ?? 21);
    if (dayHours?.closed) {
      throw new ConvexError("The facility is closed on this day.");
    }
    if (args.startHour < OPENING_HOUR) {
      throw new ConvexError("Booking starts before opening time.");
    }
    if (endHour > CLOSING_HOUR) {
      throw new ConvexError("Booking extends past closing time.");
    }

    // Weekly-release horizon + lead time + multi-lane cap (SPEC_BOOKING_WINDOW
    // #1/#3/#4). Enforced server-side so a crafted request can't bypass the
    // calendar UI. Admin callers are exempt (manual / walk-in bookings).
    const callerRole: WindowRole = isAdminCaller
      ? "admin"
      : callerCustomer?.role === "coach"
        ? "coach"
        : "customer";
    const callerTier: WindowTier =
      callerCustomer?.coachTier === "L2" || callerCustomer?.coachTier === "BowlingL2"
        ? "L2"
        : "L1";
    const awstNow = getAWSTNow();

    const horizonError = checkBookingHorizon(
      callerRole,
      callerTier,
      siteSettings ?? {},
      args.date,
      awstNow
    );
    if (horizonError) throw new ConvexError(horizonError);

    if (callerRole !== "admin") {
      const leadError = checkLeadTime(
        args.date,
        args.startHour,
        siteSettings?.minBookingNoticeMinutes ?? 10,
        awstNow
      );
      if (leadError) throw new ConvexError(leadError);
    }

    // Multi-lane cap — customers only; coaches/admin uncapped.
    if (callerRole === "customer" && !args.isCoachBooking) {
      const maxLanes = siteSettings?.customerMaxLanesPerBooking ?? 3;
      const totalLanes = 1 + (args.additionalLaneIds?.length ?? 0);
      if (totalLanes > maxLanes) {
        throw new ConvexError(
          `You can book at most ${maxLanes} lane${maxLanes !== 1 ? "s" : ""} per booking.`
        );
      }
    }

    // Reject bookings on closed dates
    const closure = await ctx.db
      .query("closures")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .first();
    if (closure) {
      throw new ConvexError(`Facility is closed on this date${closure.reason ? `: ${closure.reason}` : "."}`);
    }

    // Check for conflicts on all lanes
    const allLaneIds = [args.laneId, ...(args.additionalLaneIds ?? [])];
    for (const lid of allLaneIds) {
      const laneBookings = await ctx.db
        .query("bookings")
        .withIndex("by_laneId_date", (q: any) =>
          q.eq("laneId", lid).eq("date", args.date)
        )
        .collect();

      const hasConflict = laneBookings.some((b) => {
        if (b.status === "cancelled") return false;
        const bEnd = b.startHour + b.duration / 60;
        return args.startHour < bEnd && endHour > b.startHour;
      });

      if (hasConflict) {
        throw new ConvexError(
          "This slot is no longer available. Please choose another time."
        );
      }

      // Check against lane service/repair blocks
      const laneBlocks = await ctx.db
        .query("laneBlocks")
        .withIndex("by_laneId_date", (q: any) =>
          q.eq("laneId", lid).eq("date", args.date)
        )
        .collect();
      const hasBlockConflict = laneBlocks.some((b) => {
        const bEnd = b.startHour + b.duration / 60;
        return args.startHour < bEnd && endHour > b.startHour;
      });
      if (hasBlockConflict) {
        throw new ConvexError("This lane is blocked for service/repair during this time.");
      }
    }

    // Respect active slot holds (in-flight checkout / waitlist offer) — the
    // shared hold mechanism (SPEC_PAYMENTS_AND_CREDIT #3). Expired holds are
    // ignored here and cleaned up by the sweep. A waitlist first-refusal hold is
    // exclusive: the held member passes their own (callerUserId), and coaches/
    // admin aren't fenced off by a customer offer (bypassWaitlistHolds).
    if (
      await hasActiveHoldConflict(ctx, {
        laneIds: allLaneIds,
        date: args.date,
        startHour: args.startHour,
        endHour,
        callerUserId: args.userId,
        bypassWaitlistHolds: callerRole !== "customer",
      })
    ) {
      throw new ConvexError("This slot is no longer available. Please choose another time.");
    }

    // R1/R3 — SERVER-AUTHORITATIVE PRICE. Never trust the client price for a
    // real customer booking: a crafted call could otherwise book any slot for
    // $0.01 (the charge in createCheckoutSession derives from this stored value).
    // Recompute = base lane (+ variant) + each additional lane at base rate −
    // server-VALIDATED discount. Coach bookings (billed separately, no Stripe) and
    // admin manual bookings (comp / paid-offline / payment-request — the admin sets
    // the amount deliberately, carried by paymentStatus) keep their passed price.
    const isAdminManual = isAdminCaller && args.paymentStatus !== undefined;
    let serverPriceCents: number | undefined = args.priceInCents;
    if (!args.isCoachBooking && !isAdminManual) {
      let grossCents = computeCustomerPriceCents(
        siteSettings as any,
        args.variantId,
        args.duration
      );
      for (const _lid of args.additionalLaneIds ?? []) {
        grossCents += computeCustomerPriceCents(siteSettings as any, null, args.duration);
      }
      let discountedCents = grossCents;
      if (args.discountCode) {
        const vd = await validateDiscount(ctx, args.discountCode, args.customerEmail);
        if (!vd) {
          throw new ConvexError("This discount code is not valid, has expired, or has reached its usage limit.");
        }
        discountedCents = Math.max(0, grossCents - discountAmountCents(grossCents, vd));
      }
      serverPriceCents = discountedCents;
    }

    // C1 (SECURITY — server-owned status): NEVER trust the client `status`. The
    // server decides confirmed-vs-pending from the amount actually due, so a
    // customer cannot submit a priced booking as "confirmed" and skip payment
    // (the prior hole: free confirmed bookings + a credit-mint chain via cancel).
    // Coach + admin-manual bookings keep their passed status (amount set
    // deliberately / billed separately). The applied credit is server-clamped to
    // the booker's real balance so an inflated `creditApplied` can't fake $0 due.
    let effectiveStatus = args.status;
    if (!args.isCoachBooking && !isAdminManual && args.status === "confirmed") {
      const realBalCents = Math.max(0, Math.round(((callerCustomer as any)?.creditBalance ?? 0) * 100));
      const wantCreditCents = Math.max(0, Math.round((args.creditApplied ?? 0) * 100));
      const clampedCreditCents = Math.min(wantCreditCents, realBalCents);
      const netDueCents = Math.max(0, (serverPriceCents ?? 0) - clampedCreditCents);
      // A$0.50 floor mirrors createCheckoutSession's minimum charge.
      if (netDueCents >= 50) {
        effectiveStatus = "pending_payment";
      }
    }

    // C3 (SECURITY): the door code is generated SERVER-SIDE; any client-supplied
    // `accessCode` is IGNORED for customer + coach bookings (a customer could
    // otherwise set a known staff code or collide with another active booking).
    // Admin-manual bookings may pass a code (admin is trusted).
    let bookingAccessCode: string;
    if (isAdminManual && args.accessCode) {
      bookingAccessCode = args.accessCode;
    } else {
      const reservedSet = new Set<string>((siteSettings as any)?.reservedAccessCodes ?? DEFAULT_RESERVED_CODES);
      bookingAccessCode = generateServerAccessCode(await collectActiveAccessCodes(ctx), reservedSet);
    }

    // For coach bookings, all assigned athletes share the coach's access code
    const normalizedAthleteSlots = args.athleteSlots && args.isCoachBooking
      ? args.athleteSlots.map((s) => ({
          ...s,
          accessCode: bookingAccessCode,
          codeGeneratedAt: s.codeGeneratedAt ?? new Date().toISOString(),
        }))
      : args.athleteSlots;

    // SPEC_PROFILE_POSTCODE_SUBURB Addendum A: snapshot the booker's postcode/suburb
    // onto the booking for the catchment report. Customer + admin-manual bookings only
    // (coach own-bookings excluded — they don't count). For self-bookings the booker is
    // callerCustomer; for admin-manual the booking is for a different customer, so resolve
    // by customerEmail. Stored as a snapshot so a later move doesn't rewrite history.
    let bookingPostcode: string | undefined;
    let bookingSuburb: string | undefined;
    if (!args.isCoachBooking) {
      const targetEmail = args.customerEmail.toLowerCase().trim();
      const targetCustomer =
        callerCustomer && (callerCustomer as any).email === targetEmail
          ? callerCustomer
          : await ctx.db
              .query("customers")
              .withIndex("by_email", (q: any) => q.eq("email", targetEmail))
              .first();
      if ((targetCustomer as any)?.postcode && (targetCustomer as any)?.suburb) {
        bookingPostcode = (targetCustomer as any).postcode;
        bookingSuburb = (targetCustomer as any).suburb;
      }
    }

    const id = await ctx.db.insert("bookings", {
      laneId: args.laneId,
      variantId: args.variantId,
      date: args.date,
      startHour: args.startHour,
      duration: args.duration,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      customerPhone: args.customerPhone,
      userId: args.userId,
      status: effectiveStatus,
      stripeSessionId: args.stripeSessionId,
      isCoachBooking: args.isCoachBooking,
      coachPrice: args.coachPrice,
      additionalLaneIds: args.additionalLaneIds,
      athleteSlots: normalizedAthleteSlots,
      creditApplied: args.creditApplied,
      accessCode: bookingAccessCode,
      discountCode: args.discountCode,
      tentativeSourceId: args.tentativeSourceId,
      tentativeForDate: args.tentativeForDate,
      notes: args.notes,
      paymentStatus: args.paymentStatus,
      priceInCents: serverPriceCents,
      bookingPostcode,
      bookingSuburb,
    });

    // SPEC_WAITLIST_OFFER_REDESIGN: if this booking is the waitlisted member
    // acting on their exclusive offer, consume the waitlist hold + mark their
    // entry booked so the queue doesn't roll on while they (potentially) pay.
    await consumeWaitlistHoldForBooking(ctx, {
      userId: args.userId,
      laneId: args.laneId,
      date: args.date,
      startHour: args.startHour,
      duration: args.duration,
    });

    // Reconcile the hour's waitlist now that a lane was taken: if the hour is now
    // fully booked the engine clears the queue (decision #6); otherwise it's a
    // harmless no-op. Idempotent + hour-based (see advanceWaitlistOffer).
    await scheduleWaitlistAdvance(ctx, {
      laneId: args.laneId,
      date: args.date,
      startHour: args.startHour,
      duration: args.duration,
    });

    // SPEC_PAYMENTS_AND_CREDIT #3: a pending_payment booking holds its slot via a
    // checkout slotHold; if the customer abandons Stripe it's released by the
    // sweep / expired webhook. Confirmation deletes the hold.
    if (effectiveStatus === "pending_payment") {
      await createCheckoutHold(ctx, {
        bookingId: id.toString(),
        laneId: args.laneId,
        additionalLaneIds: args.additionalLaneIds,
        date: args.date,
        startHour: args.startHour,
        duration: args.duration,
        userId: args.userId,
        userEmail: args.customerEmail,
        expiresAtMs: Date.now() + (await abandonedCheckoutMs(ctx)),
      });
    }

    // If a confirmed booking redeems account credit, deduct it now (atomic at
    // confirmation — never on the pending/abandoned path). Stripe-paid bookings
    // are deducted later in confirmBookingPayment.
    if (effectiveStatus === "confirmed" && (args.creditApplied ?? 0) > 0 && args.customerEmail) {
      await redeemCredit(ctx, {
        email: args.customerEmail,
        amount: args.creditApplied as number,
        bookingId: id.toString(),
      });
    }

    // Record discount redemption for directly-confirmed bookings (free/comp/
    // bypassStripe). Stripe-paid bookings are recorded in confirmBookingPayment.
    if (effectiveStatus === "confirmed" && args.discountCode) {
      await recordDiscountRedemption(ctx, {
        code: args.discountCode,
        customerEmail: args.customerEmail,
        bookingId: id.toString(),
      });
    }

    // Send booking confirmation email for confirmed bookings
    if (effectiveStatus === "confirmed" && args.customerEmail) {
      await ctx.scheduler.runAfter(
        0,
        internal.emails.sendBookingConfirmation,
        buildConfirmationEmailArgs({
          customerEmail: args.customerEmail,
          customerName: args.customerName,
          laneId: args.laneId,
          date: args.date,
          startHour: args.startHour,
          duration: args.duration,
          accessCode: bookingAccessCode,
          coachPrice: args.coachPrice,
          creditApplied: args.creditApplied,
        }),
      );
    }

    // Send athlete allocation emails for coach bookings with initial athlete
    // slots — resolved to the parent account email + child name, grouped per
    // account (SPEC_PARENT_ATHLETE_MODEL).
    if (args.isCoachBooking && normalizedAthleteSlots && normalizedAthleteSlots.length > 0 && (effectiveStatus === "confirmed" || effectiveStatus === "tentative")) {
      await scheduleAllocationEmails(ctx, {
        slots: normalizedAthleteSlots,
        laneId: args.laneId,
        date: args.date,
        bookingAccessCode: bookingAccessCode,
        coachName: args.customerName,
      });
    }

    // Trigger Google Calendar sync for confirmed/tentative bookings
    if (effectiveStatus === "confirmed" || effectiveStatus === "tentative") {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.createCalendarEvent, {
        bookingId: id.toString(),
        laneId: args.laneId,
        variantId: args.variantId,
        date: args.date,
        startHour: args.startHour,
        duration: args.duration,
        customerName: args.customerName,
        customerEmail: args.customerEmail,
        customerPhone: args.customerPhone,
        status: effectiveStatus,
        isCoachBooking: args.isCoachBooking,
        accessCode: bookingAccessCode,
        additionalLaneIds: args.additionalLaneIds,
        athleteSlots: normalizedAthleteSlots,
      });
    }

    return id;
  },
});

// Update a booking (partial update) — ADMIN ONLY
export const updateBooking = mutation({
  args: {
    id: v.id("bookings"),
    laneId: v.optional(v.string()),
    variantId: v.optional(v.string()),
    date: v.optional(v.string()),
    startHour: v.optional(v.number()),
    duration: v.optional(v.number()),
    customerName: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerPhone: v.optional(v.string()),
    userId: v.optional(v.string()),
    status: v.optional(v.string()),
    stripeSessionId: v.optional(v.string()),
    isCoachBooking: v.optional(v.boolean()),
    coachPrice: v.optional(v.number()),
    additionalLaneIds: v.optional(v.array(v.string())),
    athleteSlots: v.optional(
      v.array(
        v.object({
          athleteId: v.optional(v.id("athletes")),
          athleteName: v.string(),
          startHour: v.number(),
          durationMinutes: v.number(),
          accessCode: v.optional(v.string()),
          codeGeneratedAt: v.optional(v.string()),
        })
      )
    ),
    creditApplied: v.optional(v.number()),
    cancelledAt: v.optional(v.string()),
    cancelledByUserId: v.optional(v.string()),
    refilledMinutes: v.optional(v.number()),
    originalCoachId: v.optional(v.string()),
    tentativeSourceId: v.optional(v.string()),
    tentativeForDate: v.optional(v.string()),
    accessCode: v.optional(v.string()),
    discountCode: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const adminUser = await requireAdmin(ctx);
    const { id, ...updates } = args;
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    // Build modification history entry by comparing old vs new
    const existing = await ctx.db.get(id);
    if (existing) {
      const TRACKED_FIELDS = [
        "laneId",
        "date",
        "startHour",
        "duration",
        "customerName",
        "customerEmail",
        "customerPhone",
        "status",
        "coachPrice",
        "creditApplied",
        "discountCode",
        "variantId",
      ];
      const changes: Array<{ field: string; oldValue?: string; newValue?: string }> = [];
      for (const field of TRACKED_FIELDS) {
        if (field in cleanUpdates) {
          const oldVal = (existing as any)[field];
          const newVal = (cleanUpdates as any)[field];
          if (oldVal !== newVal) {
            changes.push({
              field,
              oldValue: oldVal === undefined || oldVal === null ? undefined : String(oldVal),
              newValue: newVal === undefined || newVal === null ? undefined : String(newVal),
            });
          }
        }
      }
      if (changes.length > 0) {
        const prevHistory = (existing as any).modificationHistory ?? [];
        (cleanUpdates as any).modificationHistory = [
          ...prevHistory,
          {
            modifiedAt: new Date().toISOString(),
            modifiedByUserId: (adminUser as any)?._id?.toString?.() ?? (adminUser as any)?.id ?? undefined,
            modifiedByName: (adminUser as any)?.name ?? (adminUser as any)?.email ?? "Admin",
            changes,
          },
        ];
      }
    }

    // For coach bookings, ensure athlete slots share the coach's access code
    const mergedExisting: any = existing ?? {};
    const isCoach = (cleanUpdates as any).isCoachBooking ?? mergedExisting.isCoachBooking;
    const effectiveCode = (cleanUpdates as any).accessCode ?? mergedExisting.accessCode;
    const effectiveSlots = (cleanUpdates as any).athleteSlots ?? mergedExisting.athleteSlots;
    if (isCoach && effectiveCode && Array.isArray(effectiveSlots)) {
      (cleanUpdates as any).athleteSlots = effectiveSlots.map((s: any) => ({
        ...s,
        accessCode: effectiveCode,
        codeGeneratedAt: s.codeGeneratedAt ?? new Date().toISOString(),
      }));
    }

    // Compute scheduling change info once (used for conflict check, GCal, email)
    const effNewDate = (cleanUpdates as any).date ?? (existing as any)?.date;
    const effNewStartHour = (cleanUpdates as any).startHour ?? (existing as any)?.startHour;
    const effNewDuration = (cleanUpdates as any).duration ?? (existing as any)?.duration;
    const effNewLaneId = (cleanUpdates as any).laneId ?? (existing as any)?.laneId;
    const effNewAdditionalLanes: string[] = (cleanUpdates as any).additionalLaneIds ?? (existing as any)?.additionalLaneIds ?? [];
    const schedulingChanged = existing != null && (
      ((cleanUpdates as any).date !== undefined && (cleanUpdates as any).date !== (existing as any).date) ||
      ((cleanUpdates as any).startHour !== undefined && (cleanUpdates as any).startHour !== (existing as any).startHour) ||
      ((cleanUpdates as any).duration !== undefined && (cleanUpdates as any).duration !== (existing as any).duration) ||
      ((cleanUpdates as any).laneId !== undefined && (cleanUpdates as any).laneId !== (existing as any).laneId)
    );

    // DI-1: Conflict check when scheduling fields change
    if (schedulingChanged && effNewDate && effNewStartHour != null && effNewDuration != null && effNewLaneId) {
      const endHourUpd = effNewStartHour + effNewDuration / 60;
      const allLanesUpd = [effNewLaneId, ...effNewAdditionalLanes];
      for (const lid of allLanesUpd) {
        const laneBookingsUpd = await ctx.db
          .query("bookings")
          .withIndex("by_laneId_date", (q: any) => q.eq("laneId", lid).eq("date", effNewDate))
          .collect();
        const hasConflictUpd = laneBookingsUpd.some((b) => {
          if (b._id === id || b.status === "cancelled") return false;
          const bEnd = b.startHour + b.duration / 60;
          return effNewStartHour < bEnd && endHourUpd > b.startHour;
        });
        if (hasConflictUpd) {
          throw new ConvexError("Cannot update — the new time slot conflicts with an existing booking.");
        }
      }
    }

    // MF-1: Add account credit when admin reduces coach price
    if (existing) {
      const oldCoachPrice = (existing as any).coachPrice;
      const newCoachPriceUpd = (cleanUpdates as any).coachPrice;
      if (typeof oldCoachPrice === "number" && typeof newCoachPriceUpd === "number" && newCoachPriceUpd < oldCoachPrice) {
        const creditAmt = Math.round((oldCoachPrice - newCoachPriceUpd) * 100) / 100;
        if (creditAmt > 0) {
          const credEmail = ((cleanUpdates as any).customerEmail ?? (existing as any).customerEmail ?? "").toLowerCase().trim();
          if (credEmail) {
            await issueCredit(ctx, {
              email: credEmail,
              amount: creditAmt,
              reason: "modify_decrease",
              bookingId: id.toString(),
            });
          }
        }
      }
    }

    await ctx.db.patch(id, cleanUpdates);

    // DI-2 / MF-2: GCal sync + customer notification when scheduling changes
    if (schedulingChanged && existing && effNewDate && effNewStartHour != null && effNewDuration != null && effNewLaneId) {
      const LANE_NAMES_UPD: Record<string, string> = { bm1: "Bowling Machine 1", bm2: "Bowling Machine 2", bm3: "Bowling Machine 3", ru1: "9m Run Up 1", ru2: "9m Run Up 2" };
      const fmtTUpd = (h: number) => {
        const w = Math.floor(h); const m = Math.round((h - w) * 60);
        const p = w >= 12 ? "PM" : "AM"; const dh = w > 12 ? w - 12 : w === 0 ? 12 : w;
        return `${dh}:${m.toString().padStart(2, "0")} ${p}`;
      };
      const fmtDUpd = (d: number) => d === 60 ? "1 hour" : d === 90 ? "1.5 hours" : d === 30 ? "30 minutes" : `${d} min`;
      const notifyEmail = ((cleanUpdates as any).customerEmail ?? (existing as any).customerEmail ?? "") as string;

      if ((existing as any).googleCalendarEventId) {
        await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
          googleCalendarEventId: (existing as any).googleCalendarEventId,
          laneCalendarEventIds: (existing as any).googleCalendarEventIds,
        });
        await ctx.scheduler.runAfter(500, internal.googleCalendar.createCalendarEvent, {
          bookingId: id.toString(),
          laneId: effNewLaneId,
          variantId: (cleanUpdates as any).variantId ?? (existing as any).variantId,
          date: effNewDate,
          startHour: effNewStartHour,
          duration: effNewDuration,
          customerName: (cleanUpdates as any).customerName ?? (existing as any).customerName,
          customerEmail: notifyEmail,
          customerPhone: (cleanUpdates as any).customerPhone ?? (existing as any).customerPhone,
          status: (cleanUpdates as any).status ?? (existing as any).status,
          isCoachBooking: (existing as any).isCoachBooking,
          accessCode: (cleanUpdates as any).accessCode ?? (existing as any).accessCode,
          additionalLaneIds: effNewAdditionalLanes,
          athleteSlots: (cleanUpdates as any).athleteSlots ?? (existing as any).athleteSlots,
        });
      }

      if (notifyEmail) {
        await ctx.scheduler.runAfter(0, internal.emails.sendBookingRescheduled, {
          to: notifyEmail,
          customerName: (cleanUpdates as any).customerName ?? (existing as any).customerName ?? "Valued Customer",
          oldLaneName: LANE_NAMES_UPD[(existing as any).laneId] ?? (existing as any).laneId,
          oldDate: (existing as any).date,
          oldTimeSlot: fmtTUpd((existing as any).startHour),
          newLaneName: LANE_NAMES_UPD[effNewLaneId] ?? effNewLaneId,
          newDate: effNewDate,
          newTimeSlot: fmtTUpd(effNewStartHour),
          newDuration: fmtDUpd(effNewDuration),
          accessCode: (cleanUpdates as any).accessCode ?? (existing as any).accessCode ?? "",
        });
      }
    }

    return id;
  },
});

// Cancel a booking
export const cancelBooking = mutation({
  args: {
    id: v.id("bookings"),
    cancelledByUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.id);
    if (!booking) throw new ConvexError("Booking not found.");
    if (booking.status === "cancelled")
      throw new ConvexError("Already cancelled.");

    // Auth guard: only booking owner or admin can cancel
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required to cancel a booking.");
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const isOwner =
      (booking.userId != null && booking.userId === identity.subject) ||
      booking.customerEmail.toLowerCase() === callerEmail;
    if (!isOwner) {
      const callerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
        .first();
      if (callerCustomer?.role !== "admin") {
        throw new ConvexError("You can only cancel your own bookings.");
      }
    }

    const cancelSettings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();

    // Hours until the session starts (AWST) — shared by both policy checks below.
    const [cYear, cMonth, cDay] = booking.date.split("-").map(Number);
    const cWhole = Math.floor(booking.startHour);
    const cMins = Math.round((booking.startHour - cWhole) * 60);
    const bookingStart = new Date(cYear, cMonth - 1, cDay, cWhole, cMins, 0);
    const awstNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Australia/Perth" }));
    const hoursUntil = (bookingStart.getTime() - awstNow.getTime()) / (1000 * 60 * 60);

    // Time-based policy enforcement for customer bookings
    if (booking.status !== "tentative" && !booking.isCoachBooking) {
      const customerCancellationHours = (cancelSettings as any)?.customerCancellationHours ?? cancelSettings?.cancellationHoursBefore ?? 2;
      if (hoursUntil < customerCancellationHours) {
        // Admin bypass — admins can always cancel
        const callerCheck = await ctx.db
          .query("customers")
          .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
          .first();
        if (callerCheck?.role !== "admin") {
          throw new ConvexError(
            `Bookings can only be cancelled at least ${customerCancellationHours} hour${customerCancellationHours !== 1 ? "s" : ""} before the session starts.`
          );
        }
      }
    }

    // SPEC_PAYMENTS_AND_CREDIT #4: coach late-cancel = charged in full. Coaches
    // (and admins acting on coach bookings) may cancel, but if it's inside the
    // late-cancel window the slot stays on the coach statement as a charge.
    let coachLateCancelCharged = false;
    if (booking.isCoachBooking && booking.status !== "tentative") {
      const coachLateHours = (cancelSettings as any)?.coachLateCancellationHours ?? 24;
      if (hoursUntil < coachLateHours) {
        coachLateCancelCharged = true;
      }
    }

    await ctx.db.patch(args.id, {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancelledByUserId: args.cancelledByUserId,
      ...(coachLateCancelCharged ? { coachLateCancelCharged: true } : {}),
    });

    // SPEC_PAYMENTS_AND_CREDIT #2: cancelling a PAID customer booking auto-issues
    // the value back as account credit (cash charged + any credit previously
    // applied) — no Stripe card refund. Coach bookings aren't prepaid online, so
    // they're never credited; unpaid (pending_payment) bookings have nothing to
    // return. Admins may still issue a manual Stripe refund as an exception.
    if (
      !booking.isCoachBooking &&
      booking.status === "confirmed" &&
      booking.customerEmail
    ) {
      // C2 (SECURITY): only return CASH as credit when the booking was actually
      // paid (Stripe webhook or admin paid-offline → paymentStatus "paid"). A
      // never-paid "confirmed" booking (priceInCents set but no payment) must NOT
      // mint credit. Redeemed account credit (creditApplied) is always returned —
      // it was real value the customer spent (covers credit-only cancellations).
      const wasPaid = (booking as any).paymentStatus === "paid";
      const cashPaid = wasPaid && (booking as any).priceInCents != null ? (booking as any).priceInCents / 100 : 0;
      const creditToIssue = cashPaid + ((booking as any).creditApplied ?? 0);
      if (creditToIssue > 0) {
        await issueCredit(ctx, {
          email: booking.customerEmail,
          amount: creditToIssue,
          reason: "cancellation",
          bookingId: args.id.toString(),
        });
      }
    }

    // Release any checkout hold tied to this booking (frees it for the sweep).
    await releaseHoldForBooking(ctx, args.id.toString());

    // SPEC_WAITLIST_OFFER_REDESIGN: the slot just freed — offer it to the next
    // waitlisted member (sequential first-refusal). Auto-triggered, no admin.
    await scheduleWaitlistAdvance(ctx, {
      laneId: booking.laneId,
      date: booking.date,
      startHour: booking.startHour,
      duration: booking.duration,
    });

    // SPEC_ADD_A_MATE M4: tell every mate the booking is off + invalidate any
    // pending SMS invites. Fires for owner AND admin cancellations (same path).
    await notifyMatesOnCancel(ctx, booking);

    // Sync cancellation to Google Calendar
    if (booking.googleCalendarEventId) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
        googleCalendarEventId: booking.googleCalendarEventId,
        laneCalendarEventIds: booking.googleCalendarEventIds,
      });
    }

    // Send cancellation confirmation email
    if (booking.customerEmail) {
      const LANE_NAMES: Record<string, string> = { bm1: "Bowling Machine 1", bm2: "Bowling Machine 2", bm3: "Bowling Machine 3", ru1: "9m Run Up 1", ru2: "9m Run Up 2" };
      const whole = Math.floor(booking.startHour);
      const mins = Math.round((booking.startHour - whole) * 60);
      const period = whole >= 12 ? "PM" : "AM";
      const displayHour = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
      const timeSlot = `${displayHour}:${mins.toString().padStart(2, "0")} ${period}`;
      const durationLabel = booking.duration === 60 ? "1 hour" : booking.duration === 90 ? "1.5 hours" : booking.duration === 30 ? "30 minutes" : `${booking.duration} min`;

      await ctx.scheduler.runAfter(0, internal.emails.sendBookingCancellation, {
        to: booking.customerEmail,
        customerName: booking.customerName || "Valued Customer",
        laneName: LANE_NAMES[booking.laneId] ?? booking.laneId,
        date: booking.date,
        timeSlot,
        duration: durationLabel,
      });
    }

    // Bug #1: notify allocated athletes that the coach session is cancelled.
    // Slots are KEPT (decision #2) — record stays on the coach's Cancelled tab.
    // Covers admin-initiated cancels too (same mutation). Mandatory emails.
    if (booking.isCoachBooking && booking.athleteSlots && booking.athleteSlots.length > 0) {
      await scheduleAthleteCancellationEmails(ctx, {
        slots: booking.athleteSlots,
        laneId: booking.laneId,
        date: booking.date,
        coachName: booking.customerName,
      });
      await writeAllocationAudit(ctx, {
        bookingId: args.id.toString(),
        actorUserId: args.cancelledByUserId,
        action: "cancel",
        before: booking.athleteSlots,
        after: booking.athleteSlots,
      });
    }

    return args.id;
  },
});

// Delete a booking — ADMIN ONLY
export const deleteBooking = mutation({
  args: { id: v.id("bookings") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const delBooking = await ctx.db.get(args.id);
    if (delBooking) {
      // DI-7: Add account credit for the booking's value (credit, not Stripe refund).
      // Coach bookings are billed weekly (not prepaid online), so they are NOT
      // credited — only customer-paid value (cash charged + credit previously
      // applied) is returned as credit.
      if (delBooking.status !== "cancelled" && !delBooking.isCoachBooking) {
        // C2 (SECURITY): cash credited only if actually paid; redeemed credit always returned.
        const wasPaid = (delBooking as any).paymentStatus === "paid";
        const cashPaid = wasPaid && (delBooking as any).priceInCents != null ? (delBooking as any).priceInCents / 100 : 0;
        const creditAmt = cashPaid + ((delBooking as any).creditApplied ?? 0);
        if (creditAmt > 0 && delBooking.customerEmail) {
          await issueCredit(ctx, {
            email: delBooking.customerEmail,
            amount: creditAmt,
            reason: "cancellation",
            bookingId: args.id.toString(),
            note: "Booking deleted by admin",
          });
        }
      }

      // DI-7: Clean up Google Calendar event
      if ((delBooking as any).googleCalendarEventId) {
        await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
          googleCalendarEventId: (delBooking as any).googleCalendarEventId,
          laneCalendarEventIds: (delBooking as any).googleCalendarEventIds,
        });
      }

      // DI-7: Send cancellation email to customer
      if (delBooking.customerEmail && delBooking.status !== "cancelled") {
        const LANE_NAMES_DEL: Record<string, string> = { bm1: "Bowling Machine 1", bm2: "Bowling Machine 2", bm3: "Bowling Machine 3", ru1: "9m Run Up 1", ru2: "9m Run Up 2" };
        const whole = Math.floor(delBooking.startHour);
        const mins = Math.round((delBooking.startHour - whole) * 60);
        const period = whole >= 12 ? "PM" : "AM";
        const displayHour = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
        const timeSlot = `${displayHour}:${mins.toString().padStart(2, "0")} ${period}`;
        const durationLabel = delBooking.duration === 60 ? "1 hour" : delBooking.duration === 90 ? "1.5 hours" : delBooking.duration === 30 ? "30 minutes" : `${delBooking.duration} min`;
        await ctx.scheduler.runAfter(0, internal.emails.sendBookingCancellation, {
          to: delBooking.customerEmail,
          customerName: delBooking.customerName || "Valued Customer",
          laneName: LANE_NAMES_DEL[delBooking.laneId] ?? delBooking.laneId,
          date: delBooking.date,
          timeSlot,
          duration: durationLabel,
        });
      }
    }

    await ctx.db.delete(args.id);
    return args.id;
  },
});

// Edit coach booking duration (with cancellation terms enforcement)
export const editBookingDuration = mutation({
  args: {
    id: v.id("bookings"),
    newDuration: v.number(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.id);
    if (!booking) throw new ConvexError("Booking not found.");
    if (booking.status === "cancelled") throw new ConvexError("Cannot edit a cancelled booking.");
    // H5 (SECURITY): authorize on the AUTHENTICATED identity, not the client-supplied
    // args.userId (was unauthenticated + IDOR — no getUserIdentity at all).
    const editIdentity = await ctx.auth.getUserIdentity();
    if (!editIdentity) throw new ConvexError("Authentication required.");
    const editCallerEmail = editIdentity.email?.toLowerCase().trim() ?? "";
    const editIsOwner =
      (editIdentity.subject != null && booking.userId === editIdentity.subject) ||
      (editCallerEmail !== "" && booking.customerEmail.toLowerCase() === editCallerEmail);
    const editCaller = editCallerEmail
      ? await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", editCallerEmail)).first()
      : null;
    if (!editIsOwner && (editCaller as any)?.role !== "admin") throw new ConvexError("You can only edit your own bookings.");

    const editDurSettings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const CLOSING_HOUR = editDurSettings?.closingHour ?? 21;
    const newEndHour = booking.startHour + args.newDuration / 60;
    if (newEndHour > CLOSING_HOUR) {
      throw new ConvexError("New duration extends past closing time.");
    }
    if (args.newDuration < 30) {
      throw new ConvexError("Minimum booking duration is 30 minutes.");
    }

    const isShortening = args.newDuration < booking.duration;
    const isExtending = args.newDuration > booking.duration;

    // Compute minutes until booking start (AWST)
    const [year, month, day] = booking.date.split("-").map(Number);
    const whole = Math.floor(booking.startHour);
    const mins = Math.round((booking.startHour - whole) * 60);
    const bookingStart = new Date(year, month - 1, day, whole, mins, 0);
    const now = new Date();
    const awstStr = now.toLocaleString("en-US", { timeZone: "Australia/Perth" });
    const awstNow = new Date(awstStr);
    const minutesUntil = (bookingStart.getTime() - awstNow.getTime()) / (1000 * 60);

    // Extending: allowed within 2-hour window before start, but must be >N min before start
    if (isExtending) {
      const extensionNoticeMin = editDurSettings?.extensionNoticeMinutes ?? 20;
      if (minutesUntil <= extensionNoticeMin) {
        throw new ConvexError(`Extensions must be made more than ${extensionNoticeMin} minutes before the booking starts.`);
      }
    }

    // If shortening, apply cancellation terms from site settings (coach-specific threshold)
    if (isShortening) {
      const cancellationHours = (editDurSettings as any)?.coachLateCancellationHours ?? editDurSettings?.cancellationHoursBefore ?? 24;
      const hoursUntil = minutesUntil / 60;
      if (hoursUntil < cancellationHours) {
        throw new ConvexError(
          `Bookings can only be shortened at least ${cancellationHours} hour${cancellationHours !== 1 ? "s" : ""} before the session starts. You are charged for the original duration.`
        );
      }
    }

    // If extending, check for conflicts
    if (args.newDuration > booking.duration) {
      const allLaneIds = [booking.laneId, ...(booking.additionalLaneIds ?? [])];
      for (const lid of allLaneIds) {
        const laneBookings = await ctx.db
          .query("bookings")
          .withIndex("by_laneId_date", (q: any) =>
            q.eq("laneId", lid).eq("date", booking.date)
          )
          .collect();

        const hasConflict = laneBookings.some((b) => {
          if (b._id === args.id || b.status === "cancelled") return false;
          const bEnd = b.startHour + b.duration / 60;
          return booking.startHour < bEnd && newEndHour > b.startHour;
        });

        if (hasConflict) {
          throw new ConvexError(
            "Cannot extend — another booking conflicts with the new duration."
          );
        }
      }
    }

    // Recalculate coach price based on new duration (DI-6: use settings rate)
    const halfHours = args.newDuration / 30;
    const coachPer30MinEdit = editDurSettings?.coachPer30Min ?? PRICE_DEFAULTS.coachPer30Min;
    const newCoachPrice = halfHours * coachPer30MinEdit;

    // Bug #7: keep-what-fits when shortening a coach booking. Start time is
    // unchanged, so only slots that now extend past the new end are dropped
    // (never left dangling outside the window); dropped athletes get a removed
    // email + audit entry. Kept slots are untouched.
    const prevDurSlots = booking.athleteSlots ?? [];
    const durDroppedSlots: any[] = [];
    let durAdjustedSlots: any = booking.athleteSlots;
    if (isShortening && prevDurSlots.length > 0) {
      const newEnd = booking.startHour + args.newDuration / 60;
      const kept: any[] = [];
      for (const slot of prevDurSlots) {
        const slotEnd = slot.startHour + slot.durationMinutes / 60;
        if (slotEnd > newEnd + 0.001) durDroppedSlots.push(slot);
        else kept.push(slot);
      }
      durAdjustedSlots = kept.length > 0 ? kept : undefined;
    }

    await ctx.db.patch(args.id, {
      duration: args.newDuration,
      coachPrice: newCoachPrice,
      ...(isShortening && prevDurSlots.length > 0 ? { athleteSlots: durAdjustedSlots } : {}),
    });

    if (booking.isCoachBooking && durDroppedSlots.length > 0) {
      await scheduleAthleteRemovedEmails(ctx, {
        slots: durDroppedSlots,
        laneId: booking.laneId,
        date: booking.date,
        coachName: booking.customerName,
      });
      await writeAllocationAudit(ctx, {
        bookingId: args.id.toString(),
        actorUserId: args.userId,
        actorName: booking.customerName,
        action: "remove",
        before: prevDurSlots,
        after: durAdjustedSlots ?? [],
      });
    }

    // Google Calendar — duration (and possibly athlete slots) changed; the lane,
    // date and start are unchanged, so UPDATE the existing event(s) in place.
    const finalDurSlots = (isShortening && prevDurSlots.length > 0 ? (durAdjustedSlots ?? []) : (booking.athleteSlots ?? [])) as any[];
    const durHadEvents = !!booking.googleCalendarEventId || (Array.isArray(booking.googleCalendarEventIds) && booking.googleCalendarEventIds.length > 0);
    if (durHadEvents) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.updateCalendarEvent, {
        googleCalendarEventId: booking.googleCalendarEventId ?? "",
        laneId: booking.laneId,
        variantId: booking.variantId,
        date: booking.date,
        startHour: booking.startHour,
        duration: args.newDuration,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone,
        status: booking.status,
        isCoachBooking: booking.isCoachBooking,
        accessCode: booking.accessCode,
        additionalLaneIds: booking.additionalLaneIds,
        athleteSlots: finalDurSlots.map((s: any) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
        laneCalendarEventIds: booking.googleCalendarEventIds,
      });
    }

    return { id: args.id, droppedAthletes: durDroppedSlots.map((s: any) => s.athleteName) };
  },
});

// ============================================================================
// RESCHEDULE BOOKING MUTATION
// ============================================================================

export const rescheduleBooking = mutation({
  args: {
    id: v.id("bookings"),
    newDate: v.string(),
    newStartHour: v.number(),
    newDuration: v.number(),
    newLaneId: v.optional(v.string()),
    newVariantId: v.optional(v.string()),
    newAdditionalLaneIds: v.optional(v.array(v.string())),
    userId: v.string(),
    newAccessCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.id);
    if (!booking) throw new ConvexError("Booking not found.");
    if (booking.status === "cancelled") throw new ConvexError("Cannot reschedule a cancelled booking.");
    if (booking.status === "tentative") throw new ConvexError("Confirm the tentative booking first, then reschedule.");

    // SEC-2: server-side identity for auth. B-1: rescheduleBooking is the COACH
    // PLANNER path only (drag/resize of coach sessions — no online payment).
    // Customers change their bookings through modifyBooking, which enforces the
    // full price/credit/time-lock matrix. So: an admin may reschedule anything; a
    // non-admin may reschedule ONLY a coach booking they own. This closes the
    // customer-bypass that let a crafted request skip modifyBooking's checks.
    const reschedIdentity = await ctx.auth.getUserIdentity();
    if (!reschedIdentity) throw new ConvexError("Authentication required.");
    const reschedCallerEmail = reschedIdentity.email?.toLowerCase().trim() ?? "";
    const reschedCaller = reschedCallerEmail ? await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", reschedCallerEmail))
      .first() : null;
    const isAdminCaller = reschedCaller?.role === "admin";

    // H4 (SECURITY): authorize on the AUTHENTICATED identity only — the client
    // `args.userId` is NOT trusted (was an IDOR: pass a victim's email as userId).
    const isOwner =
      (reschedIdentity.subject != null && booking.userId === reschedIdentity.subject) ||
      (reschedCallerEmail !== "" && booking.customerEmail.toLowerCase() === reschedCallerEmail);

    if (!isAdminCaller) {
      if (!booking.isCoachBooking) {
        throw new ConvexError("Use Modify to change this booking.");
      }
      if (!isOwner) {
        throw new ConvexError("You can only reschedule your own bookings.");
      }
    }

    // Enforce cancellation policy — must be at least N hours before original booking
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const cancellationHours = (settings as any)?.customerCancellationHours ?? settings?.cancellationHoursBefore ?? 2;

    const [oYear, oMonth, oDay] = booking.date.split("-").map(Number);
    const oWhole = Math.floor(booking.startHour);
    const oMins = Math.round((booking.startHour - oWhole) * 60);
    const originalStart = new Date(oYear, oMonth - 1, oDay, oWhole, oMins, 0);
    const now = new Date();
    const awstStr = now.toLocaleString("en-US", { timeZone: "Australia/Perth" });
    const awstNow = new Date(awstStr);
    const hoursUntilOriginal = (originalStart.getTime() - awstNow.getTime()) / (1000 * 60 * 60);

    if (hoursUntilOriginal < cancellationHours) {
      throw new ConvexError(
        `Bookings can only be rescheduled at least ${cancellationHours} hour${cancellationHours !== 1 ? "s" : ""} before the session starts.`
      );
    }

    // Coaches cannot self-reschedule within N hours of booking start
    const coachFreezeHours = settings?.coachRescheduleFreezeHours ?? 24;
    if (booking.isCoachBooking && hoursUntilOriginal < coachFreezeHours && !isAdminCaller) {
      throw new ConvexError(
        `Coach bookings cannot be rescheduled within ${coachFreezeHours} hours of the session start time.`
      );
    }

    // B-1: per-day operating hours (dailyHours SSOT) + closure check for the NEW
    // date — previously reschedule only checked the single openingHour/closingHour
    // pair and ignored closed days / closures entirely (a customer could land a
    // booking on a closed day via reschedule).
    const newEndHour = args.newStartHour + args.newDuration / 60;
    const RDOW_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const [rdY, rdM, rdD] = args.newDate.split("-").map(Number);
    const rDowName = RDOW_NAMES[new Date(rdY, rdM - 1, rdD).getDay()];
    const rDayHours = (settings as any)?.dailyHours?.find((h: any) => h.day === rDowName);
    const OPENING_HOUR = rDayHours ? rDayHours.open : (settings?.openingHour ?? 7);
    const CLOSING_HOUR = rDayHours ? rDayHours.close : (settings?.closingHour ?? 21);
    if (rDayHours?.closed) {
      throw new ConvexError("The facility is closed on this day.");
    }
    if (args.newStartHour < OPENING_HOUR) {
      throw new ConvexError(`Bookings cannot start before ${OPENING_HOUR}:00.`);
    }
    if (newEndHour > CLOSING_HOUR) {
      throw new ConvexError("New booking extends past closing time.");
    }
    if (args.newDuration < 30) {
      throw new ConvexError("Minimum booking duration is 30 minutes.");
    }

    // Reject reschedules onto a closed date (closures table).
    const rClosure = await ctx.db
      .query("closures")
      .withIndex("by_date", (q: any) => q.eq("date", args.newDate))
      .first();
    if (rClosure) {
      throw new ConvexError(`Facility is closed on this date${rClosure.reason ? `: ${rClosure.reason}` : "."}`);
    }

    // Validate new booking is in the future
    const [nYear, nMonth, nDay] = args.newDate.split("-").map(Number);
    const nWhole = Math.floor(args.newStartHour);
    const nMins = Math.round((args.newStartHour - nWhole) * 60);
    const newStart = new Date(nYear, nMonth - 1, nDay, nWhole, nMins, 0);
    const newStartAwstStr = newStart.toLocaleString("en-US", { timeZone: "Australia/Perth" });
    const minNotice = settings?.minBookingNoticeMinutes ?? 10;
    const minutesUntilNew = (new Date(newStartAwstStr).getTime() - awstNow.getTime()) / (1000 * 60);
    if (minutesUntilNew < minNotice) {
      throw new ConvexError(`New booking must be at least ${minNotice} minutes in the future.`);
    }

    // Check for conflicts at the new slot (excluding the current booking)
    const newLaneId = args.newLaneId ?? booking.laneId;
    const allNewLaneIds = [newLaneId, ...(args.newAdditionalLaneIds ?? [])];

    for (const lid of allNewLaneIds) {
      const laneBookings = await ctx.db
        .query("bookings")
        .withIndex("by_laneId_date", (q: any) =>
          q.eq("laneId", lid).eq("date", args.newDate)
        )
        .collect();

      const hasConflict = laneBookings.some((b) => {
        if (b._id === args.id || b.status === "cancelled") return false;
        const bEnd = b.startHour + b.duration / 60;
        return args.newStartHour < bEnd && newEndHour > b.startHour;
      });

      if (hasConflict) {
        throw new ConvexError(
          "The new time slot is not available. Please choose another time."
        );
      }

      // B-1: also respect lane service/repair blocks on the new slot.
      const rLaneBlocks = await ctx.db
        .query("laneBlocks")
        .withIndex("by_laneId_date", (q: any) => q.eq("laneId", lid).eq("date", args.newDate))
        .collect();
      const hasBlockConflict = rLaneBlocks.some((bl: any) => {
        const bEnd = bl.startHour + bl.duration / 60;
        return args.newStartHour < bEnd && newEndHour > bl.startHour;
      });
      if (hasBlockConflict) {
        throw new ConvexError("This lane is blocked for service/repair during this time.");
      }
    }

    // B-1: respect active slot holds on the NEW slot (in-flight customer checkout
    // / waitlist offers). Coach/admin aren't fenced off by a customer waitlist
    // offer (bypassWaitlistHolds), but an in-flight checkout hold still blocks.
    if (
      await hasActiveHoldConflict(ctx, {
        laneIds: allNewLaneIds,
        date: args.newDate,
        startHour: args.newStartHour,
        endHour: newEndHour,
        callerUserId: args.userId,
        bypassWaitlistHolds: true,
      })
    ) {
      throw new ConvexError("The new time slot is not available. Please choose another time.");
    }

    // Calculate new price (use settings-driven rate — fixes hardcoded * 15 bug)
    const isCoach = booking.isCoachBooking;
    let newCoachPrice = booking.coachPrice;
    if (isCoach) {
      const halfHours = args.newDuration / 30;
      const coachRatePer30 = settings?.coachPer30Min ?? PRICE_DEFAULTS.coachPer30Min;
      newCoachPrice = halfHours * coachRatePer30;
    }

    // Bug #7: keep-what-fits. Shift every athlete slot by the time delta and
    // keep those that still fit the new window. Slots that no longer fit are NOT
    // silently dropped — the coach is told (return value), dropped athletes get a
    // removed email, and the rest get a reschedule email (#3b).
    const prevAthleteSlots = booking.athleteSlots ?? [];
    const keptSlots: any[] = [];
    const droppedSlots: any[] = [];
    let adjustedAthleteSlots: any = booking.athleteSlots;
    if (prevAthleteSlots.length > 0) {
      const timeDiff = args.newStartHour - booking.startHour;
      const newBookingEnd = args.newStartHour + args.newDuration / 60;
      for (const slot of prevAthleteSlots) {
        const shifted = { ...slot, startHour: slot.startHour + timeDiff };
        const slotEnd = shifted.startHour + shifted.durationMinutes / 60;
        if (shifted.startHour < args.newStartHour - 0.001 || slotEnd > newBookingEnd + 0.001) {
          droppedSlots.push(slot); // report the original (pre-shift) slot
        } else {
          keptSlots.push(shifted);
        }
      }
      adjustedAthleteSlots = keptSlots.length > 0 ? keptSlots : undefined;
    }

    // Lane set change → MOVE the calendar event to the new lane's calendar;
    // same lane(s) → update the existing event(s) in place.
    const rOldCalEventId = booking.googleCalendarEventId;
    const rOldCalEventIds = booking.googleCalendarEventIds;
    const rOldLaneKey = [booking.laneId, ...((booking.additionalLaneIds ?? []) as string[])].slice().sort().join(",");
    const rNewLaneKey = [newLaneId, ...((args.newAdditionalLaneIds ?? booking.additionalLaneIds ?? []) as string[])].slice().sort().join(",");
    const rLaneSetChanged = rOldLaneKey !== rNewLaneKey;
    const rHadEvents = !!rOldCalEventId || (Array.isArray(rOldCalEventIds) && rOldCalEventIds.length > 0);
    // C3 (SECURITY): on a real slot change the SERVER mints the new code; the
    // client-supplied args.newAccessCode is ignored.
    const rRegen = args.newDate !== booking.date || args.newStartHour !== booking.startHour || newLaneId !== booking.laneId;
    const rAccessCode = rRegen
      ? generateServerAccessCode(await collectActiveAccessCodes(ctx), await getReservedCodes(ctx))
      : booking.accessCode;
    const rCalAthleteSlots = (adjustedAthleteSlots ?? []).map((s: any) => ({
      athleteName: s.athleteName, startHour: s.startHour, durationMinutes: s.durationMinutes,
    }));

    // Apply the reschedule
    await ctx.db.patch(args.id, {
      date: args.newDate,
      startHour: args.newStartHour,
      duration: args.newDuration,
      laneId: newLaneId,
      variantId: args.newVariantId ?? booking.variantId,
      additionalLaneIds: args.newAdditionalLaneIds ?? booking.additionalLaneIds,
      coachPrice: newCoachPrice,
      athleteSlots: adjustedAthleteSlots,
      accessCode: rAccessCode,
      // Keep the existing event ids for an in-place update; clear them on a move.
      ...(rLaneSetChanged ? { googleCalendarEventId: undefined, googleCalendarEventIds: undefined } : {}),
      lockSyncStatus: rRegen ? "pending" : booking.lockSyncStatus,
    });

    if (!rLaneSetChanged && rHadEvents) {
      // Same lane(s) — update the event(s) in place with the new time/details.
      await ctx.scheduler.runAfter(0, internal.googleCalendar.updateCalendarEvent, {
        googleCalendarEventId: rOldCalEventId ?? "",
        laneId: newLaneId,
        variantId: args.newVariantId ?? booking.variantId,
        date: args.newDate,
        startHour: args.newStartHour,
        duration: args.newDuration,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone,
        status: booking.status,
        isCoachBooking: booking.isCoachBooking,
        accessCode: rAccessCode,
        additionalLaneIds: args.newAdditionalLaneIds ?? booking.additionalLaneIds,
        athleteSlots: rCalAthleteSlots,
        laneCalendarEventIds: rOldCalEventIds,
      });
    } else {
      // Lane move (or no prior events): delete old, create fresh on the new lane(s).
      if (rHadEvents) {
        await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
          googleCalendarEventId: rOldCalEventId ?? "",
          laneCalendarEventIds: rOldCalEventIds,
        });
      }
      await ctx.scheduler.runAfter(500, internal.googleCalendar.createCalendarEvent, {
        bookingId: args.id.toString(),
        laneId: newLaneId,
        variantId: args.newVariantId ?? booking.variantId,
        date: args.newDate,
        startHour: args.newStartHour,
        duration: args.newDuration,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone,
        status: booking.status,
        isCoachBooking: booking.isCoachBooking,
        accessCode: rAccessCode,
        additionalLaneIds: args.newAdditionalLaneIds ?? booking.additionalLaneIds,
        athleteSlots: rCalAthleteSlots,
      });
    }

    // Send reschedule confirmation email
    if (booking.customerEmail) {
      const LANE_NAMES: Record<string, string> = { bm1: "Bowling Machine 1", bm2: "Bowling Machine 2", bm3: "Bowling Machine 3", ru1: "9m Run Up 1", ru2: "9m Run Up 2" };
      const fmtTime = (h: number) => {
        const w = Math.floor(h);
        const m = Math.round((h - w) * 60);
        const p = w >= 12 ? "PM" : "AM";
        const dh = w > 12 ? w - 12 : w === 0 ? 12 : w;
        return `${dh}:${m.toString().padStart(2, "0")} ${p}`;
      };
      const fmtDur = (d: number) => d === 60 ? "1 hour" : d === 90 ? "1.5 hours" : d === 30 ? "30 minutes" : `${d} min`;

      await ctx.scheduler.runAfter(0, internal.emails.sendBookingRescheduled, {
        to: booking.customerEmail,
        customerName: booking.customerName || "Valued Customer",
        oldLaneName: LANE_NAMES[booking.laneId] ?? booking.laneId,
        oldDate: booking.date,
        oldTimeSlot: fmtTime(booking.startHour),
        newLaneName: LANE_NAMES[newLaneId] ?? newLaneId,
        newDate: args.newDate,
        newTimeSlot: fmtTime(args.newStartHour),
        newDuration: fmtDur(args.newDuration),
        accessCode: rAccessCode ?? "",
      });
    }

    // decision #3b + Bug #7: notify allocated athletes. Kept athletes get a
    // reschedule email (new time + door code); dropped athletes get a removed
    // email. Mandatory; grouped per account.
    if (booking.isCoachBooking) {
      if (keptSlots.length > 0) {
        await scheduleAthleteRescheduleEmails(ctx, {
          slots: keptSlots,
          laneId: newLaneId,
          oldDate: booking.date,
          newDate: args.newDate,
          bookingAccessCode: rAccessCode,
          coachName: booking.customerName,
        });
      }
      if (droppedSlots.length > 0) {
        await scheduleAthleteRemovedEmails(ctx, {
          slots: droppedSlots,
          laneId: booking.laneId,
          date: booking.date,
          coachName: booking.customerName,
        });
      }
      if (keptSlots.length > 0 || droppedSlots.length > 0) {
        await writeAllocationAudit(ctx, {
          bookingId: args.id.toString(),
          actorUserId: args.userId,
          actorName: booking.customerName,
          action: "reschedule",
          before: prevAthleteSlots,
          after: keptSlots,
        });
      }
    }

    // Reset reminder flag so the new time gets a fresh reminder
    await ctx.db.patch(args.id, { reminderSent: false });

    // Return dropped athlete names so the client can warn the coach (Bug #7 —
    // never a silent drop).
    return { id: args.id, droppedAthletes: droppedSlots.map((s: any) => s.athleteName) };
  },
});

// ============================================================================
// UNIFIED MODIFY BOOKING (SPEC_MODIFY_BOOKING_UPGRADE)
// ============================================================================
// One backend path for every customer change type (lane / variant / date / time
// / duration). Replaces the split EditBookingModal (duration + top-up) and the
// customer reschedule (which waved price increases through "at the facility").
//   • Customer price INCREASE → Stripe top-up (account credit applied first; the
//     change is held in pendingEdit + a slot hold until payment confirms).
//   • Customer price DECREASE → applied now + the difference added as account credit.
//   • Coach → coachPrice recalculated, applied now, no online payment.
//   • Time-lock = the cancellation cutoff, with a safe-change carve-out inside it
//     (lane/variant swap at same cost; move earlier ≤ N hours; extend-with-top-up).
// Everything is re-validated here — the client is never trusted.
export const modifyBooking = mutation({
  args: {
    id: v.id("bookings"),
    newDate: v.optional(v.string()),
    newStartHour: v.optional(v.number()),
    newDuration: v.optional(v.number()),
    newLaneId: v.optional(v.string()),
    newVariantId: v.optional(v.string()),
    newAdditionalLaneIds: v.optional(v.array(v.string())),
    newAccessCode: v.optional(v.string()), // client-generated; used when the code must regenerate
    userId: v.string(),
  },
  // Explicit return type — breaks the circular inference through internal.*.
  handler: async (
    ctx,
    args
  ): Promise<{
    success: boolean;
    requiresPayment: boolean;
    topUpAmountCents?: number;
    creditAppliedCents?: number;
    credited?: boolean;
    creditIssuedCents?: number;
    priceDifferenceCents?: number;
    droppedAthletes?: string[];
  }> => {
    const booking = await ctx.db.get(args.id);
    if (!booking) throw new ConvexError("Booking not found.");
    if (booking.status === "cancelled") throw new ConvexError("Cannot modify a cancelled booking.");
    if (booking.status === "tentative") throw new ConvexError("Confirm the tentative booking first, then modify it.");
    if ((booking as any).status === "pending_edit_payment") {
      throw new ConvexError("A payment for a previous change is still pending. Complete or cancel it first.");
    }

    // ── Auth (H3 SECURITY: authorize on the AUTHENTICATED identity only; the
    // client `args.userId` is NOT trusted — was an IDOR: pass a victim's email) ──
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required.");
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const isOwner =
      (identity.subject != null && booking.userId === identity.subject) ||
      (callerEmail !== "" && booking.customerEmail.toLowerCase() === callerEmail);
    const callerCustomer = callerEmail
      ? await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", callerEmail)).first()
      : null;
    const isAdmin = callerCustomer?.role === "admin";
    if (!isOwner && !isAdmin) {
      throw new ConvexError("You can only modify your own bookings.");
    }

    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();

    // ── Resolve the effective new field-set (omitted fields keep current) ──────
    const effDate = args.newDate ?? booking.date;
    const effStart = args.newStartHour ?? booking.startHour;
    const effDuration = args.newDuration ?? booking.duration;
    const effLane = args.newLaneId ?? booking.laneId;
    const effVariant = args.newVariantId !== undefined ? args.newVariantId : booking.variantId;
    const effAddl = args.newAdditionalLaneIds ?? booking.additionalLaneIds ?? [];

    // B-3: enforce the customer lane cap on modify too (createBooking enforces it
    // at creation, but the modify path let a customer exceed it by adding lanes).
    // Coaches are uncapped; admin is exempt.
    if (!booking.isCoachBooking && !isAdmin) {
      const maxLanes = (settings as any)?.customerMaxLanesPerBooking ?? 3;
      if (1 + effAddl.length > maxLanes) {
        throw new ConvexError(`You can book at most ${maxLanes} lane${maxLanes === 1 ? "" : "s"} per booking.`);
      }
    }

    const dateChanged = effDate !== booking.date;
    const startChanged = effStart !== booking.startHour;
    const durationChanged = effDuration !== booking.duration;
    const primaryLaneChanged = effLane !== booking.laneId;
    const sortKey = (a: string[]) => [...a].sort().join(",");
    const addlChanged = sortKey(effAddl) !== sortKey(booking.additionalLaneIds ?? []);
    const variantChanged = (effVariant ?? null) !== (booking.variantId ?? null);
    const anyChange =
      dateChanged || startChanged || durationChanged || primaryLaneChanged || addlChanged || variantChanged;
    if (!anyChange) {
      return { success: true, requiresPayment: false, droppedAthletes: [] };
    }
    // Door code regenerates only when the slot identity (day/time/primary lane) moves.
    const regenCode = dateChanged || startChanged || primaryLaneChanged;

    const isCoach = !!booking.isCoachBooking;

    // ── Validate the new slot (operating hours, closure, conflicts, lead, horizon)
    const DOW_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const [yy, mm, dd] = effDate.split("-").map(Number);
    const dowName = DOW_NAMES[new Date(yy, mm - 1, dd).getDay()];
    const dayHours = settings?.dailyHours?.find((h: any) => h.day === dowName);
    const OPENING_HOUR = dayHours ? dayHours.open : (settings?.openingHour ?? 7);
    const CLOSING_HOUR = dayHours ? dayHours.close : (settings?.closingHour ?? 21);
    if (dayHours?.closed) throw new ConvexError("The facility is closed on that day.");

    const minDuration = isCoach ? 30 : 60;
    if (effDuration < minDuration) {
      throw new ConvexError(`Minimum booking duration is ${minDuration} minutes.`);
    }
    const newEndHour = effStart + effDuration / 60;
    if (effStart < OPENING_HOUR) throw new ConvexError(`Bookings cannot start before ${OPENING_HOUR}:00.`);
    if (newEndHour > CLOSING_HOUR) throw new ConvexError("That change extends past closing time.");

    const closure = await ctx.db
      .query("closures")
      .withIndex("by_date", (q: any) => q.eq("date", effDate))
      .first();
    if (closure) {
      throw new ConvexError(`The facility is closed on that date${closure.reason ? `: ${closure.reason}` : "."}`);
    }

    // Conflict check on every lane (excluding this booking).
    const allNewLaneIds = [effLane, ...effAddl];
    for (const lid of allNewLaneIds) {
      const laneBookings = await ctx.db
        .query("bookings")
        .withIndex("by_laneId_date", (q: any) => q.eq("laneId", lid).eq("date", effDate))
        .collect();
      const conflict = laneBookings.some((b: any) => {
        if (b._id === args.id || b.status === "cancelled") return false;
        const bEnd = b.startHour + b.duration / 60;
        return effStart < bEnd && newEndHour > b.startHour;
      });
      if (conflict) throw new ConvexError("That time slot is not available. Please choose another.");

      const laneBlocks = await ctx.db
        .query("laneBlocks")
        .withIndex("by_laneId_date", (q: any) => q.eq("laneId", lid).eq("date", effDate))
        .collect();
      const blocked = laneBlocks.some((b: any) => {
        const bEnd = b.startHour + b.duration / 60;
        return effStart < bEnd && newEndHour > b.startHour;
      });
      if (blocked) throw new ConvexError("That lane is blocked for service/repair during this time.");
    }

    const awstNow = getAWSTNow();

    // Active-hold conflict (in-flight checkout / waitlist offer) — exclude self.
    if (
      await hasActiveHoldConflict(ctx, {
        laneIds: allNewLaneIds,
        date: effDate,
        startHour: effStart,
        endHour: newEndHour,
        excludeBookingId: args.id.toString(),
      })
    ) {
      throw new ConvexError("That time slot is not available. Please choose another.");
    }

    if (!isAdmin) {
      const leadError = checkLeadTime(
        effDate,
        effStart,
        settings?.minBookingNoticeMinutes ?? 10,
        awstNow
      );
      if (leadError) throw new ConvexError(leadError);

      const role: WindowRole = isCoach ? "coach" : "customer";
      const tier: WindowTier =
        callerCustomer?.coachTier === "L2" || callerCustomer?.coachTier === "BowlingL2" ? "L2" : "L1";
      const horizonError = checkBookingHorizon(role, tier, settings ?? {}, effDate, awstNow);
      if (horizonError) throw new ConvexError(horizonError);
    }

    // ── Time-lock matrix ────────────────────────────────────────────────────
    const [oY, oM, oD] = booking.date.split("-").map(Number);
    const oWhole = Math.floor(booking.startHour);
    const oMins = Math.round((booking.startHour - oWhole) * 60);
    const originalStart = new Date(oY, oM - 1, oD, oWhole, oMins, 0);
    const hoursUntilOriginal = (originalStart.getTime() - awstNow.getTime()) / (1000 * 60 * 60);

    if (!isAdmin && hoursUntilOriginal <= 0) {
      throw new ConvexError("This session has already started — it can no longer be modified.");
    }

    // ── Pricing (server-authoritative) ────────────────────────────────────────
    let newCoachPrice: number | undefined;
    let newPriceInCents: number | undefined;
    let priceDiffCents = 0;
    let oldGrossCents = 0;
    if (isCoach) {
      const per30 = settings?.coachPer30Min ?? PRICE_DEFAULTS.coachPer30Min;
      newCoachPrice = (effDuration / 30) * per30;
    } else {
      const laneCents = (variantId: string | null) =>
        computeCustomerPriceCents(settings, variantId, effDuration);
      newPriceInCents =
        laneCents(effVariant ?? null) + effAddl.reduce((sum: number) => sum + laneCents(null), 0);
      // Diff against the recomputed GROSS original (server-authoritative, SEC-6):
      // this charges/credits the true incremental lane cost and avoids inheriting
      // any original discount/credit into the difference.
      oldGrossCents =
        computeCustomerPriceCents(settings, booking.variantId ?? null, booking.duration) +
        (booking.additionalLaneIds ?? []).reduce(
          (sum: number) => sum + computeCustomerPriceCents(settings, null, booking.duration),
          0
        );
      priceDiffCents = newPriceInCents - oldGrossCents;
    }

    // ── Coach freeze (any modify) ─────────────────────────────────────────────
    if (isCoach && !isAdmin) {
      const freezeHours = settings?.coachRescheduleFreezeHours ?? 24;
      if (hoursUntilOriginal < freezeHours) {
        throw new ConvexError(`Coach bookings cannot be modified within ${freezeHours} hours of the session start.`);
      }
    }

    // ── Customer safe-change carve-out inside the cancellation window ──────────
    if (!isCoach && !isAdmin) {
      const cancelHours = (settings as any)?.customerCancellationHours ?? settings?.cancellationHoursBefore ?? 2;
      const insideWindow = hoursUntilOriginal < cancelHours;
      if (insideWindow) {
        const within = `within ${cancelHours} hour${cancelHours !== 1 ? "s" : ""} of the start time`;
        if (dateChanged) {
          throw new ConvexError(`You can't change the date ${within}.`);
        }
        const movedLater = effDate === booking.date && effStart > booking.startHour;
        if (movedLater) {
          throw new ConvexError(`You can't push the start later ${within}. You can move it earlier or extend it.`);
        }
        if (effStart < booking.startHour) {
          const maxEarlier = settings?.modifyMoveEarlierMaxHours ?? 1;
          const earlierBy = booking.startHour - effStart;
          if (earlierBy > maxEarlier + 1e-9) {
            throw new ConvexError(`You can move the start at most ${maxEarlier} hour${maxEarlier !== 1 ? "s" : ""} earlier ${within}.`);
          }
        }
        if (durationChanged && effDuration < booking.duration) {
          throw new ConvexError(`You can't shorten the session ${within}.`);
        }
        if (priceDiffCents < 0) {
          throw new ConvexError(`Changes that reduce the price (and add credit) must be made before the cutoff.`);
        }
        const isExtend = durationChanged && effDuration > booking.duration;
        if (priceDiffCents > 0 && !isExtend) {
          throw new ConvexError(`Only extending the session is allowed when it increases the price ${within}.`);
        }
        if (isExtend) {
          const extNoticeMin = settings?.extensionNoticeMinutes ?? 20;
          if (hoursUntilOriginal * 60 < extNoticeMin) {
            throw new ConvexError(`Extensions must be made at least ${extNoticeMin} minutes before the start.`);
          }
        }
      }
    }

    const actorName = booking.customerName;

    // ── Apply / charge ────────────────────────────────────────────────────────
    // Coach: recalculate coachPrice, apply now, no online payment.
    if (isCoach) {
      const { droppedAthletes } = await applyBookingChange(ctx, booking, {
        newDate: effDate, newStartHour: effStart, newDuration: effDuration,
        newLaneId: effLane, newVariantId: effVariant ?? undefined, newAdditionalLaneIds: effAddl,
        newAccessCode: args.newAccessCode, regenCode, newCoachPrice,
        actorUserId: args.userId, actorName,
      });
      return { success: true, requiresPayment: false, droppedAthletes };
    }

    // Customer: equal or decrease → apply now (+ credit the decrease).
    if (priceDiffCents <= 0) {
      const { droppedAthletes } = await applyBookingChange(ctx, booking, {
        newDate: effDate, newStartHour: effStart, newDuration: effDuration,
        newLaneId: effLane, newVariantId: effVariant ?? undefined, newAdditionalLaneIds: effAddl,
        newAccessCode: args.newAccessCode, regenCode, newPriceInCents,
        actorUserId: args.userId, actorName,
      });
      let credited = false;
      let creditIssuedCents = 0;
      if (priceDiffCents < 0 && booking.customerEmail) {
        // NI-3 (Inspector 2026-06-02): credit ONLY what was actually PAID, pro-rata
        // to the value removed — not the gross list-price difference. `priceInCents`
        // is the original stored post-discount price (card + any redeemed credit);
        // reading it here is safe because applyBookingChange patches the DB row, not
        // this in-memory `booking` object. A $0/comp/100%-off booking credits nothing.
        creditIssuedCents = decreaseCreditCents(
          booking.priceInCents ?? 0,
          oldGrossCents,
          newPriceInCents ?? 0
        );
        if (creditIssuedCents > 0) {
          await issueCredit(ctx, {
            email: booking.customerEmail,
            amount: creditIssuedCents / 100,
            reason: "modify_decrease",
            bookingId: args.id.toString(),
          });
          credited = true;
        }
      }
      return { success: true, requiresPayment: false, credited, creditIssuedCents, priceDifferenceCents: priceDiffCents, droppedAthletes };
    }

    // Customer increase → apply account credit first; Stripe covers the remainder.
    const customer = booking.customerEmail
      ? await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", booking.customerEmail.toLowerCase())).first()
      : null;
    const creditAvailCents = Math.round((customer?.creditBalance ?? 0) * 100);
    const creditUseCents = Math.min(creditAvailCents, priceDiffCents);
    const amountDueCents = priceDiffCents - creditUseCents;

    if (amountDueCents === 0) {
      // Credit fully covers the increase → apply now, redeem the credit.
      const { droppedAthletes } = await applyBookingChange(ctx, booking, {
        newDate: effDate, newStartHour: effStart, newDuration: effDuration,
        newLaneId: effLane, newVariantId: effVariant ?? undefined, newAdditionalLaneIds: effAddl,
        newAccessCode: args.newAccessCode, regenCode, newPriceInCents,
        actorUserId: args.userId, actorName,
      });
      if (creditUseCents > 0 && booking.customerEmail) {
        await redeemCredit(ctx, { email: booking.customerEmail, amount: creditUseCents / 100, bookingId: args.id.toString() });
      }
      return { success: true, requiresPayment: false, creditAppliedCents: creditUseCents, priceDifferenceCents: priceDiffCents, droppedAthletes };
    }

    // amountDue > 0 → stash the full change in pendingEdit + hold the new slot.
    // confirmBookingPayment applies it (via applyBookingChange) once the top-up
    // is paid; abandonment reverts the booking to confirmed (releaseAbandonedBooking).
    await ctx.db.patch(args.id, {
      status: "pending_edit_payment",
      pendingEdit: {
        newDuration: effDuration,
        newAdditionalLaneIds: effAddl,
        newPriceInCents: newPriceInCents as number,
        priceDifference: amountDueCents,
        newDate: effDate,
        newStartHour: effStart,
        newLaneId: effLane,
        newVariantId: effVariant ?? undefined,
        newAccessCode: regenCode ? args.newAccessCode : undefined,
        creditApplied: creditUseCents / 100,
        actorUserId: args.userId,
      },
    });
    // Hold the new slot for the Stripe checkout window (~30 min, matching the
    // session's expires_at) so it can't be taken before payment confirms.
    await createCheckoutHold(ctx, {
      bookingId: args.id.toString(),
      laneId: effLane,
      additionalLaneIds: effAddl,
      date: effDate,
      startHour: effStart,
      duration: effDuration,
      userId: args.userId,
      userEmail: booking.customerEmail,
      expiresAtMs: Date.now() + 30 * 60 * 1000,
    });

    return {
      success: true,
      requiresPayment: true,
      topUpAmountCents: amountDueCents,
      creditAppliedCents: creditUseCents,
      priceDifferenceCents: priceDiffCents,
    };
  },
});

// ============================================================================
// COACH ATHLETE ALLOCATION MUTATIONS
// ============================================================================

// Generate a unique 6-digit access code (server-side)
// C3 (SECURITY): the front-door PIN is generated SERVER-SIDE only — never trust a
// client-supplied code (a customer could otherwise set a known staff code or one
// colliding with another active booking). CSPRNG (crypto.getRandomValues, not the
// guessable Math.random), 4-digit, excludes reserved staff codes, and is unique
// among currently-active bookings (seed via collectActiveAccessCodes).
const DEFAULT_RESERVED_CODES = ["1234", "3457", "2692", "1652"];

function generateServerAccessCode(existingCodes: Set<string>, reserved?: Set<string>): string {
  const blocked = reserved ?? new Set(DEFAULT_RESERVED_CODES);
  let code = "";
  let attempts = 0;
  do {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    const num = 1000 + (arr[0] % 9000); // 4-digit codes (1000-9999)
    code = num.toString();
    attempts++;
    if (attempts > 250) {
      throw new ConvexError("Could not allocate a unique door code. Please try again.");
    }
  } while (existingCodes.has(code) || blocked.has(code));
  existingCodes.add(code);
  return code;
}

// Seed the in-use set from every upcoming (non-cancelled) booking + athlete-slot
// code, so a freshly minted code can't collide with a live one. AWST today (UTC+8).
async function collectActiveAccessCodes(ctx: any): Promise<Set<string>> {
  const todayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const all = await ctx.db.query("bookings").collect();
  const set = new Set<string>();
  for (const b of all) {
    if (b.status === "cancelled" || b.date < todayKey) continue;
    if (b.accessCode) set.add(b.accessCode);
    for (const s of b.athleteSlots ?? []) {
      if (s.accessCode) set.add(s.accessCode);
    }
  }
  return set;
}

// Reserved door codes (staff/permanent) the server must never mint. Admin-editable
// via siteSettings.reservedAccessCodes; falls back to the built-in defaults.
async function getReservedCodes(ctx: any): Promise<Set<string>> {
  const s = await ctx.db
    .query("siteSettings")
    .withIndex("by_key", (q: any) => q.eq("key", "global"))
    .first();
  return new Set<string>((s as any)?.reservedAccessCodes ?? DEFAULT_RESERVED_CODES);
}

// Update athlete slots on an existing booking (coach only)
export const updateBookingAthleteSlots = mutation({
  args: {
    id: v.id("bookings"),
    athleteSlots: v.array(
      v.object({
        athleteId: v.optional(v.id("athletes")),
        athleteName: v.string(),
        startHour: v.number(),
        durationMinutes: v.number(),
        accessCode: v.optional(v.string()),
        codeGeneratedAt: v.optional(v.string()),
      })
    ),
    userId: v.string(),
    // Bug #3: set true to proceed past a same-athlete double-booking warning.
    confirmedOverride: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.id);
    if (!booking) throw new ConvexError("Booking not found.");
    if (!booking.isCoachBooking) throw new ConvexError("Only coach bookings can have athlete allocations.");
    if (booking.status === "cancelled") throw new ConvexError("Cannot edit a cancelled booking.");
    // Bug #5: authorize on identity, not name. Allow if: booking owner (by id or
    // email), OR the coach whose email matches the booking's, OR an admin. The
    // name comparison is dropped (two coaches sharing a name could collide).
    // M8 (SECURITY): authorize on the AUTHENTICATED identity, not the client
    // args.userId (the old `booking.userId !== args.userId` guard let a caller skip
    // every check by passing the owner's id).
    const aIdentity = await ctx.auth.getUserIdentity();
    if (!aIdentity) throw new ConvexError("Authentication required.");
    const aCallerEmail = aIdentity.email?.toLowerCase().trim() ?? "";
    let actorName: string | undefined = booking.customerName;
    const aIsOwner =
      (aIdentity.subject != null && booking.userId === aIdentity.subject) ||
      (aCallerEmail !== "" && booking.customerEmail.toLowerCase() === aCallerEmail);
    if (!aIsOwner) {
      const requester: any = aCallerEmail
        ? await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", aCallerEmail)).first()
        : null;
      actorName = requester?.name ?? actorName;
      const isAdmin = requester?.role === "admin";
      const isAssignedCoach =
        requester?.role === "coach" &&
        (requester?._id === booking.userId || requester?.email === booking.customerEmail);
      if (!isAdmin && !isAssignedCoach) {
        throw new ConvexError("You can only edit your own bookings.");
      }
    }

    // Validate athlete slots fit within booking window
    const athleteSettings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const minAthleteMins = athleteSettings?.minAthleteDurationMinutes ?? 15;
    const bookingEnd = booking.startHour + booking.duration / 60;
    for (const slot of args.athleteSlots) {
      const slotEnd = slot.startHour + slot.durationMinutes / 60;
      if (slot.startHour < booking.startHour || slotEnd > bookingEnd + 0.001) {
        throw new ConvexError(`Athlete "${slot.athleteName}" session falls outside the booking window.`);
      }
      if (slot.durationMinutes < minAthleteMins) {
        throw new ConvexError(`Minimum athlete session is ${minAthleteMins} minutes.`);
      }
    }

    // Bug #3: warn (don't block) if an athlete is allocated to ANOTHER active
    // coach session that overlaps in time on the same date. Lane sharing within
    // THIS booking is fine — the only conflict is the same athlete in two
    // different sessions at once. Coach confirms via confirmedOverride to proceed.
    if (!args.confirmedOverride) {
      const conflicts = await detectAthleteConflicts(ctx, {
        excludeBookingId: args.id,
        date: booking.date,
        slots: args.athleteSlots,
      });
      if (conflicts.length > 0) {
        // CONFLICT:: prefix lets the client recognise this as a soft warning and
        // re-submit with confirmedOverride after the coach clicks Proceed.
        throw new ConvexError("CONFLICT::" + conflicts.join(" "));
      }
    }

    // Build a map of previous athlete allocations for change detection.
    // Keyed by athleteId when present (robust to renames), else the name.
    const prevSlots = booking.athleteSlots ?? [];
    const prevKey = (s: any) => (s.athleteId as string) ?? s.athleteName;
    const prevMap = new Map<string, { startHour: number; durationMinutes: number; accessCode?: string }>();
    for (const ps of prevSlots) {
      prevMap.set(prevKey(ps), { startHour: ps.startHour, durationMinutes: ps.durationMinutes, accessCode: ps.accessCode });
    }

    // All athletes share the coach's booking access code
    const now = new Date().toISOString();
    const sharedCode = booking.accessCode;
    const finalSlots = args.athleteSlots.map((slot) => {
      const prev = prevMap.get(prevKey(slot));
      return {
        athleteId: slot.athleteId,
        athleteName: slot.athleteName,
        startHour: slot.startHour,
        durationMinutes: slot.durationMinutes,
        accessCode: sharedCode,
        codeGeneratedAt: prev?.accessCode === sharedCode ? (slot.codeGeneratedAt ?? now) : now,
      };
    });

    await ctx.db.patch(args.id, {
      athleteSlots: finalSlots,
    });

    // Send allocation emails to newly-added or changed athletes — resolved to
    // the parent account email + child name, grouped per account.
    const changedSlots = finalSlots.filter((slot) => {
      const prev = prevMap.get(prevKey(slot));
      return !prev || prev.startHour !== slot.startHour || prev.durationMinutes !== slot.durationMinutes;
    });
    if (changedSlots.length > 0) {
      await scheduleAllocationEmails(ctx, {
        slots: changedSlots,
        laneId: booking.laneId,
        date: booking.date,
        bookingAccessCode: booking.accessCode,
        coachName: booking.customerName,
      });
    }

    // decision #3a: notify athletes dropped from the booking during this edit
    // (present before, absent now). Mandatory removed-from-session email.
    const finalKeys = new Set(finalSlots.map((s) => prevKey(s)));
    const removedSlots = prevSlots.filter((ps) => !finalKeys.has(prevKey(ps)));
    if (removedSlots.length > 0) {
      await scheduleAthleteRemovedEmails(ctx, {
        slots: removedSlots,
        laneId: booking.laneId,
        date: booking.date,
        coachName: booking.customerName,
      });
    }

    // Part 2: record the allocation change.
    await writeAllocationAudit(ctx, {
      bookingId: args.id.toString(),
      actorUserId: args.userId,
      actorName,
      action: prevSlots.length === 0 ? "allocate" : removedSlots.length > 0 ? "remove" : "reallocate",
      before: prevSlots,
      after: finalSlots,
    });

    // Trigger Google Calendar update if calendar event exists
    if (booking.googleCalendarEventId) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.updateCalendarEvent, {
        googleCalendarEventId: booking.googleCalendarEventId,
        laneId: booking.laneId,
        variantId: booking.variantId,
        date: booking.date,
        startHour: booking.startHour,
        duration: booking.duration,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone,
        status: booking.status,
        isCoachBooking: booking.isCoachBooking,
        accessCode: booking.accessCode,
        additionalLaneIds: booking.additionalLaneIds,
        // Calendar validator accepts only these 3 fields — strip athleteId /
        // accessCode / codeGeneratedAt before scheduling.
        athleteSlots: finalSlots.map((s) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
        laneCalendarEventIds: booking.googleCalendarEventIds,
      });
    }

    return args.id;
  },
});

// ── Coach Weekly Planner: copy-from-last-week (Part 3) ──────────────────────
// Add/subtract whole days from a YYYY-MM-DD key (UTC-anchored — deterministic,
// no argless Date()/now).
function addDaysKey(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function diffDaysKey(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Rebook a coach's previous-week sessions (times + allocations) into the target
// week. Each source booking is recreated +delta days; any that can't be (slot
// taken, lane blocked, closure day, outside operating hours) is SKIPPED and
// reported — never silently dropped. Athletes no longer on the coach's roster
// are dropped from the copied allocation and flagged.
export const copyCoachWeek = mutation({
  args: {
    coachId: v.string(),
    fromWeekStart: v.string(), // YYYY-MM-DD
    toWeekStart: v.string(),   // YYYY-MM-DD
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required.");
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";

    // Resolve the coach record (by email or _id).
    let coach: any = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", args.coachId.toLowerCase().trim()))
      .first();
    if (!coach) coach = await ctx.db.get(args.coachId as any).catch(() => null);
    if (!coach || coach.role !== "coach") throw new ConvexError("Coach not found.");

    const callerCustomer = callerEmail
      ? await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", callerEmail)).first()
      : null;
    const isAdmin = callerCustomer?.role === "admin";
    if (!isAdmin && coach.email.toLowerCase() !== callerEmail) {
      throw new ConvexError("You can only copy your own week.");
    }

    const delta = diffDaysKey(args.fromWeekStart, args.toWeekStart);
    if (delta === 0) throw new ConvexError("Source and target weeks are the same.");
    const fromWeekEnd = addDaysKey(args.fromWeekStart, 6);

    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const coachPer30 = (settings as any)?.coachPer30Min ?? PRICE_DEFAULTS.coachPer30Min;
    const dailyHours: any = (settings as any)?.dailyHours;

    // Source = the coach's own non-cancelled coach bookings in the source week.
    const sourceBookings = (
      await ctx.db
        .query("bookings")
        .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", coach.email))
        .collect()
    ).filter(
      (b: any) =>
        b.isCoachBooking &&
        b.status !== "cancelled" &&
        b.date >= args.fromWeekStart &&
        b.date <= fromWeekEnd
    );

    const created: Array<{ date: string; startHour: number; laneId: string }> = [];
    const skipped: Array<{ date: string; startHour: number; laneId: string; reason: string }> = [];
    const existingCodes = new Set<string>();

    const coachIdForms = new Set<string>([coach._id as string, coach.email]);

    for (const src of sourceBookings) {
      const targetDate = addDaysKey(src.date, delta);
      const lanes: string[] = [src.laneId, ...(src.additionalLaneIds ?? [])];
      const endHour = src.startHour + src.duration / 60;

      // Closure day?
      const closure = await ctx.db
        .query("closures")
        .withIndex("by_date", (q: any) => q.eq("date", targetDate))
        .first();
      if (closure) {
        skipped.push({ date: targetDate, startHour: src.startHour, laneId: src.laneId, reason: "facility closed that day" });
        continue;
      }

      // Operating hours for that weekday (if configured).
      if (dailyHours) {
        const [ty, tm, td] = targetDate.split("-").map(Number);
        const dow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay();
        const dh = dailyHours[DAY_KEYS[dow]];
        if (dh && (dh.closed || src.startHour < dh.open || endHour > dh.close)) {
          skipped.push({ date: targetDate, startHour: src.startHour, laneId: src.laneId, reason: "outside operating hours" });
          continue;
        }
      }

      // Lane availability (booking overlap + service blocks) + idempotency.
      let blocked = false;
      let duplicate = false;
      for (const lid of lanes) {
        const laneBookings = await ctx.db
          .query("bookings")
          .withIndex("by_laneId_date", (q: any) => q.eq("laneId", lid).eq("date", targetDate))
          .collect();
        for (const b of laneBookings) {
          if (b.status === "cancelled") continue;
          const bEnd = b.startHour + b.duration / 60;
          const overlaps = src.startHour < bEnd && endHour > b.startHour;
          if (!overlaps) continue;
          // An identical own coach booking already there → already copied.
          if (b.isCoachBooking && b.customerEmail === coach.email && b.startHour === src.startHour && b.laneId === src.laneId) {
            duplicate = true;
          } else {
            blocked = true;
          }
        }
        const laneBlocks = await ctx.db
          .query("laneBlocks")
          .withIndex("by_laneId_date", (q: any) => q.eq("laneId", lid).eq("date", targetDate))
          .collect();
        if (laneBlocks.some((b: any) => src.startHour < b.startHour + b.duration / 60 && endHour > b.startHour)) {
          blocked = true;
        }
      }
      if (duplicate) {
        skipped.push({ date: targetDate, startHour: src.startHour, laneId: src.laneId, reason: "already copied" });
        continue;
      }
      if (blocked) {
        skipped.push({ date: targetDate, startHour: src.startHour, laneId: src.laneId, reason: "slot already booked or blocked" });
        continue;
      }

      // Copy allocations — drop athletes no longer on the coach's roster.
      const newCode = generateServerAccessCode(existingCodes);
      const nowIso = new Date().toISOString();
      let droppedRosterCount = 0;
      const copiedSlots: any[] = [];
      for (const s of src.athleteSlots ?? []) {
        if (s.athleteId) {
          const athlete: any = await ctx.db.get(s.athleteId as any);
          const stillAssigned =
            athlete &&
            (athlete.assignedCoachIds ?? []).some((c: string) => coachIdForms.has(c));
          if (!stillAssigned) {
            droppedRosterCount++;
            continue;
          }
        }
        copiedSlots.push({
          athleteId: s.athleteId,
          athleteName: s.athleteName,
          startHour: s.startHour + 0, // already relative to start time which is unchanged
          durationMinutes: s.durationMinutes,
          accessCode: newCode,
          codeGeneratedAt: nowIso,
        });
      }

      const newCoachPrice = (src.duration / 30) * coachPer30;
      const newId = await ctx.db.insert("bookings", {
        laneId: src.laneId,
        variantId: src.variantId,
        date: targetDate,
        startHour: src.startHour,
        duration: src.duration,
        customerName: coach.name,
        customerEmail: coach.email,
        customerPhone: coach.phone,
        userId: src.userId,
        status: "confirmed",
        isCoachBooking: true,
        coachPrice: newCoachPrice,
        additionalLaneIds: src.additionalLaneIds,
        athleteSlots: copiedSlots.length > 0 ? copiedSlots : undefined,
        accessCode: newCode,
      } as any);

      if (copiedSlots.length > 0) {
        await scheduleAllocationEmails(ctx, {
          slots: copiedSlots,
          laneId: src.laneId,
          date: targetDate,
          bookingAccessCode: newCode,
          coachName: coach.name,
        });
        await writeAllocationAudit(ctx, {
          bookingId: newId.toString(),
          actorUserId: callerCustomer?._id ?? coach._id,
          actorName: coach.name,
          action: "allocate",
          before: [],
          after: copiedSlots,
        });
      }

      await ctx.scheduler.runAfter(0, internal.googleCalendar.createCalendarEvent, {
        bookingId: newId.toString(),
        laneId: src.laneId,
        variantId: src.variantId,
        date: targetDate,
        startHour: src.startHour,
        duration: src.duration,
        customerName: coach.name,
        customerEmail: coach.email,
        customerPhone: coach.phone,
        status: "confirmed",
        isCoachBooking: true,
        accessCode: newCode,
        additionalLaneIds: src.additionalLaneIds,
        athleteSlots: copiedSlots.map((s) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
      });

      created.push({ date: targetDate, startHour: src.startHour, laneId: src.laneId });
      if (droppedRosterCount > 0) {
        skipped.push({
          date: targetDate,
          startHour: src.startHour,
          laneId: src.laneId,
          reason: `${droppedRosterCount} athlete(s) skipped — no longer on your roster`,
        });
      }
    }

    return { created, skipped, sourceCount: sourceBookings.length };
  },
});

// ============================================================================
// CUSTOMER MUTATIONS
// ============================================================================

// Create or update a customer (upsert by email).
// Admins may upsert any record. Authenticated users may only upsert their own
// record with role "customer" (safety-net for auto-create after signup).
export const upsertCustomer = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    role: v.optional(v.string()),
    creditBalance: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Require authentication for all callers
    const authUser = await getAuthUserSafe(ctx);
    if (!authUser) throw new ConvexError("Not authorized");

    const callerEmail = ((authUser as any).email ?? "").toLowerCase().trim();
    const normalizedEmail = args.email.toLowerCase().trim();

    // Determine if caller is admin (Better Auth role or customers table role)
    let isAdmin = (authUser as any).role === "admin";
    if (!isAdmin && callerEmail) {
      const callerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
        .first();
      if (callerCustomer && callerCustomer.role === "admin") isAdmin = true;
    }

    // Non-admins may only upsert their own record and cannot elevate role
    if (!isAdmin) {
      if (callerEmail !== normalizedEmail) throw new ConvexError("Not authorized");
      if (args.role && args.role !== "customer") throw new ConvexError("Not authorized");
    }
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        phone: args.phone,
        ...(args.role ? { role: args.role } : {}),
      });
      return existing._id;
    } else {
      const id = await ctx.db.insert("customers", {
        name: args.name.trim(),
        email: normalizedEmail,
        phone: args.phone?.trim() || undefined,
        role: args.role || "customer",
        // M1 (SECURITY): a non-admin can't seed their own credit on insert.
        creditBalance: isAdmin ? (args.creditBalance ?? 0) : 0,
        createdAt: new Date().toISOString(),
      });
      return id;
    }
  },
});

// Update customer profile — ADMIN ONLY
export const updateCustomer = mutation({
  args: {
    id: v.id("customers"),
    name: v.optional(v.string()),
    phone: v.optional(v.string()),
    role: v.optional(v.string()),
    assignedCoachIds: v.optional(v.array(v.string())),
    creditBalance: v.optional(v.number()),
    color: v.optional(v.string()),
    coachTier: v.optional(v.string()),
    postcode: v.optional(v.string()),
    suburb: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Allow self-update of own color without admin requirement — but M9 (SECURITY):
    // the color path still requires authentication AND that the caller owns the row
    // (or is admin); previously it was an unauthenticated arbitrary-row write.
    const onlyColorUpdate = Object.keys(args).every((k) => k === "id" || k === "color" || args[k as keyof typeof args] === undefined);
    if (onlyColorUpdate) {
      const colorAuthUser = await getAuthUserSafe(ctx);
      if (!colorAuthUser) throw new ConvexError("Not authorized");
      const colorTarget: any = await ctx.db.get(args.id);
      const colorCallerEmail = ((colorAuthUser as any).email ?? "").toLowerCase().trim();
      const colorIsAdmin = (colorAuthUser as any).role === "admin";
      if (!colorIsAdmin && (colorTarget?.email ?? "").toLowerCase() !== colorCallerEmail) {
        throw new ConvexError("Not authorized");
      }
    } else {
      await requireAdmin(ctx);
    }
    // SPEC_PROFILE_POSTCODE_SUBURB: validate if either location field is supplied.
    validateLocationIfProvided(args.postcode, args.suburb);
    const { id, ...updates } = args;
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );
    await ctx.db.patch(id, cleanUpdates);
    return id;
  },
});

// Update customer by email — self-update or admin only
export const updateCustomerByEmail = mutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phone: v.optional(v.string()),
    role: v.optional(v.string()),
    coachTier: v.optional(v.string()),
    assignedCoachIds: v.optional(v.array(v.string())),
    creditBalance: v.optional(v.number()),
    color: v.optional(v.string()),
    defaultSessionDuration: v.optional(v.number()),
    athleteCapacity: v.optional(v.number()),
    bookingEmailsEnabled: v.optional(v.boolean()),
    emailPrefs: v.optional(v.array(v.object({ slug: v.string(), enabled: v.boolean() }))),
    postcode: v.optional(v.string()),
    suburb: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // SEC-3: Must be authenticated; can update own profile or be admin
    const updByEmailIdentity = await ctx.auth.getUserIdentity();
    if (!updByEmailIdentity) throw new ConvexError("Authentication required.");
    // SPEC_PROFILE_POSTCODE_SUBURB: postcode/suburb are self-editable profile fields
    // (NOT stripped under the non-admin guard below). Validate when supplied.
    validateLocationIfProvided(args.postcode, args.suburb);
    const updCallerEmail = updByEmailIdentity.email?.toLowerCase().trim() ?? "";
    const normalizedEmail = args.email.toLowerCase().trim();
    let updIsAdminCaller = false;
    if (updCallerEmail !== normalizedEmail) {
      const updCallerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", updCallerEmail))
        .first();
      if (updCallerCustomer?.role !== "admin") {
        throw new ConvexError("You can only update your own profile.");
      }
      updIsAdminCaller = true;
    } else {
      // Self-update: resolve whether the caller is ALSO an admin (admins editing
      // their own record may still set privileged fields).
      const selfCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", updCallerEmail))
        .first();
      updIsAdminCaller = selfCustomer?.role === "admin";
    }
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();

    if (existing) {
      const { email, ...updates } = args;
      // SPEC_NAME_SPLIT: first/last are the source fields — recompose the derived
      // `name` whenever either is supplied (so all legacy reads stay correct).
      if (args.firstName !== undefined || args.lastName !== undefined) {
        const newFirst = (args.firstName ?? (existing as any).firstName ?? "").trim();
        const newLast = (args.lastName ?? (existing as any).lastName ?? "").trim();
        const composed = composeName(newFirst, newLast);
        if (composed) (updates as any).name = composed;
      }
      // SEC: a non-admin may only edit profile fields on their OWN record. Strip
      // privilege/financial fields (role, coachTier, assignedCoachIds,
      // creditBalance, defaultSessionDuration, athleteCapacity) so a customer
      // can't self-promote to admin or grant themselves credit via this path.
      if (!updIsAdminCaller) {
        delete (updates as any).role;
        delete (updates as any).coachTier;
        delete (updates as any).assignedCoachIds;
        delete (updates as any).creditBalance;
        delete (updates as any).defaultSessionDuration;
        delete (updates as any).athleteCapacity;
      }
      const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([_, v]) => v !== undefined)
      );
      await ctx.db.patch(existing._id, cleanUpdates);
      return existing._id;
    } else {
      // SEC: only an admin may seed a privileged role / starting credit on a new
      // record. A non-admin self-creating their own record is always a customer
      // with zero credit.
      // SPEC_NAME_SPLIT: derive first/last (explicit, else split the name).
      const seedFirst = (args.firstName ?? "").trim();
      const seedLast = (args.lastName ?? "").trim();
      const split = (seedFirst || seedLast)
        ? { firstName: seedFirst, lastName: seedLast }
        : splitName(args.name);
      const displayName =
        composeName(split.firstName, split.lastName) ||
        args.name?.trim() ||
        normalizedEmail.split("@")[0];
      const seedPostcode = normalizePostcode(args.postcode);
      const seedSuburb = normalizeSuburb(args.suburb);
      const id = await ctx.db.insert("customers", {
        name: displayName,
        firstName: split.firstName,
        lastName: split.lastName,
        ...(seedPostcode && seedSuburb ? { postcode: seedPostcode, suburb: seedSuburb } : {}),
        email: normalizedEmail,
        phone: args.phone?.trim() || undefined,
        role: updIsAdminCaller ? (args.role || "customer") : "customer",
        assignedCoachIds: updIsAdminCaller ? (args.assignedCoachIds ?? []) : [],
        creditBalance: updIsAdminCaller ? (args.creditBalance ?? 0) : 0,
        createdAt: new Date().toISOString(),
      });
      return id;
    }
  },
});

// Delete a customer — ADMIN ONLY
export const deleteCustomer = mutation({
  args: { id: v.id("customers") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// ============================================================================
// COACH INVITE MUTATIONS — ADMIN ONLY
// ============================================================================

// Create a coach invite — ADMIN ONLY
export const createCoachInvite = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    email: v.string(),
    phone: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();

    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (existingCustomer) {
      throw new ConvexError("An account with this email already exists.");
    }

    const existingInvite = await ctx.db
      .query("coachInvites")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (existingInvite && !existingInvite.used) {
      throw new ConvexError("An unused invite already exists for this email.");
    }

    const id = await ctx.db.insert("coachInvites", {
      token: args.token,
      name: args.name.trim(),
      email: normalizedEmail,
      phone: args.phone.trim(),
      createdBy: args.createdBy,
      createdAt: new Date().toISOString(),
      used: false,
    });
    return id;
  },
});

// Manually create a customer account — ADMIN ONLY
export const createCustomer = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    // SPEC_PROFILE_POSTCODE_SUBURB decision #8: required for admin-created customers.
    postcode: v.optional(v.string()),
    suburb: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();
    if (!normalizedEmail || !args.name.trim()) {
      throw new ConvexError("Name and email are required.");
    }
    // Required + validated for admin-created customers (throws ConvexError if missing/invalid).
    assertValidLocation(args.postcode, args.suburb);
    const newPostcode = normalizePostcode(args.postcode);
    const newSuburb = normalizeSuburb(args.suburb);

    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();

    if (existing) {
      // Update existing record (e.g. if auto-created at signup with partial data)
      await ctx.db.patch(existing._id, {
        name: args.name.trim() || existing.name,
        ...(args.phone?.trim() ? { phone: args.phone.trim() } : {}),
        postcode: newPostcode,
        suburb: newSuburb,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("customers", {
      name: args.name.trim(),
      email: normalizedEmail,
      phone: args.phone?.trim(),
      postcode: newPostcode,
      suburb: newSuburb,
      role: "customer",
      creditBalance: 0,
      createdAt: new Date().toISOString(),
    });
    return id;
  },
});

// SPEC_PROFILE_POSTCODE_SUBURB Addendum A — one-time backfill: copy each customer's
// CURRENT postcode/suburb onto their past bookings that lack a snapshot, so the catchment
// report isn't empty on launch. Idempotent + re-runnable (only fills blanks). Skips coach
// bookings (excluded from the report). Run via deploy key:
//   npx convex run mutations:backfillBookingSuburbs
export const backfillBookingSuburbs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const bookings = await ctx.db.query("bookings").collect();
    // Cache customer lookups by email to avoid repeated index reads.
    const byEmail = new Map<string, any>();
    let patched = 0;
    let skippedNoCustomerLocation = 0;
    for (const b of bookings) {
      if ((b as any).isCoachBooking) continue;
      if ((b as any).bookingPostcode) continue; // already has a snapshot
      const email = ((b as any).customerEmail || "").toLowerCase().trim();
      if (!email) continue;
      let cust = byEmail.get(email);
      if (cust === undefined) {
        cust = await ctx.db
          .query("customers")
          .withIndex("by_email", (q: any) => q.eq("email", email))
          .first();
        byEmail.set(email, cust);
      }
      if (cust?.postcode && cust?.suburb) {
        await ctx.db.patch(b._id, { bookingPostcode: cust.postcode, bookingSuburb: cust.suburb });
        patched++;
      } else {
        skippedNoCustomerLocation++;
      }
    }
    return { totalBookings: bookings.length, patched, skippedNoCustomerLocation };
  },
});

// Manually create a coach (no invite flow) — ADMIN ONLY
export const createCoach = mutation({
  args: {
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.string(),
    phone: v.optional(v.string()),
    coachTier: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();
    const fullName = (args.name && args.name.trim())
      || [args.firstName?.trim(), args.lastName?.trim()].filter(Boolean).join(" ").trim();
    if (!normalizedEmail || !fullName) {
      throw new ConvexError("First name, last name, and email are required.");
    }

    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (existing) {
      if (existing.role === "coach") {
        throw new ConvexError("This user is already a coach.");
      }
      await ctx.db.patch(existing._id, {
        role: "coach",
        name: fullName || existing.name,
        phone: args.phone?.trim() || existing.phone,
        coachTier: args.coachTier || existing.coachTier,
        color: args.color || existing.color,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("customers", {
      name: fullName,
      email: normalizedEmail,
      phone: args.phone?.trim(),
      role: "coach",
      coachTier: args.coachTier,
      color: args.color,
      createdAt: new Date().toISOString(),
    });
    return id;
  },
});

// Delete a coach invite — ADMIN ONLY
export const deleteCoachInvite = mutation({
  args: { id: v.id("coachInvites") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return { success: true };
  },
});

// Mark a coach invite as used (user-facing — no admin gate)
export const useCoachInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("coachInvites")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first();
    if (!invite || invite.used) return null;

    await ctx.db.patch(invite._id, {
      used: true,
      usedAt: new Date().toISOString(),
    });
    return invite;
  },
});

// ============================================================================
// STRIPE PAYMENT MUTATIONS
// ============================================================================

// Create a new stripePayment (user-facing — triggered by checkout flow)
// R4 — INTERNAL ONLY. Records the authoritative payment row that analytics reads.
// Previously this was a PUBLIC mutation that trusted client status/amount → anyone
// could forge "paid" records. It is now internal and called solely by the
// signature-verified Stripe webhook (confirmBookingPayment), so the recorded
// amount/status come from Stripe, not the client. This also means real paid
// bookings finally populate stripePayments (the customer-revenue analytics source).
export const recordStripePaymentInternal = internalMutation({
  args: {
    bookingId: v.string(),
    stripeSessionId: v.string(),
    customerEmail: v.string(),
    customerName: v.string(),
    amount: v.number(),
    currency: v.string(),
    status: v.string(),
    laneName: v.string(),
    date: v.string(),
    description: v.string(),
    accessCode: v.optional(v.string()),
    timeSlot: v.optional(v.string()),
    duration: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Idempotency: don't double-record the same booking on webhook retry.
    const existing = await ctx.db
      .query("stripePayments")
      .filter((q: any) => q.eq(q.field("bookingId"), args.bookingId))
      .first();
    if (existing) return existing._id;

    const id = await ctx.db.insert("stripePayments", {
      bookingId: args.bookingId,
      stripeSessionId: args.stripeSessionId,
      customerEmail: args.customerEmail,
      customerName: args.customerName,
      amount: args.amount,
      currency: args.currency,
      status: args.status,
      laneName: args.laneName,
      date: args.date,
      description: args.description,
    });

    // Also ensure the customer exists in the customers table
    const normalizedEmail = args.customerEmail.toLowerCase().trim();
    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (!existingCustomer) {
      await ctx.db.insert("customers", {
        name: args.customerName || "Customer",
        email: normalizedEmail,
        role: "customer",
        creditBalance: 0,
        createdAt: new Date().toISOString(),
      });
    }

    // Note: confirmation email is sent by createBooking — do not duplicate here.

    return id;
  },
});

// Send booking confirmation email (callable from client for non-Stripe bookings)
export const sendBookingEmail = mutation({
  args: {
    customerEmail: v.string(),
    customerName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
    duration: v.string(),
    amount: v.string(),
    accessCode: v.string(),
  },
  handler: async (ctx, args) => {
    // SEC-4: Must be authenticated; can send to self or be admin
    const sendEmailIdentity = await ctx.auth.getUserIdentity();
    if (!sendEmailIdentity) throw new ConvexError("Authentication required.");
    const sendCallerEmail = sendEmailIdentity.email?.toLowerCase().trim() ?? "";
    if (sendCallerEmail !== args.customerEmail.toLowerCase().trim()) {
      const sendCallerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", sendCallerEmail))
        .first();
      if (sendCallerCustomer?.role !== "admin") {
        throw new ConvexError("You can only send booking emails for your own bookings.");
      }
    }
    await ctx.scheduler.runAfter(
      0,
      internal.emails.sendBookingConfirmation,
      {
        to: args.customerEmail,
        customerName: args.customerName,
        laneName: args.laneName,
        date: args.date,
        timeSlot: args.timeSlot,
        duration: args.duration,
        amount: args.amount,
        accessCode: args.accessCode,
      }
    );
    return { success: true };
  },
});

// Update a stripePayment — ADMIN ONLY
export const updateStripePayment = mutation({
  args: {
    id: v.id("stripePayments"),
    bookingId: v.optional(v.string()),
    stripeSessionId: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
    amount: v.optional(v.number()),
    currency: v.optional(v.string()),
    status: v.optional(v.string()),
    laneName: v.optional(v.string()),
    date: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { id, ...updates } = args;
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );
    await ctx.db.patch(args.id, cleanUpdates);
    return args.id;
  },
});

// Delete a stripePayment — ADMIN ONLY
export const deleteStripePayment = mutation({
  args: { id: v.id("stripePayments") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// ============================================================================
// WAITLIST MUTATIONS
// ============================================================================

// Add entries to waitlist (user-facing)
export const addToWaitlist = mutation({
  args: {
    entries: v.array(
      v.object({
        userId: v.string(),
        userName: v.string(),
        userEmail: v.string(),
        laneId: v.string(),
        date: v.string(),
        hour: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    // SEC: authentication REQUIRED, and the entry's identity fields are forced
    // from the caller's auth — a caller cannot inject waitlist entries under
    // another user's id/email (which would drive that user's offer emails).
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required.");
    const authedEmail = identity.email ?? null;
    const authedName = (identity as any)?.name ?? null;
    const callerUserId = identity.subject;

    const ids: string[] = [];
    const insertedEntries: typeof args.entries = [];
    for (const entry of args.entries) {
      const existing = await ctx.db
        .query("waitlist")
        .withIndex("by_slot", (q: any) =>
          q.eq("laneId", entry.laneId).eq("date", entry.date).eq("hour", entry.hour)
        )
        .collect();
      const isDuplicate = existing.some((e) => e.userId === callerUserId);
      if (isDuplicate) continue;

      const id = await ctx.db.insert("waitlist", {
        userId: callerUserId,
        userName: authedName ?? entry.userName,
        userEmail: authedEmail ?? entry.userEmail,
        laneId: entry.laneId,
        date: entry.date,
        hour: entry.hour,
        notified: false,
      });
      ids.push(id);
      insertedEntries.push(entry);
    }
    // Send waitlist confirmation email (replicates booking-confirmation pattern)
    if (ids.length > 0 && insertedEntries.length > 0) {
      const first = insertedEntries[0];
      await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistConfirmation, {
        to: authedEmail ?? first.userEmail,
        customerName: authedName ?? first.userName,
        slots: insertedEntries.map((e) => ({ date: e.date, hour: e.hour })),
      });
    }
    return ids;
  },
});

// Remove a waitlist entry (user-facing)
export const removeFromWaitlist = mutation({
  args: { id: v.id("waitlist") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required.");
    const entry = await ctx.db.get(args.id);
    if (!entry) throw new ConvexError("Waitlist entry not found.");
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const isOwner =
      entry.userId === identity.subject ||
      entry.userEmail.toLowerCase() === callerEmail;
    if (!isOwner) {
      const callerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
        .first();
      if (callerCustomer?.role !== "admin") {
        throw new ConvexError("You can only remove your own waitlist entries.");
      }
    }
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// Notify waitlisted users when a slot opens up — ADMIN ONLY
// SPEC_WAITLIST_OFFER_REDESIGN: retired the old notify-ALL blast (it emailed
// every waitlisted user at once AND deleted every entry before anyone booked —
// the core "race condition" bug). This is now an ADMIN MANUAL OVERRIDE that just
// kicks the sequential first-refusal engine for the given slot-hours; the engine
// makes one exclusive offer at a time and rolls on automatically. Signature kept
// (laneName unused) so any existing caller keeps working.
export const notifyWaitlistedUsers = mutation({
  args: {
    laneId: v.string(),
    laneName: v.string(),
    date: v.string(),
    hours: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    for (const hour of args.hours) {
      await ctx.scheduler.runAfter(0, internal.waitlist.advanceWaitlistOffer, {
        laneId: args.laneId,
        date: args.date,
        hour,
      });
    }
    return { triggered: args.hours.length };
  },
});

// Dismiss a waitlist notification (user-facing)
export const dismissWaitlistNotification = mutation({
  args: { id: v.id("waitlistNotifications") },
  handler: async (ctx, args) => {
    // SEC-5: Only the notification owner (or admin) can dismiss it
    const dismissIdentity = await ctx.auth.getUserIdentity();
    if (!dismissIdentity) throw new ConvexError("Authentication required.");
    const notification = await ctx.db.get(args.id);
    if (!notification) throw new ConvexError("Notification not found.");
    const isOwner =
      notification.userId === dismissIdentity.subject ||
      (notification as any).userEmail?.toLowerCase() === dismissIdentity.email?.toLowerCase();
    if (!isOwner) {
      const dismissCallerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", dismissIdentity.email?.toLowerCase() ?? ""))
        .first();
      if (dismissCallerCustomer?.role !== "admin") {
        throw new ConvexError("You can only dismiss your own notifications.");
      }
    }
    await ctx.db.patch(args.id, { dismissed: true });
    return args.id;
  },
});

// ============================================================================
// SITE SETTINGS MUTATIONS — ADMIN ONLY
// ============================================================================

// Update site settings — ADMIN ONLY
export const updateSiteSettings = mutation({
  args: {
    customerPricePerHour: v.optional(v.number()),
    customerPrice90Min: v.optional(v.number()),
    trumanPricePerHour: v.optional(v.number()),
    trumanPrice90Min: v.optional(v.number()),
    coachPer30Min: v.optional(v.number()),
    coachPerHour: v.optional(v.number()),
    cancellationHoursBefore: v.optional(v.number()),
    openingHour: v.optional(v.number()),
    closingHour: v.optional(v.number()),
    minBookingNoticeMinutes: v.optional(v.number()),
    coachBookingWindowDays: v.optional(v.number()),
    customerOpenDay: v.optional(v.string()),
    customerOpenHour: v.optional(v.number()),
    l1CoachOpenDay: v.optional(v.string()),
    l1CoachOpenHour: v.optional(v.number()),
    l2CoachOpenDay: v.optional(v.string()),
    l2CoachOpenHour: v.optional(v.number()),
    customerMaxLanesPerBooking: v.optional(v.number()),
    registrationLocked: v.optional(v.boolean()),
    coachRescheduleFreezeHours: v.optional(v.number()),
    extensionNoticeMinutes: v.optional(v.number()),
    customerMaxDurationMinutes: v.optional(v.number()),
    coachMaxDurationMinutes: v.optional(v.number()),
    minAthleteDurationMinutes: v.optional(v.number()),
    customerCancellationHours: v.optional(v.number()),
    coachLateCancellationHours: v.optional(v.number()),
    modifyMoveEarlierMaxHours: v.optional(v.number()),
    adminGateEnabled: v.optional(v.boolean()),
    adminUnlockMinutes: v.optional(v.number()),
    abandonedCheckoutMinutes: v.optional(v.number()),
    waitlistOfferHoldMinutes: v.optional(v.number()),
    maxMatesPerBooking: v.optional(v.number()),
    dailyHours: v.optional(
      v.array(
        v.object({
          day: v.string(),
          open: v.number(),
          close: v.number(),
          closed: v.boolean(),
        })
      )
    ),
  },
  handler: async (ctx, args) => {
    await requireAdminUnlocked(ctx);
    const existing = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();

    const defaults = {
      customerPricePerHour: 40,
      customerPrice90Min: 55,
      trumanPricePerHour: 50,
      trumanPrice90Min: 70,
      coachPer30Min: 15,
      coachPerHour: 25,
      cancellationHoursBefore: 2,
      openingHour: 7,
      closingHour: 21,
      minBookingNoticeMinutes: 10,
      coachBookingWindowDays: 7,
      customerOpenDay: "sunday",
      customerOpenHour: 19,
    };

    if (existing) {
      const cleanUpdates = Object.fromEntries(
        Object.entries(args).filter(([_, v]) => v !== undefined)
      );
      await ctx.db.patch(existing._id, cleanUpdates);
      return existing._id;
    } else {
      const merged = { ...defaults, ...Object.fromEntries(
        Object.entries(args).filter(([_, v]) => v !== undefined)
      ) };
      const id = await ctx.db.insert("siteSettings", {
        key: "global",
        ...merged,
      });
      return id;
    }
  },
});

// One-time migration (SPEC_BOOKING_WINDOW #2): collapse the legacy 4-value coach
// tier set to L1/L2 only. 'Bowling' → 'L1', 'BowlingL2' → 'L2'. Idempotent — run
// once post-deploy from the admin console; safe to re-run.
export const migrateCoachTiers = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const customers = await ctx.db.query("customers").collect();
    let migrated = 0;
    for (const c of customers) {
      const tier = (c as any).coachTier;
      if (tier === "Bowling") {
        await ctx.db.patch(c._id, { coachTier: "L1" });
        migrated++;
      } else if (tier === "BowlingL2") {
        await ctx.db.patch(c._id, { coachTier: "L2" });
        migrated++;
      }
    }
    return { migrated };
  },
});

// SPEC_NAME_SPLIT — one-off backfill. Splits each customers.name into
// firstName/lastName on the LAST space for any row that doesn't yet have a
// firstName. Idempotent (skips already-split rows). Best-effort on multi-word
// surnames — admins correct via the edit forms. Run once post-deploy via the
// deploy key: `npx convex run mutations:migrateNameSplit`. internalMutation so
// it is NOT publicly callable — the deploy-key CLI run is the only entry point.
export const migrateNameSplit = internalMutation({
  args: {},
  handler: async (ctx) => {
    const customers = await ctx.db.query("customers").collect();
    let migrated = 0;
    let multiWordSurnames = 0;
    for (const c of customers) {
      if (typeof (c as any).firstName === "string" && (c as any).firstName.trim()) {
        continue; // already split
      }
      const { firstName, lastName } = splitName((c as any).name);
      if (!firstName && !lastName) continue;
      await ctx.db.patch(c._id, { firstName, lastName });
      migrated++;
      if (lastName.includes(" ") || firstName.includes(" ")) multiWordSurnames++;
    }
    return { migrated, multiWordSurnames, total: customers.length };
  },
});

// ============================================================================
// PAYMENT MUTATIONS — ADMIN ONLY
// ============================================================================

export const createPayment = mutation({
  args: {
    coachId: v.string(),
    amount: v.number(),
    dateReceived: v.string(),
    note: v.optional(v.string()),
    method: v.optional(v.string()),
    description: v.optional(v.string()),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const id = await ctx.db.insert("payments", {
      coachId: args.coachId,
      amount: args.amount,
      dateReceived: args.dateReceived,
      note: args.note ?? args.description,
      method: args.method,
      description: args.description,
      createdAt: new Date().toISOString(),
      createdBy: args.createdBy,
    } as any);
    return id;
  },
});

export const deletePayment = mutation({
  args: { id: v.id("payments") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// SPEC_STATEMENTS_EDITING (B): edit a previously-recorded coach payment. Admin
// only. Only the fields passed are changed; note mirrors description when the
// caller updates description without a separate note (matches createPayment).
export const updatePayment = mutation({
  args: {
    id: v.id("payments"),
    amount: v.optional(v.number()),
    dateReceived: v.optional(v.string()),
    note: v.optional(v.string()),
    method: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("Payment not found");
    const patch: Record<string, any> = {};
    if (args.amount !== undefined) {
      if (args.amount <= 0) throw new ConvexError("Enter a valid amount");
      patch.amount = args.amount;
    }
    if (args.dateReceived !== undefined) patch.dateReceived = args.dateReceived;
    if (args.method !== undefined) patch.method = args.method;
    if (args.description !== undefined) {
      patch.description = args.description;
      // Keep note aligned to description unless the caller sets note explicitly.
      if (args.note === undefined) patch.note = args.description;
    }
    if (args.note !== undefined) patch.note = args.note;
    await ctx.db.patch(args.id, patch);
    return args.id;
  },
});

// ============================================================================
// CUSTOMER CREDIT MUTATIONS — ADMIN ONLY
// ============================================================================

export const addCustomerCredit = mutation({
  args: { email: v.string(), amount: v.number(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();
    let customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (!customer) {
      const newId = await ctx.db.insert("customers", {
        name: normalizedEmail.split("@")[0],
        email: normalizedEmail,
        role: "customer",
        creditBalance: 0,
        createdAt: new Date().toISOString(),
      });
      customer = await ctx.db.get(newId);
    }
    if (!customer) throw new ConvexError("Customer not found.");
    // Route through the credit helper so the movement is logged to creditLedger.
    await recordCreditMovement(ctx, {
      customer,
      delta: args.amount,
      reason: args.amount >= 0 ? "admin_grant" : "admin_adjust",
      note: args.note,
    });
    return customer._id;
  },
});

export const useCustomerCredit = mutation({
  args: { email: v.string(), amount: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required.");
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const targetEmail = args.email.toLowerCase().trim();
    if (callerEmail !== targetEmail) {
      const callerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
        .first();
      if (callerCustomer?.role !== "admin") {
        throw new ConvexError("You can only use your own credits.");
      }
    }
    // NOTE: credit redemption for bookings is now deducted server-side at
    // confirmation (createBooking / confirmBookingPayment) via redeemCredit —
    // this mutation remains for any direct/admin adjustment use and is logged.
    return await redeemCredit(ctx, { email: targetEmail, amount: args.amount });
  },
});

// ============================================================================
// ADMIN MANUAL POWERS (SPEC_ADMIN_MANUAL_POWERS)
// ============================================================================

// Resend the booking confirmation + door-code email for a booking — ADMIN ONLY.
// Coach bookings WITH athlete allocations resend the per-athlete allocation
// emails instead (those carry each athlete's parent + access code). Cancelled
// bookings are rejected (nothing valid to resend).
export const resendBookingConfirmation = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new ConvexError("Booking not found.");
    if (booking.status === "cancelled") {
      throw new ConvexError("This booking is cancelled — there is nothing to resend.");
    }
    if (booking.isCoachBooking && (booking.athleteSlots ?? []).length > 0) {
      await scheduleAllocationEmails(ctx, {
        slots: booking.athleteSlots!,
        laneId: booking.laneId,
        date: booking.date,
        bookingAccessCode: booking.accessCode,
        coachName: booking.customerName,
      });
      return { success: true, kind: "allocation" as const };
    }
    if (!booking.customerEmail) {
      throw new ConvexError("This booking has no customer email on file.");
    }
    await ctx.scheduler.runAfter(
      0,
      internal.emails.sendBookingConfirmation,
      buildConfirmationEmailArgs(booking as any),
    );
    return { success: true, kind: "confirmation" as const };
  },
});

// Record a refund / void against a booking charge — ADMIN ONLY. Real card
// refunds are processed in the Stripe dashboard directly; this RECORDS the
// outcome on Krickora (flags the booking + writes modificationHistory).
//   mode "stripe" → money was refunded to the card via Stripe (record-only;
//                   no account credit; `amount` optional, captured for the log).
//   mode "credit" → issue `amount` of account credit instead (reason "refund",
//                   logged to creditLedger). Use when keeping the money on file.
//   mode "waive"  → write the charge off; no money returned, no credit.
// Does NOT cancel the booking — pair with Cancel if the slot should be freed.
export const voidBookingCharge = mutation({
  args: {
    bookingId: v.id("bookings"),
    mode: v.union(v.literal("stripe"), v.literal("credit"), v.literal("waive")),
    amount: v.optional(v.number()), // dollars; required (>0) for "credit", optional record for "stripe"
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new ConvexError("Booking not found.");
    if (booking.refunded) {
      throw new ConvexError("This booking charge has already been marked refunded/voided.");
    }

    const amount = Math.round((args.amount ?? 0) * 100) / 100;
    let amountCredited = 0;
    if (args.mode === "credit") {
      if (amount <= 0) {
        throw new ConvexError("Enter a credit amount greater than $0.");
      }
      if (!booking.customerEmail) {
        throw new ConvexError("This booking has no customer email — cannot issue credit.");
      }
      amountCredited = await issueCredit(ctx, {
        email: booking.customerEmail,
        amount,
        reason: "refund",
        bookingId: args.bookingId.toString(),
        note: args.note ?? "Booking charge refunded as account credit (admin).",
      });
    }

    const changeLabel =
      args.mode === "credit"
        ? `refunded — $${amountCredited.toFixed(2)} account credit`
        : args.mode === "stripe"
          ? `refunded via Stripe${amount > 0 ? ` — $${amount.toFixed(2)}` : ""}`
          : "waived (written off)";

    const now = new Date().toISOString();
    const prevHistory = (booking as any).modificationHistory ?? [];
    await ctx.db.patch(args.bookingId, {
      refunded: true,
      refundedAt: now,
      paymentStatus: args.mode === "waive" ? "waived" : "refunded",
      modificationHistory: [
        ...prevHistory,
        {
          modifiedAt: now,
          modifiedByUserId: (admin as any)._id,
          modifiedByName: (admin as any).name ?? (admin as any).email,
          changes: [
            {
              field: "charge",
              oldValue: (booking as any).paymentStatus ?? "paid",
              newValue: changeLabel,
            },
          ],
        },
      ],
    } as any);

    return { success: true, mode: args.mode, amountCredited };
  },
});

// Reset site settings to defaults — ADMIN ONLY
export const resetSiteSettings = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();

    const defaults = {
      key: "global" as const,
      customerPricePerHour: 40,
      customerPrice90Min: 55,
      trumanPricePerHour: 50,
      trumanPrice90Min: 70,
      coachPer30Min: 15,
      coachPerHour: 25,
      cancellationHoursBefore: 2,
      openingHour: 7,
      closingHour: 21,
      minBookingNoticeMinutes: 10,
      coachBookingWindowDays: 7,
      customerOpenDay: "sunday",
      customerOpenHour: 19,
      coachRescheduleFreezeHours: 24,
      extensionNoticeMinutes: 20,
      customerMaxDurationMinutes: 120,
      coachMaxDurationMinutes: 600,
      minAthleteDurationMinutes: 15,
      customerCancellationHours: 2,
      coachLateCancellationHours: 24,
    };

    if (existing) {
      await ctx.db.patch(existing._id, defaults);
      return existing._id;
    } else {
      return await ctx.db.insert("siteSettings", defaults);
    }
  },
});

// ============================================================================
// DISCOUNT CODE MUTATIONS — ADMIN ONLY
// ============================================================================

export const createDiscountCode = mutation({
  args: {
    code: v.string(),
    discount: v.number(),
    discountType: v.optional(v.string()), // 'percent' | 'fixed' | 'free'
    amountOff: v.optional(v.number()),
    label: v.string(),
    bypassStripe: v.boolean(),
    active: v.boolean(),
    expiresAt: v.optional(v.string()),
    usageLimit: v.optional(v.number()),
    perCustomerLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalised = args.code.trim().toLowerCase();
    if (!normalised) throw new ConvexError("Code cannot be empty.");
    const existing = await ctx.db
      .query("discountCodes")
      .withIndex("by_code", (q: any) => q.eq("code", normalised))
      .first();
    if (existing) throw new ConvexError(`Code "${normalised}" already exists.`);
    const type = args.discountType ?? "percent";
    return await ctx.db.insert("discountCodes", {
      code: normalised,
      // 'free' implies 100% + bypassStripe regardless of the inputs.
      discount: type === "free" ? 100 : args.discount,
      discountType: type,
      amountOff: args.amountOff,
      label: args.label,
      bypassStripe: type === "free" ? true : args.bypassStripe,
      active: args.active,
      expiresAt: args.expiresAt,
      usageLimit: args.usageLimit,
      perCustomerLimit: args.perCustomerLimit,
      usedCount: 0,
      createdAt: new Date().toISOString(),
    });
  },
});

export const updateDiscountCode = mutation({
  args: {
    id: v.id("discountCodes"),
    discount: v.optional(v.number()),
    discountType: v.optional(v.string()),
    amountOff: v.optional(v.number()),
    label: v.optional(v.string()),
    bypassStripe: v.optional(v.boolean()),
    active: v.optional(v.boolean()),
    expiresAt: v.optional(v.string()),
    usageLimit: v.optional(v.number()),
    perCustomerLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { id, ...updates } = args;
    const clean: Record<string, any> = Object.fromEntries(
      Object.entries(updates).filter(([, val]) => val !== undefined)
    );
    // Keep 'free' consistent: force 100% + bypassStripe.
    if (clean.discountType === "free") {
      clean.discount = 100;
      clean.bypassStripe = true;
    }
    await ctx.db.patch(id, clean);
    return id;
  },
});

export const deleteDiscountCode = mutation({
  args: { id: v.id("discountCodes") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// ============================================================================
// ADMIN UPGRADE MUTATION — ADMIN ONLY
// ============================================================================

export const upgradeToAdmin = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();
    // M-1/S-2: keep the Better-Auth user.role in step with customers.role so the
    // two stores don't drift (mirrors users.ts makeAdmin). customers.role is the
    // authoritative gate, but Better-Auth's own admin() plugin reads user.role.
    try {
      const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "user",
        where: [{ field: "email", value: normalizedEmail }],
      });
      if (authUser) {
        await ctx.runMutation(components.betterAuth.adapter.updateOne, {
          input: { model: "user", where: [{ field: "_id", value: authUser._id }], update: { role: "admin" } as any },
        });
      }
    } catch (e) {
      console.error("upgradeToAdmin: failed to sync role to auth user:", e);
    }
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (customer) {
      await ctx.db.patch(customer._id, { role: "admin" });
      return customer._id;
    }
    return await ctx.db.insert("customers", {
      name: "Admin",
      email: normalizedEmail,
      role: "admin",
      createdAt: new Date().toISOString(),
    });
  },
});

// ============================================================================
// MERGE CONSECUTIVE COACH BOOKINGS — ADMIN ONLY
// ============================================================================
// Finds coach bookings on the same lane/date that are back-to-back 1-hr blocks
// and collapses them into a single booking. The door/access code from the
// *first* block in each chain is preserved; coachPrice and athleteSlots are
// summed/concatenated; subsequent blocks are hard-deleted (no email/credit
// side-effects since we are just consolidating, not cancelling).

export const mergeConsecutiveCoachBookings = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    // Fetch all non-cancelled coach bookings
    const allBookings = await ctx.db
      .query("bookings")
      .filter((q: any) => q.eq(q.field("isCoachBooking"), true))
      .collect();

    const active = allBookings.filter((b: any) => b.status !== "cancelled");

    // Group by coach email + laneId + date
    const groups = new Map<string, typeof active>();
    for (const b of active) {
      const key = `${b.customerEmail.toLowerCase()}|${b.laneId}|${b.date}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b);
    }

    const mergedSummary: string[] = [];
    let mergeCount = 0;

    for (const bookings of groups.values()) {
      if (bookings.length < 2) continue;

      // Sort by startHour ascending
      bookings.sort((a: any, b: any) => a.startHour - b.startHour);

      // Walk through and collect consecutive chains
      let i = 0;
      while (i < bookings.length) {
        const chain: typeof bookings = [bookings[i]];
        let j = i + 1;
        while (j < bookings.length) {
          const prev = chain[chain.length - 1] as any;
          const curr = bookings[j] as any;
          const prevEnd = prev.startHour + prev.duration / 60;
          // Treat as consecutive if the gap is < 1 minute (floating-point safe)
          if (Math.abs(prevEnd - curr.startHour) < 0.017) {
            chain.push(curr);
            j++;
          } else {
            break;
          }
        }

        if (chain.length >= 2) {
          const first = chain[0] as any;

          // Summed duration
          const totalDuration = chain.reduce((sum: number, b: any) => sum + b.duration, 0);

          // Summed coachPrice (only if every booking in the chain has one)
          const allHavePrice = chain.every((b: any) => typeof b.coachPrice === "number");
          const totalCoachPrice = allHavePrice
            ? chain.reduce((sum: number, b: any) => sum + b.coachPrice, 0)
            : first.coachPrice;

          // Concatenate athleteSlots; stamp the first booking's access code onto all
          const mergedSlots = chain.flatMap((b: any) => b.athleteSlots ?? []);
          const firstCode = first.accessCode;
          const adjustedSlots =
            firstCode && mergedSlots.length > 0
              ? mergedSlots.map((s: any) => ({ ...s, accessCode: firstCode }))
              : mergedSlots;

          // Merge notes (skip blanks, join non-empty with " | ")
          const noteFragments = chain
            .map((b: any) => b.notes)
            .filter((n: any): n is string => typeof n === "string" && n.trim().length > 0);
          const mergedNotes =
            noteFragments.length > 0 ? noteFragments.join(" | ") : undefined;

          // Union of additionalLaneIds across the chain
          const allExtraLanes = [
            ...new Set(chain.flatMap((b: any) => b.additionalLaneIds ?? [])),
          ];

          // Patch the first booking
          const patch: Record<string, any> = { duration: totalDuration };
          if (totalCoachPrice !== undefined) patch.coachPrice = totalCoachPrice;
          if (adjustedSlots.length > 0) patch.athleteSlots = adjustedSlots;
          if (mergedNotes !== undefined) patch.notes = mergedNotes;
          if (allExtraLanes.length > 0) patch.additionalLaneIds = allExtraLanes;

          await ctx.db.patch(first._id, patch);

          // Hard-delete the subsequent bookings; clean up their GCal events
          for (let k = 1; k < chain.length; k++) {
            const toDelete = chain[k] as any;
            if (toDelete.googleCalendarEventId) {
              await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
                googleCalendarEventId: toDelete.googleCalendarEventId,
                laneCalendarEventIds: toDelete.googleCalendarEventIds,
              });
            }
            await ctx.db.delete(toDelete._id);
          }

          mergeCount++;
          const fmtH = (h: number) => {
            const w = Math.floor(h);
            const m = Math.round((h - w) * 60);
            return `${w}:${m.toString().padStart(2, "0")}`;
          };
          mergedSummary.push(
            `${first.customerName} · ${first.date} · ${first.laneId} · ` +
              `${fmtH(first.startHour)} → ${totalDuration}min (${chain.length} blocks)`
          );
        }

        i = j;
      }
    }

    return { mergeCount, mergedSummary };
  },
});
