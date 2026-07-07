import { mutation, internalMutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal, components } from "./_generated/api";
import { requireAdmin, requireAdminUnlocked, getAuthUserSafe } from "./lib/adminGuard";
import { issueCredit, redeemCredit, recordCreditMovement } from "./lib/credit";
import { enforceRateLimit } from "./lib/rateLimit";
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
import { recordBookingEvent } from "./bookingEvents";
import {
  getAWSTNow,
  checkBookingHorizon,
  checkLeadTime,
  type WindowRole,
  type WindowTier,
} from "./lib/bookingWindow";
import { computeCustomerPriceCents, decreaseCreditCents } from "./lib/pricing";
import { validateAndSnapshotLane, resolveLaneSnapshot } from "./lanes";
import { defaultLaneName } from "./lib/lanes";
import { PRICE_DEFAULTS } from "./lib/priceDefaults";
import { composeName, splitName } from "./lib/names";
import { resolveCanonicalCustomerByEmail } from "./lib/identity";
import { assertValidLocation, validateLocationIfProvided, normalizePostcode, normalizeSuburb } from "./lib/locations";
import { notifyMatesOnCancel, notifyMatesOnModify } from "./mates";
import { scheduleCapReconcileForBooking } from "./billingCaps";

// ============================================================================
// SHARED HELPERS
// ============================================================================

// Exported so the Stripe webhook (confirmBookingPayment) can format the merged
// booking-confirmation + receipt email identically to createBooking's email.
export function fmtHour12(h: number): string {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  const period = hr >= 12 ? "PM" : "AM";
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${display}:${min.toString().padStart(2, "0")} ${period}`;
}

export function durationLabel(m: number): string {
  return m === 60 ? "1 hour" : m === 90 ? "1.5 hours" : m === 120 ? "2 hours" : `${m} minutes`;
}

// Format a YYYY-MM-DD booking date as a weekday-long label in AWST (Bug #4).
// toLocaleDateString without an explicit timeZone uses the Convex server zone
// (UTC), which can flip the weekday at the day boundary for AWST recipients.
export function fmtAwstDateLabel(dateStr: string): string {
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
  laneNameSnapshot?: string | null;
  date: string;
  startHour: number;
  duration: number;
  accessCode?: string | null;
  coachPrice?: number | null;
  creditApplied?: number | null;
}) {
  // SPEC_RECONFIGURABLE_LANES: emails read the booking snapshot; legacy rows
  // (no snapshot) fall back to the default name.
  const laneName = b.laneNameSnapshot || defaultLaneName(b.laneId);
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

// SPEC_ANALYTICS_ATHLETE_CATCHMENT: snapshot each athlete slot's home suburb.
// Resolves athleteId -> athletes.accountCustomerId -> customers.{postcode,suburb}
// (the parent/account holder; a self-athlete resolves to their own account, same
// path) and writes athletePostcode/athleteSuburb onto the slot SERVER-SIDE. The
// coach's own postcode is never read (R3). Slots with no athleteId, a deleted
// athlete, or a parent with no postcode yet get no snapshot (left absent ->
// "Unknown" in the report). Cached per athleteId. Every athlete-slot write site
// routes through this so the snapshot stays consistent. Returns the slots with the
// two fields attached (or the input unchanged when empty/undefined).
async function attachAthleteSuburbs<T extends { athleteId?: any }>(
  ctx: any,
  slots: T[] | undefined
): Promise<Array<T & { athletePostcode?: string; athleteSuburb?: string }> | undefined> {
  if (!slots || slots.length === 0) return slots as any;
  const cache = new Map<string, { postcode?: string; suburb?: string }>();
  const out: Array<T & { athletePostcode?: string; athleteSuburb?: string }> = [];
  for (const s of slots) {
    let snap: { postcode?: string; suburb?: string } = {};
    const aid = s.athleteId ? String(s.athleteId) : "";
    if (aid) {
      const cached = cache.get(aid);
      if (cached !== undefined) {
        snap = cached;
      } else {
        const athlete: any = await ctx.db.get(s.athleteId);
        if (athlete?.accountCustomerId) {
          const parent: any = await ctx.db.get(athlete.accountCustomerId);
          if (parent?.postcode && parent?.suburb) {
            snap = { postcode: parent.postcode, suburb: parent.suburb };
          }
        }
        cache.set(aid, snap);
      }
    }
    out.push({ ...s, athletePostcode: snap.postcode, athleteSuburb: snap.suburb });
  }
  return out;
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
  const laneName = (opts as any).laneNameSnapshot || defaultLaneName(opts.laneId);
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
    // SPEC_PWA_PUSH §5.1 — child coaching alert (parent), beside the email.
    const pNames = entries.map((s) => s.name).join(" & ");
    const pTime = entries.map((s) => fmtTimeRange(s.startHour, s.durationMinutes)).join("; ");
    await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
      email: to,
      category: "child-coaching",
      title: "Coaching session booked",
      body: `${pNames} — ${laneName}, ${formattedDate}, ${pTime}`,
      url: "/bookings",
      tag: `alloc-${opts.laneId}-${opts.date}`,
    });
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
  const laneName = (opts as any).laneNameSnapshot || defaultLaneName(opts.laneId);
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
    await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
      email: to,
      category: "child-coaching",
      title: "Coaching session cancelled",
      body: `${names} — ${laneName}, ${formattedDate} is cancelled.`,
      url: "/bookings",
      tag: `alloc-${opts.laneId}-${opts.date}`,
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
  const laneName = (opts as any).laneNameSnapshot || defaultLaneName(opts.laneId);
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
    await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
      email: to,
      category: "child-coaching",
      title: "Removed from coaching session",
      body: `${names} — ${laneName}, ${formattedDate}.`,
      url: "/bookings",
      tag: `alloc-${opts.laneId}-${opts.date}`,
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
  const laneName = (opts as any).laneNameSnapshot || defaultLaneName(opts.laneId);
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
    await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
      email: to,
      category: "child-coaching",
      title: "Coaching session moved",
      body: `${names} — now ${laneName}, ${formattedNew}, ${timeSlot}.`,
      url: "/bookings",
      tag: `alloc-${opts.laneId}-${opts.newDate}`,
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

  // SPEC_RECONFIGURABLE_LANES: re-resolve the lane name + variant snapshot at the
  // NEW (date, startHour) so emails stay correct after a modify (incl. across a
  // date boundary with a different layout).
  const newSnap = await resolveLaneSnapshot(
    ctx,
    change.newLaneId,
    change.newVariantId ?? booking.variantId,
    change.newDate,
    change.newStartHour
  );

  await ctx.db.patch(booking._id, {
    date: change.newDate,
    startHour: change.newStartHour,
    duration: change.newDuration,
    laneId: change.newLaneId,
    variantId: change.newVariantId ?? booking.variantId,
    additionalLaneIds: change.newAdditionalLaneIds ?? booking.additionalLaneIds,
    ...(change.newCoachPrice !== undefined ? { coachPrice: change.newCoachPrice } : {}),
    ...(change.newPriceInCents !== undefined ? { priceInCents: change.newPriceInCents } : {}),
    laneNameSnapshot: newSnap.laneNameSnapshot,
    variantLabelSnapshot: newSnap.variantLabelSnapshot,
    athleteSlots: adjustedAthleteSlots,
    accessCode,
    // On a lane MOVE we recreate the events (new ids) so clear the old ones; on an
    // in-place update we keep the existing event ids and PUT the new details.
    ...(laneSetChanged ? { googleCalendarEventId: undefined, googleCalendarEventIds: undefined } : {}),
    ...(change.regenCode ? { lockSyncStatus: "pending" } : {}),
    reminderSent: false,
  });

  // WS-C live feed: record the modify event. `booking.*` still holds the PRE-patch
  // (old) slot; `change`/`newSnap` carry the new one — so before vs after is exact.
  await recordBookingEvent(ctx, {
    type: "modified",
    bookingId: booking._id.toString(),
    customerName: booking.customerName ?? "Unknown",
    actorName: change.actorName,
    isCoachBooking: booking.isCoachBooking,
    before: {
      date: booking.date,
      startHour: booking.startHour,
      duration: booking.duration,
      lane: booking.laneNameSnapshot ?? booking.laneId ?? "",
      variant: booking.variantLabelSnapshot ?? undefined,
    },
    after: {
      date: change.newDate,
      startHour: change.newStartHour,
      duration: change.newDuration,
      lane: newSnap.laneNameSnapshot,
      variant: newSnap.variantLabelSnapshot ?? undefined,
    },
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
      laneNameSnapshot: newSnap.laneNameSnapshot,
      variantLabelSnapshot: newSnap.variantLabelSnapshot,
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
      laneNameSnapshot: newSnap.laneNameSnapshot,
      variantLabelSnapshot: newSnap.variantLabelSnapshot,
    });
  }

  // Owner "booking modified" email (reuses the rescheduled template).
  if (booking.customerEmail) {
    await ctx.scheduler.runAfter(0, internal.emails.sendBookingRescheduled, {
      to: booking.customerEmail,
      customerName: booking.customerName || "Valued Customer",
      oldLaneName: booking.laneNameSnapshot || defaultLaneName(booking.laneId),
      oldDate: booking.date,
      oldTimeSlot: fmtHour12(booking.startHour),
      newLaneName: newSnap.laneNameSnapshot,
      newDate: change.newDate,
      newTimeSlot: fmtHour12(change.newStartHour),
      newDuration: durationLabel(change.newDuration),
      accessCode: accessCode ?? "",
    });
    // SPEC_PWA_PUSH §5.1 — booking change push (customer bookings only).
    if (!booking.isCoachBooking) {
      await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
        email: booking.customerEmail,
        category: "booking-changes",
        title: "Booking updated",
        body: `${newSnap.laneNameSnapshot} · ${fmtAwstDateLabel(change.newDate)}, ${fmtHour12(change.newStartHour)}${accessCode ? ` · Door code ${accessCode}` : ""}`,
        url: "/bookings",
        tag: `booking-${booking._id.toString()}`,
      });
    }
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

  // Weekly billing cap (2026-07): a coach modify can change the week's charge
  // (duration → coachPrice) or move the session to another week — re-cap both the
  // old and new weeks (no-op for uncapped coaches / customer bookings).
  if (booking.isCoachBooking) {
    await scheduleCapReconcileForBooking(ctx, booking.customerEmail, booking.date);
    if (change.newDate !== booking.date) {
      await scheduleCapReconcileForBooking(ctx, booking.customerEmail, change.newDate);
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
    notes: v.optional(v.string()),
    // Admin manual booking (SPEC_ADMIN_AND_SETTINGS #2): comp / paid-offline record
    // a price + paid status with no Stripe; send-payment-request creates a pending
    // booking. These let the admin stamp the booking without going through checkout.
    paymentStatus: v.optional(v.string()),
    priceInCents: v.optional(v.number()),
    // SPEC_SCHEDULE_DAY_VIEW §2.13: admin manual-booking "Managed by admin" flag.
    // Only honoured for admin-created coach bookings (gated server-side below).
    createdByAdmin: v.optional(v.boolean()),
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
      // Batch 2B: resolve the CANONICAL customers row (prefer coach/admin), so a
      // duplicate/role-drifted row can't make `.first()` demote a coach to a customer.
      callerCustomer = await resolveCanonicalCustomerByEmail(ctx, callerEmail);
      isAdminCaller = callerCustomer?.role === "admin";
      if (!isForSelf && !isAdminCaller) {
        throw new ConvexError("You can only create bookings for yourself.");
      }

      // M2 (SEC audit 2026-06-03): throttle booking creation per caller. Each
      // createBooking writes a booking row, may schedule emails, and can place a
      // slot hold — so an unthrottled loop is a booking/email/slot-hold spam +
      // denial vector. 15/min is far above any real human pace. Admins are
      // exempt (bulk manual bookings). Fails open if the limiter errors.
      if (!isAdminCaller) {
        await enforceRateLimit(
          ctx,
          {
            action: "create-booking",
            identifier: createIdentity.subject ?? callerEmail,
            max: 15,
            windowMs: 60_000,
          },
          "Too many booking attempts — please wait a minute and try again."
        );
      }

      // SEC decision #4 (re-enabled 2026-06-15): a verified email is required to
      // COMPLETE the FIRST booking, so the door-code email reliably lands. Exempt
      // admins and coaches (resolved role, not the client flag). Later bookings are
      // unaffected. The app also gates its whole UI on verification for customers
      // (SIGNUP-VERIFY-LOCKDOWN, __root); this is the server-side backstop.
      if (!isAdminCaller && callerCustomer?.role !== "coach") {
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
    // SPEC_30MIN_GAP_FILL — a 30-minute booking is allowed ONLY as a gap-fill (a
    // customer filling an unavoidable 30-min slot a full hour can't occupy). The
    // gap-validity + role checks run after the conflict scan below; here we only
    // relax the 1-hour floor for exactly 30. Every other sub-60 value is rejected.
    const isThirtyMin = args.duration === 30;
    if (args.duration < 60 && !isThirtyMin) {
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
    // SPEC_MOBILE_BOOKING_UPDATES §7.2 — L1 coaches may book a pre-open 6:30am slot
    // (an explicit early coaching slot allowed below the public opening hour).
    // Batch 2A: an L1 coach's booking is always a coach booking — gate the early
    // 6:30am slot on the resolved role/tier, not the (now-untrusted) client flag.
    const callerIsL1Coach =
      callerCustomer?.role === "coach" &&
      !(callerCustomer?.coachTier === "L2" || callerCustomer?.coachTier === "BowlingL2");
    // L1 coaches may book the 6:30am slot; admins may book ANY pre-open slot
    // (manual / early bookings, e.g. 6:30am) as an explicit override.
    const allowPreOpen = (callerIsL1Coach && args.startHour === 6.5) || isAdminCaller;
    if (args.startHour < OPENING_HOUR && !allowPreOpen) {
      throw new ConvexError("Booking starts before opening time.");
    }
    // SPEC_ADMIN_AFTER_HOURS_BOOKING_2026-07 — admins may extend a booking PAST the
    // day's close, up to a 22:00 (10pm) ceiling, for customers OR coaches (e.g. an 8pm
    // booking for 1.5h/2h → 8–9:30 / 8–10, or the 9–10pm slot itself). Hidden from the
    // public calendar (it renders only up to `close`, unchanged). Derived from the
    // RESOLVED admin caller server-side, so a crafted customer/coach request can never
    // set it. The booking end is the only thing gated (≤ 22:00); the start may be any
    // in-hours slot.
    const AFTER_HOURS_CEILING = 22;
    const allowAfterHours =
      isAdminCaller && endHour > CLOSING_HOUR && endHour <= AFTER_HOURS_CEILING + 1e-9;
    if (endHour > CLOSING_HOUR && !allowAfterHours) {
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

    // Batch 2A — SERVER-AUTHORITATIVE coach-booking flag. A coach's own booking is
    // ALWAYS a coach booking (a drifted identity row can no longer demote it to a
    // paid customer booking); an admin may explicitly create one; a CUSTOMER can
    // never forge one (this also closes a payment-skip hole — the client flag was
    // previously trusted at insert time). Everything below keys off this.
    const effectiveIsCoachBooking = callerRole === "coach" || (isAdminCaller && !!args.isCoachBooking);
    // Server-owned coach price (coaches billed separately, no Stripe): derive from the
    // admin coachPerHour rate rather than trusting the client amount.
    const coachPerHourRate = (siteSettings as any)?.coachPerHour ?? PRICE_DEFAULTS.coachPerHour;
    // M6 fix (2026-07): a coach booking spanning MULTIPLE lanes (additionalLaneIds)
    // is charged PER LANE — matching the customer per-lane rule and the client
    // booking preview. Previously coachPrice = duration×rate only, so a 4-lane block
    // billed for 1 lane (e.g. $50 instead of $200).
    const coachLaneCount = 1 + (args.additionalLaneIds?.length ?? 0);
    const effectiveCoachPrice = effectiveIsCoachBooking
      ? Math.round((args.duration / 60) * coachPerHourRate * coachLaneCount * 100) / 100
      : undefined;
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
    if (callerRole === "customer" && !effectiveIsCoachBooking) {
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
    // SPEC_30MIN_GAP_FILL — for a 30-min booking, track whether a full 60-min booking
    // would have fit at this start (it doesn't if it overlaps a booking/block or runs
    // past closing). A 30-min booking is only legitimate when a 60-min would NOT fit.
    const sixtyEnd = args.startHour + 1;
    let sixtyMinWouldFit = isThirtyMin ? sixtyEnd <= CLOSING_HOUR : false;
    // BUGM-1 (audit 2026-06): read the day's bookings ONCE and test overlap against
    // each booking's FULL lane set (primary + additionalLaneIds). The old per-lane
    // by_laneId_date scan only saw a booking via its PRIMARY lane, so a multi-lane
    // booking never blocked its ADDITIONAL lanes → two bookings could be confirmed on
    // the same physical lane (both issued door codes). occupiesLane closes that gap.
    const dayBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
    const occupiesLane = (b: any, lid: string) =>
      b.laneId === lid || ((b.additionalLaneIds as string[]) ?? []).includes(lid);
    for (const lid of allLaneIds) {
      const laneBookings = dayBookings.filter((b: any) => occupiesLane(b, lid));

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

      // SPEC_30MIN_GAP_FILL gap check: would a 60-min booking overlap a booking/block here?
      if (isThirtyMin && sixtyMinWouldFit) {
        const sixtyOverlap =
          laneBookings.some((b) => {
            if (b.status === "cancelled") return false;
            const bEnd = b.startHour + b.duration / 60;
            return args.startHour < bEnd && sixtyEnd > b.startHour;
          }) ||
          laneBlocks.some((b) => {
            const bEnd = b.startHour + b.duration / 60;
            return args.startHour < bEnd && sixtyEnd > b.startHour;
          });
        if (sixtyOverlap) sixtyMinWouldFit = false;
      }
    }

    // SPEC_30MIN_GAP_FILL — a 30-min booking is allowed only where a full hour can't
    // fit (the orphan before a half-hour coach booking, or against closing). Reject a
    // 30-min booking that a 60-min would have fit (no cheap 30-min in open time).
    // Coaches are min 1 hour; admin-manual bookings are exempt (deliberate).
    if (isThirtyMin && !isAdminCaller) {
      if (effectiveIsCoachBooking) {
        throw new ConvexError("Coach bookings are a minimum of 1 hour.");
      }
      if (sixtyMinWouldFit) {
        throw new ConvexError("30-minute slots are only available to fill a short gap.");
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
    if (!effectiveIsCoachBooking && !isAdminManual) {
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
    if (!effectiveIsCoachBooking && !isAdminManual && args.status === "confirmed") {
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
    const codedAthleteSlots = args.athleteSlots && effectiveIsCoachBooking
      ? args.athleteSlots.map((s) => ({
          ...s,
          accessCode: bookingAccessCode,
          codeGeneratedAt: s.codeGeneratedAt ?? new Date().toISOString(),
        }))
      : args.athleteSlots;
    // SPEC_ANALYTICS_ATHLETE_CATCHMENT: snapshot each athlete's home suburb.
    const normalizedAthleteSlots = await attachAthleteSuburbs(ctx, codedAthleteSlots);

    // SPEC_PROFILE_POSTCODE_SUBURB Addendum A: snapshot the booker's postcode/suburb
    // onto the booking for the catchment report. Customer + admin-manual bookings only
    // (coach own-bookings excluded — they don't count). For self-bookings the booker is
    // callerCustomer; for admin-manual the booking is for a different customer, so resolve
    // by customerEmail. Stored as a snapshot so a later move doesn't rewrite history.
    let bookingPostcode: string | undefined;
    let bookingSuburb: string | undefined;
    if (!effectiveIsCoachBooking) {
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

    // SPEC_RECONFIGURABLE_LANES: validate the lane/variant/duration against the
    // date-resolved segment (variant must be offered; booking may not cross a
    // segment boundary, §2.14) and snapshot the resolved name + variant label so
    // emails stay correct after any later layout change.
    const laneSnap = await validateAndSnapshotLane(ctx, {
      laneId: args.laneId,
      variantId: args.variantId,
      date: args.date,
      startHour: args.startHour,
      durationMinutes: args.duration,
      skipVariantCheck: effectiveIsCoachBooking || isAdminManual,
      // Admin after-hours (9–10pm) booking: don't reject the segment-boundary cross
      // at the day's close. There is no lane segment past 21:00 to legitimately cross,
      // and allowAfterHours is admin-derived above, so the server stays authoritative.
      allowAfterHours,
    });

    // ── Auto-merge back-to-back coach bookings ───────────────────────────────
    // When a coach books a slot exactly adjacent to an existing coach booking of
    // theirs on the SAME lane/date/variant, EXTEND that booking instead of making
    // a second one: one door code, one continuous Google Calendar event (so HA
    // powers the machine + holds the code for the whole session), one statement
    // line. Single-lane confirmed coach bookings only; the survivor's door code is
    // preserved and its event extended in place. Admin-managed bookings are left
    // alone (respects the lock). Gap-fill between TWO coach bookings merges one
    // side; the admin "merge consecutive" tool cleans up any remainder.
    const canAutoMerge =
      effectiveIsCoachBooking &&
      effectiveStatus === "confirmed" &&
      (args.additionalLaneIds ?? []).length === 0 &&
      !(isAdminCaller && args.createdByAdmin); // never fold a managed booking into another
    if (canAutoMerge) {
      const emailKey = args.customerEmail.toLowerCase().trim();
      const adj = dayBookings.find((b: any) => {
        if (b.status === "cancelled" || b.isCoachBooking !== true) return false;
        if (b.createdByAdmin === true) return false; // don't silently alter a managed booking
        if ((b.customerEmail ?? "").toLowerCase().trim() !== emailKey) return false;
        if (b.laneId !== args.laneId) return false;
        if ((b.variantId ?? null) !== (args.variantId ?? null)) return false;
        if (((b.additionalLaneIds as string[]) ?? []).length !== 0) return false;
        const bEnd = b.startHour + b.duration / 60;
        // Exactly adjacent on either side (float-safe, < ~1 min gap).
        return Math.abs(bEnd - args.startHour) < 0.017 || Math.abs(endHour - b.startHour) < 0.017;
      }) as any;
      if (adj) {
        const survivorCode = adj.accessCode ?? bookingAccessCode;
        const mergedStart = Math.min(adj.startHour, args.startHour);
        const mergedEnd = Math.max(adj.startHour + adj.duration / 60, endHour);
        const mergedDuration = Math.round((mergedEnd - mergedStart) * 60);
        // Sum the prices (like the manual merge tool) so an admin-adjusted price on
        // the existing booking is preserved + the standard new-hour rate is added.
        const mergedCoachPrice =
          Math.round(((adj.coachPrice ?? 0) + (effectiveCoachPrice ?? 0)) * 100) / 100;
        // The new slots keep their absolute times; stamp the survivor's shared code.
        const newSlots = (normalizedAthleteSlots ?? []).map((s: any) => ({
          ...s,
          accessCode: survivorCode,
          codeGeneratedAt: s.codeGeneratedAt ?? new Date().toISOString(),
        }));
        const mergedSlots = [...(((adj.athleteSlots as any[]) ?? [])), ...newSlots];
        const mergedNotesArr = [adj.notes, args.notes].filter(
          (n: any): n is string => typeof n === "string" && n.trim().length > 0
        );
        const mergedSnap = await resolveLaneSnapshot(ctx, adj.laneId, adj.variantId, adj.date, mergedStart);

        await ctx.db.patch(adj._id, {
          startHour: mergedStart,
          duration: mergedDuration,
          coachPrice: mergedCoachPrice,
          athleteSlots: mergedSlots.length > 0 ? mergedSlots : undefined,
          notes: mergedNotesArr.length > 0 ? mergedNotesArr.join(" | ") : adj.notes,
          laneNameSnapshot: mergedSnap.laneNameSnapshot,
          variantLabelSnapshot: mergedSnap.variantLabelSnapshot,
          reminderSent: false,
        });

        // Live feed: record the extend as a modify on the survivor.
        await recordBookingEvent(ctx, {
          type: "modified",
          bookingId: adj._id.toString(),
          customerName: adj.customerName ?? args.customerName,
          actorName: args.customerName,
          isCoachBooking: true,
          before: { date: adj.date, startHour: adj.startHour, duration: adj.duration, lane: adj.laneNameSnapshot ?? adj.laneId ?? "", variant: adj.variantLabelSnapshot ?? undefined },
          after: { date: adj.date, startHour: mergedStart, duration: mergedDuration, lane: mergedSnap.laneNameSnapshot, variant: mergedSnap.variantLabelSnapshot ?? undefined },
        });

        // Google Calendar: extend the survivor's event IN PLACE so HA powers the
        // machine + holds the door code for the WHOLE merged session. Create it if
        // the survivor has no event yet (never leave the merged session eventless).
        const calSlots = mergedSlots.map((s: any) => ({ athleteName: s.athleteName, startHour: s.startHour, durationMinutes: s.durationMinutes }));
        const hadEvent = !!adj.googleCalendarEventId || (Array.isArray(adj.googleCalendarEventIds) && adj.googleCalendarEventIds.length > 0);
        if (hadEvent) {
          await ctx.scheduler.runAfter(0, internal.googleCalendar.updateCalendarEvent, {
            googleCalendarEventId: adj.googleCalendarEventId ?? "",
            laneId: adj.laneId,
            variantId: adj.variantId,
            date: adj.date,
            startHour: mergedStart,
            duration: mergedDuration,
            customerName: adj.customerName,
            customerEmail: adj.customerEmail,
            customerPhone: adj.customerPhone,
            status: "confirmed",
            isCoachBooking: true,
            accessCode: survivorCode,
            additionalLaneIds: undefined,
            athleteSlots: calSlots,
            laneCalendarEventIds: adj.googleCalendarEventIds,
            laneNameSnapshot: mergedSnap.laneNameSnapshot,
            variantLabelSnapshot: mergedSnap.variantLabelSnapshot,
          });
        } else {
          await ctx.scheduler.runAfter(0, internal.googleCalendar.createCalendarEvent, {
            bookingId: adj._id.toString(),
            laneId: adj.laneId,
            variantId: adj.variantId,
            date: adj.date,
            startHour: mergedStart,
            duration: mergedDuration,
            customerName: adj.customerName,
            customerEmail: adj.customerEmail,
            customerPhone: adj.customerPhone,
            status: "confirmed",
            isCoachBooking: true,
            accessCode: survivorCode,
            additionalLaneIds: undefined,
            athleteSlots: calSlots,
            laneNameSnapshot: mergedSnap.laneNameSnapshot,
            variantLabelSnapshot: mergedSnap.variantLabelSnapshot,
          });
        }

        // Notify only the NEWLY-added athletes' parents (existing ones unchanged).
        if (newSlots.length > 0) {
          await scheduleAllocationEmails(ctx, {
            slots: newSlots,
            laneId: adj.laneId,
            date: adj.date,
            bookingAccessCode: survivorCode,
            coachName: adj.customerName ?? args.customerName,
          });
        }

        // Weekly billing cap: this coach's week just gained charge — re-cap it.
        await scheduleCapReconcileForBooking(ctx, adj.customerEmail ?? args.customerEmail, adj.date);
        // Merged into the existing booking — return its id (no second row).
        return adj._id;
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
      isCoachBooking: effectiveIsCoachBooking,
      coachPrice: effectiveCoachPrice,
      additionalLaneIds: args.additionalLaneIds,
      athleteSlots: normalizedAthleteSlots,
      creditApplied: args.creditApplied,
      accessCode: bookingAccessCode,
      discountCode: args.discountCode,
      notes: args.notes,
      paymentStatus: args.paymentStatus,
      priceInCents: serverPriceCents,
      bookingPostcode,
      bookingSuburb,
      laneNameSnapshot: laneSnap.laneNameSnapshot,
      variantLabelSnapshot: laneSnap.variantLabelSnapshot,
      // §2.13: only an admin can mark a COACH booking as admin-managed. Ignore the
      // flag on customer bookings or from non-admin callers.
      createdByAdmin: isAdminCaller && effectiveIsCoachBooking && args.createdByAdmin ? true : undefined,
      createdAt: Date.now(), // §6.2 admin digest windowing
    });

    // WS-C live feed: record the create event (admin Live Feed tab).
    await recordBookingEvent(ctx, {
      type: "created",
      bookingId: id.toString(),
      customerName: args.customerName,
      actorName: args.customerName,
      isCoachBooking: effectiveIsCoachBooking,
      after: {
        date: args.date,
        startHour: args.startHour,
        duration: args.duration,
        lane: laneSnap.laneNameSnapshot,
        variant: laneSnap.variantLabelSnapshot ?? undefined,
      },
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
    // MONM-4 (audit 2026-06): only a CUSTOMER self-pay (or admin-manual customer)
    // booking redeems account credit. A confirmed COACH booking must never deduct the
    // coach's credit balance (coaches bill via statement, not credit) — added the
    // !effectiveIsCoachBooking guard (redeemCredit already clamps to balance, but a
    // coach booking should not touch credit at all).
    if (effectiveStatus === "confirmed" && !effectiveIsCoachBooking && (args.creditApplied ?? 0) > 0 && args.customerEmail) {
      await redeemCredit(ctx, {
        email: args.customerEmail,
        amount: args.creditApplied as number,
        bookingId: id.toString(),
      });
    }

    // MON-4 (audit 2026-06): RESERVE the discount at CREATE (not at confirm) so
    // concurrent checkouts can't overshoot a usageLimit/perCustomerLimit. This
    // increments usedCount + inserts the redemption row (idempotent by bookingId); the
    // discountCodes write makes Convex OCC serialize concurrent reservations, so the
    // cap holds under load. confirmBookingPayment's later call is then a no-op (row
    // exists), and an abandoned unpaid booking releases it via releaseAbandonedBooking.
    // Reserve for both directly-confirmed (free/comp) and pending_payment (Stripe).
    if (
      args.discountCode &&
      (effectiveStatus === "confirmed" || effectiveStatus === "pending_payment")
    ) {
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
          laneNameSnapshot: laneSnap.laneNameSnapshot,
          date: args.date,
          startHour: args.startHour,
          duration: args.duration,
          accessCode: bookingAccessCode,
          coachPrice: effectiveCoachPrice,
          creditApplied: args.creditApplied,
        }),
      );
      // SPEC_PWA_PUSH §5.1 — booking confirmation push (customer bookings only;
      // coach bookings get a coach-allocation push instead, below).
      if (!effectiveIsCoachBooking) {
        await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
          email: args.customerEmail,
          category: "booking-confirmation",
          title: "Booking confirmed 🏏",
          body: `${laneSnap.laneNameSnapshot ?? defaultLaneName(args.laneId)} · ${fmtAwstDateLabel(args.date)}, ${fmtTimeRange(args.startHour, args.duration)} · Door code ${bookingAccessCode}`,
          url: "/bookings",
          tag: `booking-${id.toString()}`,
        });
      } else if (args.createdByAdmin) {
        // "Your booking created by admin (admin-managed)" → coach.
        await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
          email: args.customerEmail,
          category: "coach-allocation",
          title: "Session booked for you",
          body: `${laneSnap.laneNameSnapshot ?? defaultLaneName(args.laneId)} · ${fmtAwstDateLabel(args.date)}, ${fmtTimeRange(args.startHour, args.duration)}`,
          url: "/bookings",
          tag: `booking-${id.toString()}`,
        });
      }
    }

    // Send athlete allocation emails for coach bookings with initial athlete
    // slots — resolved to the parent account email + child name, grouped per
    // account (SPEC_PARENT_ATHLETE_MODEL).
    if (effectiveIsCoachBooking && normalizedAthleteSlots && normalizedAthleteSlots.length > 0 && effectiveStatus === "confirmed") {
      await scheduleAllocationEmails(ctx, {
        slots: normalizedAthleteSlots,
        laneId: args.laneId,
        date: args.date,
        bookingAccessCode: bookingAccessCode,
        coachName: args.customerName,
      });
    }

    // Trigger Google Calendar sync for confirmed bookings
    if (effectiveStatus === "confirmed") {
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
        isCoachBooking: effectiveIsCoachBooking,
        accessCode: bookingAccessCode,
        additionalLaneIds: args.additionalLaneIds,
        // CAL-1 (audit 2026-06-23): strip stored slots to exactly the validator's
        // shape — normalizedAthleteSlots carry athleteId/accessCode/codeGeneratedAt/
        // postcode/suburb, which Convex's strict v.object() REJECTS → the scheduled
        // createCalendarEvent throws at run time → a coach booking with athletes
        // pre-allocated at create time silently gets NO event (HA never loads the
        // door code). Every other create path already strips; this one was missed.
        athleteSlots: normalizedAthleteSlots?.map((s: any) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
        laneNameSnapshot: laneSnap.laneNameSnapshot,
        variantLabelSnapshot: laneSnap.variantLabelSnapshot,
      });
    }

    // Weekly billing cap (2026-07): a new coach session may push this coach's week
    // over their cap — reconcile the credit line (no-op for uncapped coaches).
    if (effectiveIsCoachBooking) {
      await scheduleCapReconcileForBooking(ctx, args.customerEmail, args.date);
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
    // MONM-1 (audit 2026-06): `creditApplied` arg removed — no caller ever sent it,
    // and patching it verbatim could mint/drift redeemable credit with no creditLedger
    // entry. Account-credit changes must route through issueCredit/redeemCredit.
    cancelledAt: v.optional(v.string()),
    cancelledByUserId: v.optional(v.string()),
    refilledMinutes: v.optional(v.number()),
    originalCoachId: v.optional(v.string()),
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
      const codedSlots = effectiveSlots.map((s: any) => ({
        ...s,
        accessCode: effectiveCode,
        codeGeneratedAt: s.codeGeneratedAt ?? new Date().toISOString(),
      }));
      // SPEC_ANALYTICS_ATHLETE_CATCHMENT: re-snapshot each athlete's home suburb.
      (cleanUpdates as any).athleteSlots = await attachAthleteSuburbs(ctx, codedSlots);
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
    // Any other field the calendar event / activity feed reflects — so a variant /
    // code / name / status edit also re-syncs the event + logs (previously only a
    // date/time/lane/duration change did anything).
    const _fieldChanged = (f: string) =>
      existing != null && (cleanUpdates as any)[f] !== undefined && (cleanUpdates as any)[f] !== (existing as any)[f];
    const variantChanged = _fieldChanged("variantId");
    const eventAffected =
      schedulingChanged ||
      variantChanged ||
      _fieldChanged("accessCode") ||
      _fieldChanged("customerName") ||
      _fieldChanged("customerPhone") ||
      _fieldChanged("status") ||
      (cleanUpdates as any).athleteSlots !== undefined;

    // DI-1: Conflict check when scheduling fields change
    if (schedulingChanged && effNewDate && effNewStartHour != null && effNewDuration != null && effNewLaneId) {
      const endHourUpd = effNewStartHour + effNewDuration / 60;
      const allLanesUpd = [effNewLaneId, ...effNewAdditionalLanes];
      // BUGM-1 (audit 2026-06): read the day once + test each booking's FULL lane set
      // (primary + additionalLaneIds) so a move onto a lane held via another booking's
      // additionalLaneIds is caught (the old per-lane by_laneId_date scan missed it).
      const dayBookingsUpd = await ctx.db
        .query("bookings")
        .withIndex("by_date", (q: any) => q.eq("date", effNewDate))
        .collect();
      const occUpd = (b: any, lid: string) =>
        b.laneId === lid || ((b.additionalLaneIds as string[]) ?? []).includes(lid);
      for (const lid of allLanesUpd) {
        const hasConflictUpd = dayBookingsUpd.some((b: any) => {
          if (b._id === id || b.status === "cancelled") return false;
          if (!occUpd(b, lid)) return false;
          const bEnd = b.startHour + b.duration / 60;
          return effNewStartHour < bEnd && endHourUpd > b.startHour;
        });
        if (hasConflictUpd) {
          throw new ConvexError("Cannot update — the new time slot conflicts with an existing booking.");
        }
      }
      // BUGM-2 (audit 2026-06): also fence off an in-flight checkout/waitlist hold
      // (createBooking + modifyBooking already do this; admin updateBooking did not).
      // bypassWaitlistHolds matches the non-customer convention (admins aren't fenced
      // off by a customer's first-refusal offer; this mainly catches a residual
      // checkout hold without a live booking row).
      if (
        await hasActiveHoldConflict(ctx, {
          laneIds: allLanesUpd,
          date: effNewDate,
          startHour: effNewStartHour,
          endHour: endHourUpd,
          excludeBookingId: id.toString(),
          bypassWaitlistHolds: true,
        })
      ) {
        throw new ConvexError("Cannot update — the new time slot has an in-flight checkout. Please try again shortly.");
      }
    }

    // BUGM-3 (audit 2026-06): removed the MF-1 "add account credit when admin reduces
    // coachPrice" block. coachPrice only exists on COACH bookings, which bill via the
    // weekly statement and have no redeemable-credit economy — issuing credit there
    // minted spendable balance to the coach ON TOP of lowering their statement charge
    // (cancel/delete already exclude coach bookings from credit). Reducing coachPrice
    // now only lowers the statement line, which is the intended effect (admins use
    // adminSetCoachPrice for statement edits).

    // SPEC_RECONFIGURABLE_LANES: recompute the date-resolved lane/variant snapshot
    // when lane/variant/date/start changes, so the booking record + its calendar
    // event show the correct name after an admin lane swap (was left stale).
    let newSnap: { laneNameSnapshot: string; variantLabelSnapshot: string } | null = null;
    if (existing && (schedulingChanged || variantChanged) && effNewDate && effNewStartHour != null && effNewLaneId) {
      newSnap = await resolveLaneSnapshot(
        ctx,
        effNewLaneId,
        (cleanUpdates as any).variantId ?? (existing as any).variantId,
        effNewDate,
        effNewStartHour
      );
      (cleanUpdates as any).laneNameSnapshot = newSnap.laneNameSnapshot;
      (cleanUpdates as any).variantLabelSnapshot = newSnap.variantLabelSnapshot;
    }

    await ctx.db.patch(id, cleanUpdates);

    // Analytics (WS-C live feed) — record the admin modify. Was MISSING entirely, so
    // admin booking edits never appeared in the Activity / live feed.
    if (existing && eventAffected) {
      await recordBookingEvent(ctx, {
        type: "modified",
        bookingId: id.toString(),
        customerName: (cleanUpdates as any).customerName ?? (existing as any).customerName ?? "Unknown",
        actorName: (adminUser as any)?.name ?? (adminUser as any)?.email ?? "Admin",
        isCoachBooking: (existing as any).isCoachBooking,
        before: {
          date: (existing as any).date,
          startHour: (existing as any).startHour,
          duration: (existing as any).duration,
          lane: (existing as any).laneNameSnapshot ?? (existing as any).laneId ?? "",
          variant: (existing as any).variantLabelSnapshot ?? undefined,
        },
        after: {
          date: effNewDate,
          startHour: effNewStartHour,
          duration: effNewDuration,
          lane: newSnap?.laneNameSnapshot ?? (cleanUpdates as any).laneNameSnapshot ?? (existing as any).laneNameSnapshot ?? defaultLaneName(effNewLaneId),
          variant: newSnap?.variantLabelSnapshot ?? (existing as any).variantLabelSnapshot ?? undefined,
        },
      });
    }

    // Google Calendar resync — broadened from "scheduling only" to ANY event-affecting
    // change, and now UPDATES the event IN PLACE when the lane set is unchanged; only a
    // real lane MOVE does delete+create. Mirrors applyBookingChange and passes the
    // recomputed snapshot so the event name is correct. (Old code: always delete+create
    // on a scheduling change, never re-synced a variant/name edit, never passed the
    // snapshot — which left a stale name and, on a lane swap, an orphaned delete.)
    if (existing && eventAffected && effNewDate && effNewStartHour != null && effNewDuration != null && effNewLaneId) {
      const hadEvents =
        !!(existing as any).googleCalendarEventId ||
        (Array.isArray((existing as any).googleCalendarEventIds) && (existing as any).googleCalendarEventIds.length > 0);
      const calSlots = ((cleanUpdates as any).athleteSlots ?? (existing as any).athleteSlots ?? []).map((s: any) => ({
        athleteName: s.athleteName,
        startHour: s.startHour,
        durationMinutes: s.durationMinutes,
      }));
      const calArgs = {
        laneId: effNewLaneId,
        variantId: (cleanUpdates as any).variantId ?? (existing as any).variantId,
        date: effNewDate,
        startHour: effNewStartHour,
        duration: effNewDuration,
        customerName: (cleanUpdates as any).customerName ?? (existing as any).customerName,
        customerEmail: (cleanUpdates as any).customerEmail ?? (existing as any).customerEmail,
        customerPhone: (cleanUpdates as any).customerPhone ?? (existing as any).customerPhone,
        status: (cleanUpdates as any).status ?? (existing as any).status,
        isCoachBooking: (existing as any).isCoachBooking,
        accessCode: (cleanUpdates as any).accessCode ?? (existing as any).accessCode,
        additionalLaneIds: effNewAdditionalLanes,
        athleteSlots: calSlots,
        laneNameSnapshot: (cleanUpdates as any).laneNameSnapshot ?? (existing as any).laneNameSnapshot,
        variantLabelSnapshot: (cleanUpdates as any).variantLabelSnapshot ?? (existing as any).variantLabelSnapshot,
      };
      const oldKey = [(existing as any).laneId, ...(((existing as any).additionalLaneIds ?? []) as string[])].slice().sort().join(",");
      const newKey = [effNewLaneId, ...effNewAdditionalLanes].slice().sort().join(",");
      const laneSetChanged = oldKey !== newKey;

      if (hadEvents && !laneSetChanged) {
        await ctx.scheduler.runAfter(0, internal.googleCalendar.updateCalendarEvent, {
          googleCalendarEventId: (existing as any).googleCalendarEventId ?? "",
          laneCalendarEventIds: (existing as any).googleCalendarEventIds,
          ...calArgs,
        });
      } else {
        if (hadEvents) {
          await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
            googleCalendarEventId: (existing as any).googleCalendarEventId ?? "",
            laneCalendarEventIds: (existing as any).googleCalendarEventIds,
          });
          // CAL-4 (audit 2026-06-23): on a lane MOVE, clear the stale ids before the
          // create below — otherwise setBookingLaneCalendarEventIds MERGES the new
          // lane's entry alongside the now-deleted old-lane entry (stale id + 404s
          // on later syncs). applyBookingChange already does this; updateBooking didn't.
          if (laneSetChanged) {
            await ctx.db.patch(id, { googleCalendarEventId: undefined, googleCalendarEventIds: undefined });
          }
        }
        await ctx.scheduler.runAfter(500, internal.googleCalendar.createCalendarEvent, {
          bookingId: id.toString(),
          ...calArgs,
        });
      }
    }

    // Customer notification — only on a genuine reschedule (date/time/lane/duration).
    if (schedulingChanged && existing && effNewDate && effNewStartHour != null && effNewDuration != null && effNewLaneId) {
      const fmtTUpd = (h: number) => {
        const w = Math.floor(h); const m = Math.round((h - w) * 60);
        const p = w >= 12 ? "PM" : "AM"; const dh = w > 12 ? w - 12 : w === 0 ? 12 : w;
        return `${dh}:${m.toString().padStart(2, "0")} ${p}`;
      };
      const fmtDUpd = (d: number) => d === 60 ? "1 hour" : d === 90 ? "1.5 hours" : d === 30 ? "30 minutes" : `${d} min`;
      const notifyEmail = ((cleanUpdates as any).customerEmail ?? (existing as any).customerEmail ?? "") as string;

      if (notifyEmail) {
        await ctx.scheduler.runAfter(0, internal.emails.sendBookingRescheduled, {
          to: notifyEmail,
          customerName: (cleanUpdates as any).customerName ?? (existing as any).customerName ?? "Valued Customer",
          oldLaneName: (existing as any).laneNameSnapshot || defaultLaneName((existing as any).laneId),
          oldDate: (existing as any).date,
          oldTimeSlot: fmtTUpd((existing as any).startHour),
          newLaneName: newSnap?.laneNameSnapshot ?? defaultLaneName(effNewLaneId),
          newDate: effNewDate,
          newTimeSlot: fmtTUpd(effNewStartHour),
          newDuration: fmtDUpd(effNewDuration),
          accessCode: (cleanUpdates as any).accessCode ?? (existing as any).accessCode ?? "",
        });
        // SPEC_PWA_PUSH §5.1 — booking change push (customer bookings only).
        if (!(existing as any).isCoachBooking) {
          await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
            email: notifyEmail,
            category: "booking-changes",
            title: "Booking updated",
            body: `${newSnap?.laneNameSnapshot ?? defaultLaneName(effNewLaneId)} · ${fmtAwstDateLabel(effNewDate)}, ${fmtTUpd(effNewStartHour)}`,
            url: "/bookings",
            tag: `booking-${id.toString()}`,
          });
        }
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
    const cancelCallerCustomer = callerEmail
      ? await ctx.db
          .query("customers")
          .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
          .first()
      : null;
    const cancelIsAdmin = cancelCallerCustomer?.role === "admin";
    if (!isOwner && !cancelIsAdmin) {
      throw new ConvexError("You can only cancel your own bookings.");
    }
    // SPEC_SCHEDULE_DAY_VIEW §2.13: an admin-managed coach booking can't be
    // cancelled by the coach (or anyone non-admin) — they allocate only.
    if ((booking as any).createdByAdmin && !cancelIsAdmin) {
      throw new ConvexError("This booking is managed by admin — please contact admin.");
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

    // Once a session has STARTED it can no longer be cancelled retrospectively by
    // the customer OR the coach — only an admin can (no-show / clean-up handling).
    // "Begun" = the start time has been reached. Mirrors the modifyBooking
    // `hoursUntilOriginal <= 0` guard so cancel + modify behave consistently.
    if (hoursUntil <= 0 && !cancelIsAdmin) {
      throw new ConvexError("This session has already started and can no longer be cancelled.");
    }

    // Time-based policy enforcement for customer bookings
    if (!booking.isCoachBooking) {
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
    if (booking.isCoachBooking) {
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

    // WS-C live feed: record the cancel event (booking.* holds the cancelled slot).
    await recordBookingEvent(ctx, {
      type: "cancelled",
      bookingId: args.id.toString(),
      customerName: booking.customerName ?? "Unknown",
      isCoachBooking: booking.isCoachBooking,
      after: {
        date: booking.date,
        startHour: booking.startHour,
        duration: booking.duration,
        lane: booking.laneNameSnapshot ?? booking.laneId ?? "",
        variant: booking.variantLabelSnapshot ?? undefined,
      },
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

    // Sync cancellation to Google Calendar. CAL-3 (audit 2026-06-23): gate on
    // PRIMARY *or* per-lane ids — a partially-synced multi-lane booking can have
    // per-lane events with no primary id; gating on the primary alone left those
    // events orphaned on the lane calendar after cancel (HA still powers the
    // machine / loads the code for a ghost session). deleteCalendarEvent deletes
    // every per-lane event from laneCalendarEventIds.
    if (booking.googleCalendarEventId || (booking.googleCalendarEventIds?.length ?? 0) > 0) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
        googleCalendarEventId: booking.googleCalendarEventId ?? "",
        laneCalendarEventIds: booking.googleCalendarEventIds,
      });
    }

    // Send cancellation confirmation email
    if (booking.customerEmail) {
      const whole = Math.floor(booking.startHour);
      const mins = Math.round((booking.startHour - whole) * 60);
      const period = whole >= 12 ? "PM" : "AM";
      const displayHour = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
      const timeSlot = `${displayHour}:${mins.toString().padStart(2, "0")} ${period}`;
      const durationLabel = booking.duration === 60 ? "1 hour" : booking.duration === 90 ? "1.5 hours" : booking.duration === 30 ? "30 minutes" : `${booking.duration} min`;

      await ctx.scheduler.runAfter(0, internal.emails.sendBookingCancellation, {
        to: booking.customerEmail,
        customerName: booking.customerName || "Valued Customer",
        laneName: booking.laneNameSnapshot || defaultLaneName(booking.laneId),
        date: booking.date,
        timeSlot,
        duration: durationLabel,
      });
      // SPEC_PWA_PUSH §5.1 — booking cancellation push (customer), only when
      // cancelled by admin/system (not the customer themselves).
      const selfCancel = args.cancelledByUserId != null && args.cancelledByUserId === booking.userId;
      if (!booking.isCoachBooking && !selfCancel) {
        await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
          email: booking.customerEmail,
          category: "booking-changes",
          title: "Booking cancelled",
          body: `${booking.laneNameSnapshot || defaultLaneName(booking.laneId)} · ${fmtAwstDateLabel(booking.date)}, ${timeSlot}`,
          url: "/bookings",
          tag: `booking-${args.id.toString()}`,
        });
      }
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

    // Weekly billing cap (2026-07): a cancelled coach session removes charge from
    // the week (unless it's a late-cancel that's still billed) — re-cap it so the
    // cap credit shrinks/clears (no-op for uncapped coaches).
    if (booking.isCoachBooking) {
      await scheduleCapReconcileForBooking(ctx, booking.customerEmail, booking.date);
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

      // DI-7: Clean up Google Calendar event. CAL-3: gate on PRIMARY *or* per-lane
      // ids so a partially-synced multi-lane booking doesn't leave orphaned events.
      if ((delBooking as any).googleCalendarEventId || (((delBooking as any).googleCalendarEventIds?.length ?? 0) > 0)) {
        await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
          googleCalendarEventId: (delBooking as any).googleCalendarEventId ?? "",
          laneCalendarEventIds: (delBooking as any).googleCalendarEventIds,
        });
      }

      // DI-7: Send cancellation email to customer
      if (delBooking.customerEmail && delBooking.status !== "cancelled") {
        const whole = Math.floor(delBooking.startHour);
        const mins = Math.round((delBooking.startHour - whole) * 60);
        const period = whole >= 12 ? "PM" : "AM";
        const displayHour = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
        const timeSlot = `${displayHour}:${mins.toString().padStart(2, "0")} ${period}`;
        const durationLabel = delBooking.duration === 60 ? "1 hour" : delBooking.duration === 90 ? "1.5 hours" : delBooking.duration === 30 ? "30 minutes" : `${delBooking.duration} min`;
        await ctx.scheduler.runAfter(0, internal.emails.sendBookingCancellation, {
          to: delBooking.customerEmail,
          customerName: delBooking.customerName || "Valued Customer",
          laneName: delBooking.laneNameSnapshot || defaultLaneName(delBooking.laneId),
          date: delBooking.date,
          timeSlot,
          duration: durationLabel,
        });
        // SPEC_PWA_PUSH §5.1 — admin deleted the booking (customer bookings).
        if (!delBooking.isCoachBooking) {
          await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
            email: delBooking.customerEmail,
            category: "booking-changes",
            title: "Booking cancelled",
            body: `${delBooking.laneNameSnapshot || defaultLaneName(delBooking.laneId)} · ${fmtAwstDateLabel(delBooking.date)}, ${timeSlot}`,
            url: "/bookings",
            tag: `booking-${args.id.toString()}`,
          });
        }
      }
    }

    await ctx.db.delete(args.id);
    return args.id;
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
    // SPEC_SCHEDULE_DAY_VIEW §2.13: admin-managed coach bookings are view+allocate
    // only for the coach — non-admin modify is rejected.
    if ((booking as any).createdByAdmin && !isAdmin) {
      throw new ConvexError("This booking is managed by admin — please contact admin.");
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
    // BUGM-1 (audit 2026-06): read the day once + test each booking's FULL lane set
    // (primary + additionalLaneIds) so a modify onto a lane held via another booking's
    // additionalLaneIds is caught (the old per-lane by_laneId_date scan missed it).
    const dayBookingsMod = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", effDate))
      .collect();
    const occMod = (b: any, lid: string) =>
      b.laneId === lid || ((b.additionalLaneIds as string[]) ?? []).includes(lid);
    for (const lid of allNewLaneIds) {
      const conflict = dayBookingsMod.some((b: any) => {
        if (b._id === args.id || b.status === "cancelled") return false;
        if (!occMod(b, lid)) return false;
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

    // SPEC_RECONFIGURABLE_LANES: the new slot's variant must be offered by the
    // resolved segment, and the booking may not cross a segment boundary (§2.14).
    await validateAndSnapshotLane(ctx, {
      laneId: effLane,
      variantId: effVariant,
      date: effDate,
      startHour: effStart,
      durationMinutes: effDuration,
      skipVariantCheck: isCoach || isAdmin,
    });

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
      // C2: coach price is per-hour (matches createBooking + the client preview).
      // M6: per-lane (primary + additional lanes), like createBooking.
      const coachPerHour = settings?.coachPerHour ?? PRICE_DEFAULTS.coachPerHour;
      const coachLaneCount = 1 + (effAddl?.length ?? 0);
      newCoachPrice = Math.round((effDuration / 60) * coachPerHour * coachLaneCount * 100) / 100;
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
  // E3: only today-and-future bookings can hold a LIVE code — read the by_date range
  // instead of scanning the whole (ever-growing) table on this booking-write path.
  const all = await ctx.db
    .query("bookings")
    .withIndex("by_date", (q: any) => q.gte("date", todayKey))
    .collect();
  const set = new Set<string>();
  for (const b of all) {
    if (b.status === "cancelled") continue;
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

// ── Admin: set a SPECIFIC front-door code on a booking (per-booking + bulk) ──────
// Lets an admin override the auto-generated PIN with a chosen code (e.g. one
// memorable recurring code for a coach) and PUSH it to Google Calendar so HA loads
// it. The C3 client-code ban (customers can't pick their own PIN) does NOT apply
// here — these are admin-gated (requireAdmin), so a verified admin is trusted.
// Lightweight vs modifyBooking: changes ONLY the code + resyncs the calendar — no
// price / email / waitlist side-effects, so it's safe to run across many bookings.
// For a booking that never synced (e.g. migrated), the resync CREATES the event.
function validateAdminDoorCode(raw: string, reserved: Set<string>): string {
  const code = (raw ?? "").trim();
  if (!/^\d{4,6}$/.test(code)) {
    throw new ConvexError("Door code must be 4 to 6 digits.");
  }
  if (reserved.has(code)) {
    throw new ConvexError(`${code} is a reserved staff code — choose a different code.`);
  }
  return code;
}

async function applyDoorCodeChange(
  ctx: any,
  booking: any,
  code: string,
  delayMs = 0
): Promise<void> {
  // Athletes share the booking's single front-door code.
  const newSlots = (booking.athleteSlots ?? []).map((s: any) => ({
    ...s,
    accessCode: code,
    codeGeneratedAt: new Date().toISOString(),
  }));
  await ctx.db.patch(booking._id, {
    accessCode: code,
    ...(booking.athleteSlots ? { athleteSlots: newSlots } : {}),
  });

  const calStatus = booking.status === "pending_edit_payment" ? "confirmed" : booking.status;
  const calAthleteSlots = newSlots.map((s: any) => ({
    athleteName: s.athleteName,
    startHour: s.startHour,
    durationMinutes: s.durationMinutes,
  }));
  const hadEvents =
    !!booking.googleCalendarEventId ||
    (Array.isArray(booking.googleCalendarEventIds) && booking.googleCalendarEventIds.length > 0);

  if (hadEvents) {
    await ctx.scheduler.runAfter(delayMs, internal.googleCalendar.updateCalendarEvent, {
      googleCalendarEventId: booking.googleCalendarEventId ?? "",
      laneId: booking.laneId,
      variantId: booking.variantId,
      date: booking.date,
      startHour: booking.startHour,
      duration: booking.duration,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      status: calStatus,
      isCoachBooking: booking.isCoachBooking,
      accessCode: code,
      additionalLaneIds: booking.additionalLaneIds,
      athleteSlots: calAthleteSlots,
      laneCalendarEventIds: booking.googleCalendarEventIds,
      laneNameSnapshot: booking.laneNameSnapshot,
      variantLabelSnapshot: booking.variantLabelSnapshot,
    });
  } else {
    await ctx.scheduler.runAfter(delayMs, internal.googleCalendar.createCalendarEvent, {
      bookingId: booking._id.toString(),
      laneId: booking.laneId,
      variantId: booking.variantId,
      date: booking.date,
      startHour: booking.startHour,
      duration: booking.duration,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      status: calStatus,
      isCoachBooking: booking.isCoachBooking,
      accessCode: code,
      additionalLaneIds: booking.additionalLaneIds,
      athleteSlots: calAthleteSlots,
      laneNameSnapshot: booking.laneNameSnapshot,
      variantLabelSnapshot: booking.variantLabelSnapshot,
    });
  }
}

export const adminSetBookingDoorCode = mutation({
  args: { bookingId: v.id("bookings"), code: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const code = validateAdminDoorCode(args.code, await getReservedCodes(ctx));
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new ConvexError("Booking not found.");
    if ((booking as any).status === "cancelled") {
      throw new ConvexError("This booking is cancelled.");
    }
    await applyDoorCodeChange(ctx, booking, code);
    return { ok: true, code };
  },
});

export const adminBulkSetBookingDoorCode = mutation({
  args: { bookingIds: v.array(v.id("bookings")), code: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const code = validateAdminDoorCode(args.code, await getReservedCodes(ctx));
    let updated = 0;
    let skipped = 0;
    let i = 0;
    for (const id of args.bookingIds) {
      const booking = await ctx.db.get(id);
      if (!booking || (booking as any).status === "cancelled") {
        skipped++;
        continue;
      }
      // Stagger calendar writes so a large batch doesn't burst the Google API.
      await applyDoorCodeChange(ctx, booking, code, i * 600);
      updated++;
      i++;
    }
    return { ok: true, code, updated, skipped };
  },
});

// Upcoming (today-onward) confirmed bookings for one customer — powers the bulk
// "apply this code to all of [customer]'s upcoming bookings" admin action.
export const adminListCustomerUpcomingBookings = query({
  args: { email: v.string(), fromDate: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const todayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const from = args.fromDate ?? todayKey;
    const email = (args.email ?? "").toLowerCase().trim();
    if (!email) return [];
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.gte("date", from))
      .collect();
    return rows
      .filter(
        (b: any) =>
          b.status !== "cancelled" && (b.customerEmail ?? "").toLowerCase() === email
      )
      .map((b: any) => ({
        id: b._id,
        date: b.date,
        startHour: b.startHour,
        lane: b.laneNameSnapshot ?? b.laneId ?? "",
        accessCode: b.accessCode ?? null,
      }))
      .sort((a: any, b: any) => a.date.localeCompare(b.date) || a.startHour - b.startHour);
  },
});

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

    // Validate athlete slots fit within booking window.
    // SPEC_COACH_SESSION_LENGTH §2.3: floor is a fixed 30 minutes (the global
    // "Min athlete slot" admin setting is retired). Allocation options are
    // {30,45,60,75,90}; legacy sub-30 slots snap up on their next edit.
    const minAthleteMins = 30;
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

    // SPEC_ANALYTICS_ATHLETE_CATCHMENT: snapshot each athlete's home suburb.
    const finalSlotsWithSuburbs = await attachAthleteSuburbs(ctx, finalSlots);
    await ctx.db.patch(args.id, {
      athleteSlots: finalSlotsWithSuburbs,
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
      // SPEC_PWA_PUSH §5.1 — coach allocation alert. Only when someone OTHER than
      // the coach (i.e. an admin) allocated to their session — a coach allocating
      // their own athletes doesn't need a push to themselves.
      if (!aIsOwner && booking.customerEmail) {
        await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
          email: booking.customerEmail,
          category: "coach-allocation",
          title: "Athletes allocated to your session",
          body: `${(booking.laneNameSnapshot || defaultLaneName(booking.laneId))} · ${fmtAwstDateLabel(booking.date)} — ${changedSlots.length} athlete${changedSlots.length === 1 ? "" : "s"}`,
          url: "/bookings",
          tag: `coachalloc-${args.id.toString()}`,
        });
      }
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

    // Push the new athlete list to Google Calendar so HA/staff see the right
    // athletes + per-slot times. CAL-2 (audit 2026-06-23): mirror the door-code
    // editor's gold-standard pattern — UPDATE in place when an event exists (by
    // PRIMARY or per-lane id), but CREATE one when the booking has no event yet (a
    // migrated booking, or one whose async create silently failed). The old code
    // gated on the primary id only, so re-allocating athletes on such a booking did
    // nothing to the calendar (stale/empty athlete list in HA, never self-created).
    const calAthleteSlots = finalSlots.map((s) => ({
      athleteName: s.athleteName,
      startHour: s.startHour,
      durationMinutes: s.durationMinutes,
    }));
    const hadEvents =
      !!booking.googleCalendarEventId ||
      (Array.isArray(booking.googleCalendarEventIds) && booking.googleCalendarEventIds.length > 0);
    if (hadEvents) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.updateCalendarEvent, {
        googleCalendarEventId: booking.googleCalendarEventId ?? "",
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
        athleteSlots: calAthleteSlots,
        laneCalendarEventIds: booking.googleCalendarEventIds,
        laneNameSnapshot: booking.laneNameSnapshot,
        variantLabelSnapshot: booking.variantLabelSnapshot,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.createCalendarEvent, {
        bookingId: booking._id.toString(),
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
        athleteSlots: calAthleteSlots,
        laneNameSnapshot: booking.laneNameSnapshot,
        variantLabelSnapshot: booking.variantLabelSnapshot,
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
// ----------------------------------------------------------------------------
// Shared per-session coach-copy helpers (used by repeatCoachBooking).
// analyze = READ-ONLY (also backs the preview query); write = performs the insert.
// ----------------------------------------------------------------------------

type CoachCopyAnalysis = {
  status: "ok" | "blocked" | "duplicate";
  reason?: string;
  // Source slots that survive the roster check (no door code yet — minted at write time).
  keptSlots: Array<{
    athleteId?: any;
    athleteName: string;
    startHour: number;
    durationMinutes: number;
  }>;
  droppedCount: number;
  laneNameSnapshot: string;
  variantLabelSnapshot: string;
};

// Decide whether a source coach session can be cloned to targetDate, and which
// athlete slots survive (athletes no longer on the coach's roster are dropped).
// Pure read — safe to call from a query.
async function analyzeCoachSessionCopy(
  ctx: any,
  opts: { src: any; coach: any; targetDate: string; dailyHours: any; coachIdForms: Set<string> }
): Promise<CoachCopyAnalysis> {
  const { src, coach, targetDate, dailyHours, coachIdForms } = opts;
  const lanes: string[] = [src.laneId, ...(src.additionalLaneIds ?? [])];
  const endHour = src.startHour + src.duration / 60;

  const snap = await resolveLaneSnapshot(ctx, src.laneId, src.variantId, targetDate, src.startHour);
  const baseRet = {
    keptSlots: [] as CoachCopyAnalysis["keptSlots"],
    droppedCount: 0,
    laneNameSnapshot: snap.laneNameSnapshot,
    variantLabelSnapshot: snap.variantLabelSnapshot,
  };

  // Closure day?
  const closure = await ctx.db
    .query("closures")
    .withIndex("by_date", (q: any) => q.eq("date", targetDate))
    .first();
  if (closure) return { ...baseRet, status: "blocked", reason: "facility closed that day" };

  // Operating hours for that weekday (if configured).
  if (dailyHours) {
    const [ty, tm, td] = targetDate.split("-").map(Number);
    const dow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay();
    const dh = dailyHours[DAY_KEYS[dow]];
    if (dh && (dh.closed || src.startHour < dh.open || endHour > dh.close)) {
      return { ...baseRet, status: "blocked", reason: "outside operating hours" };
    }
  }

  // Lane availability (booking overlap + service blocks) + idempotency.
  let blocked = false;
  let duplicate = false;
  // BUGM-1 (audit 2026-06): read the day once + test each booking's FULL lane set so a
  // coach-session copy isn't placed on a lane already held via another booking's
  // additionalLaneIds (the old per-lane by_laneId_date scan missed multi-lane holders).
  const dayBookingsCopy = await ctx.db
    .query("bookings")
    .withIndex("by_date", (q: any) => q.eq("date", targetDate))
    .collect();
  const occCopy = (b: any, lid: string) =>
    b.laneId === lid || ((b.additionalLaneIds as string[]) ?? []).includes(lid);
  for (const lid of lanes) {
    const laneBookings = dayBookingsCopy.filter((b: any) => occCopy(b, lid));
    for (const b of laneBookings) {
      if (b.status === "cancelled") continue;
      const bEnd = b.startHour + b.duration / 60;
      const overlaps = src.startHour < bEnd && endHour > b.startHour;
      if (!overlaps) continue;
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
  if (duplicate) return { ...baseRet, status: "duplicate", reason: "already copied" };
  if (blocked) return { ...baseRet, status: "blocked", reason: "slot already booked or blocked" };

  // Roster check — keep only athletes still assigned to this coach.
  let droppedCount = 0;
  const keptSlots: CoachCopyAnalysis["keptSlots"] = [];
  for (const s of src.athleteSlots ?? []) {
    if (s.athleteId) {
      const athlete: any = await ctx.db.get(s.athleteId as any);
      const stillAssigned = athlete && (athlete.assignedCoachIds ?? []).some((c: string) => coachIdForms.has(c));
      if (!stillAssigned) {
        droppedCount++;
        continue;
      }
    }
    keptSlots.push({
      athleteId: s.athleteId,
      athleteName: s.athleteName,
      startHour: s.startHour,
      durationMinutes: s.durationMinutes,
    });
  }

  return { ...baseRet, status: "ok", keptSlots, droppedCount };
}

// Perform the clone for a session that analysis returned "ok": mint a door code,
// insert the booking, schedule allocation emails + audit + Google Calendar sync.
// Returns the new booking id.
async function writeCoachSessionCopy(
  ctx: any,
  opts: {
    src: any;
    coach: any;
    targetDate: string;
    coachPerHour: number;
    analysis: CoachCopyAnalysis;
    existingCodes: Set<string>;
    reserved?: Set<string>;
    actorUserId?: string;
    actorName?: string;
  }
): Promise<string> {
  const { src, coach, targetDate, coachPerHour, analysis, existingCodes, reserved } = opts;
  const newCode = generateServerAccessCode(existingCodes, reserved);
  const nowIso = new Date().toISOString();
  const copiedSlots = analysis.keptSlots.map((s) => ({
    athleteId: s.athleteId,
    athleteName: s.athleteName,
    startHour: s.startHour,
    durationMinutes: s.durationMinutes,
    accessCode: newCode,
    codeGeneratedAt: nowIso,
  }));
  // SPEC_ANALYTICS_ATHLETE_CATCHMENT: snapshot each athlete's home suburb.
  const copiedSlotsWithSuburbs = (await attachAthleteSuburbs(ctx, copiedSlots)) ?? [];

  // M6: per-lane — the copy carries src.additionalLaneIds below, so price all lanes.
  const copyLaneCount = 1 + ((src.additionalLaneIds as any[])?.length ?? 0);
  const newCoachPrice = Math.round((src.duration / 60) * coachPerHour * copyLaneCount * 100) / 100;
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
    athleteSlots: copiedSlotsWithSuburbs.length > 0 ? copiedSlotsWithSuburbs : undefined,
    accessCode: newCode,
    laneNameSnapshot: analysis.laneNameSnapshot,
    variantLabelSnapshot: analysis.variantLabelSnapshot,
    createdAt: Date.now(), // §6.2 admin digest windowing
  } as any);

  // WS-C live feed: record the repeat (created) event.
  await recordBookingEvent(ctx, {
    type: "created",
    bookingId: newId.toString(),
    customerName: coach.name,
    actorName: coach.name,
    isCoachBooking: true,
    after: {
      date: targetDate,
      startHour: src.startHour,
      duration: src.duration,
      lane: analysis.laneNameSnapshot,
      variant: analysis.variantLabelSnapshot ?? undefined,
    },
  });

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
      actorUserId: opts.actorUserId ?? coach._id,
      actorName: opts.actorName ?? coach.name,
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
    // CAL-5 (audit 2026-06-23): thread the target-date snapshot so a repeated
    // session's event title shows the right lane name if the lane was reconfigured
    // (BM↔RU / override) at the target date — every other create call passes these.
    laneNameSnapshot: analysis.laneNameSnapshot,
    variantLabelSnapshot: analysis.variantLabelSnapshot,
  });

  return newId.toString();
}

// ----------------------------------------------------------------------------
// Per-booking Repeat (SPEC_COACH_PLANNER_RETIRE_AND_VIEW §5). Repeats a single
// coach session + its allocations into the same weekday/time/lane +7 days.
// Frontend strictly gates the button by the coach's booking window (L1/L2), so
// the server only does a conflict-skip check (no booking-horizon carve-out).
// ----------------------------------------------------------------------------

// Shared loader/auth for both the preview query and the repeat mutation.
async function loadCoachBookingForRepeat(
  ctx: any,
  bookingId: any
): Promise<{ src: any; coach: any; callerCustomer: any; targetDate: string }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Authentication required.");
  const callerEmail = identity.email?.toLowerCase().trim() ?? "";

  const src: any = await ctx.db.get(bookingId);
  if (!src || !src.isCoachBooking) throw new ConvexError("Coach booking not found.");
  if (src.status === "cancelled") throw new ConvexError("Cannot repeat a cancelled booking.");

  const coach: any = await ctx.db
    .query("customers")
    .withIndex("by_email", (q: any) => q.eq("email", src.customerEmail.toLowerCase().trim()))
    .first();
  if (!coach || coach.role !== "coach") throw new ConvexError("Coach not found.");

  const callerCustomer = callerEmail
    ? await ctx.db.query("customers").withIndex("by_email", (q: any) => q.eq("email", callerEmail)).first()
    : null;
  const isAdmin = callerCustomer?.role === "admin";
  if (!isAdmin && coach.email.toLowerCase() !== callerEmail) {
    throw new ConvexError("You can only repeat your own bookings.");
  }
  // SPEC_SCHEDULE_DAY_VIEW §2.13: an admin-managed coach booking can't be repeated
  // by the coach. (The UI hides Repeat too; this is the server gate.)
  if (src.createdByAdmin && !isAdmin) {
    throw new ConvexError("This booking is managed by admin — please contact admin.");
  }

  return { src, coach, callerCustomer, targetDate: addDaysKey(src.date, 7) };
}

// Read-only preview for the confirm modal: the single target session + its
// resolved (roster-checked) allocations + any block/drop note.
export const previewRepeatCoachBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const { src, coach } = await loadCoachBookingForRepeat(ctx, args.bookingId);
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const dailyHours: any = (settings as any)?.dailyHours;
    const coachIdForms = new Set<string>([coach._id as string, coach.email]);

    const analysis = await analyzeCoachSessionCopy(ctx, {
      src,
      coach,
      targetDate: src && addDaysKey(src.date, 7),
      dailyHours,
      coachIdForms,
    });
    const targetDate = addDaysKey(src.date, 7);

    return {
      sourceDate: src.date,
      targetDate,
      startHour: src.startHour,
      duration: src.duration,
      laneId: src.laneId,
      variantId: src.variantId,
      laneNameSnapshot: analysis.laneNameSnapshot,
      variantLabelSnapshot: analysis.variantLabelSnapshot,
      status: analysis.status, // "ok" | "blocked" | "duplicate"
      reason: analysis.reason,
      droppedCount: analysis.droppedCount,
      allocations: analysis.keptSlots.map((s) => ({
        athleteName: s.athleteName,
        startHour: s.startHour,
        durationMinutes: s.durationMinutes,
      })),
    };
  },
});

export const repeatCoachBooking = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const { src, coach, callerCustomer } = await loadCoachBookingForRepeat(ctx, args.bookingId);
    const targetDate = addDaysKey(src.date, 7);

    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const coachPerHour = (settings as any)?.coachPerHour ?? PRICE_DEFAULTS.coachPerHour;
    const dailyHours: any = (settings as any)?.dailyHours;
    const coachIdForms = new Set<string>([coach._id as string, coach.email]);

    const analysis = await analyzeCoachSessionCopy(ctx, {
      src,
      coach,
      targetDate,
      dailyHours,
      coachIdForms,
    });
    if (analysis.status !== "ok") {
      throw new ConvexError(
        analysis.status === "duplicate"
          ? "That session is already booked next week."
          : `Can't repeat: ${analysis.reason}.`
      );
    }

    // Seed the in-use code set from live bookings + honour reserved staff codes.
    const existingCodes = await collectActiveAccessCodes(ctx);
    const reserved = await getReservedCodes(ctx);
    const newBookingId = await writeCoachSessionCopy(ctx, {
      src,
      coach,
      targetDate,
      coachPerHour,
      analysis,
      existingCodes,
      reserved,
      actorUserId: callerCustomer?._id ?? coach._id,
      actorName: coach.name,
    });

    return {
      bookingId: newBookingId,
      targetDate,
      droppedCount: analysis.droppedCount,
    };
  },
});

// ----------------------------------------------------------------------------
// Multi-date Repeat (admin) — copy a coach session onto an ARBITRARY set of
// picked dates in one go (irregular programs the +7 repeat can't express).
// Reuses analyzeCoachSessionCopy + writeCoachSessionCopy per date; conflicts /
// closures / out-of-hours are skipped and reported, never thrown. Auth = the
// same coach-owner-OR-admin gate as the single repeat; the UI only exposes this
// to admins (it deliberately bypasses the coach booking-window gating).
// ----------------------------------------------------------------------------

export const previewRepeatCoachBookingToDates = query({
  args: { bookingId: v.id("bookings"), dates: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { src, coach } = await loadCoachBookingForRepeat(ctx, args.bookingId);
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const dailyHours: any = (settings as any)?.dailyHours;
    const coachIdForms = new Set<string>([coach._id as string, coach.email]);

    const seen = new Set<string>();
    const results: Array<{ date: string; status: string; reason?: string; droppedCount: number }> = [];
    for (const date of [...args.dates].sort()) {
      if (date === src.date) { results.push({ date, status: "duplicate", reason: "source date", droppedCount: 0 }); continue; }
      if (seen.has(date)) continue;
      seen.add(date);
      const a = await analyzeCoachSessionCopy(ctx, { src, coach, targetDate: date, dailyHours, coachIdForms });
      results.push({ date, status: a.status, reason: a.reason, droppedCount: a.droppedCount });
    }
    return {
      sourceDate: src.date,
      startHour: src.startHour,
      duration: src.duration,
      laneNameSnapshot: src.laneNameSnapshot ?? null,
      laneCount: 1 + (src.additionalLaneIds?.length ?? 0),
      results,
    };
  },
});

export const repeatCoachBookingToDates = mutation({
  args: { bookingId: v.id("bookings"), dates: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.dates.length === 0) throw new ConvexError("Pick at least one date.");
    if (args.dates.length > 60) throw new ConvexError("Too many dates (max 60 per repeat).");
    const { src, coach, callerCustomer } = await loadCoachBookingForRepeat(ctx, args.bookingId);

    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const coachPerHour = (settings as any)?.coachPerHour ?? PRICE_DEFAULTS.coachPerHour;
    const dailyHours: any = (settings as any)?.dailyHours;
    const coachIdForms = new Set<string>([coach._id as string, coach.email]);
    const existingCodes = await collectActiveAccessCodes(ctx);
    const reserved = await getReservedCodes(ctx);

    const createdIds: string[] = [];
    const skipped: Array<{ date: string; reason: string }> = [];
    let droppedTotal = 0;
    // Chronological, deduped. Each created booking is inserted before the next
    // analysis runs, so generateServerAccessCode + the conflict read stay consistent.
    for (const date of [...new Set(args.dates)].sort()) {
      if (date === src.date) { skipped.push({ date, reason: "source date" }); continue; }
      const a = await analyzeCoachSessionCopy(ctx, { src, coach, targetDate: date, dailyHours, coachIdForms });
      if (a.status !== "ok") { skipped.push({ date, reason: a.reason ?? a.status }); continue; }
      const id = await writeCoachSessionCopy(ctx, {
        src, coach, targetDate: date, coachPerHour, analysis: a,
        existingCodes, reserved,
        actorUserId: callerCustomer?._id ?? coach._id,
        actorName: coach.name,
      });
      createdIds.push(id);
      droppedTotal += a.droppedCount;
    }
    return { createdCount: createdIds.length, createdIds, skipped, droppedTotal };
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
    coachesSimultaneously: v.optional(v.boolean()),
    athleteCapacity: v.optional(v.number()),
    bookingEmailsEnabled: v.optional(v.boolean()),
    emailNotificationsEnabled: v.optional(v.boolean()), // Bug 7: master email switch
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
      // creditBalance, athleteCapacity) so a customer can't self-promote to admin
      // or grant themselves credit via this path.
      if (!updIsAdminCaller) {
        delete (updates as any).role;
        delete (updates as any).coachTier;
        delete (updates as any).assignedCoachIds;
        delete (updates as any).creditBalance;
        delete (updates as any).athleteCapacity;
        // SPEC_COACH_SESSION_LENGTH §2.2: a coach MAY self-edit their own
        // defaultSessionDuration (session-length preference). Everyone else
        // (and athleteCapacity, which stays admin-managed) is still stripped.
        const editingOwnCoachRecord =
          updCallerEmail === normalizedEmail && (existing as any).role === "coach";
        if (!editingOwnCoachRecord) {
          delete (updates as any).defaultSessionDuration;
          // Same carve-out: a coach may self-toggle their own allocation mode.
          delete (updates as any).coachesSimultaneously;
        }
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

// SPEC_ANALYTICS_ATHLETE_CATCHMENT — one-time backfill: stamp each existing coach
// booking's athlete slots with the athlete's CURRENT parent-account postcode/suburb,
// so the athlete catchment report isn't empty on launch. Idempotent + re-runnable
// (only fills slots missing athleteSuburb). Coach bookings only (the only ones with
// athleteSlots). Run via deploy key:
//   npx convex run mutations:backfillAthleteSlotSuburbs
export const backfillAthleteSlotSuburbs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const bookings = await ctx.db.query("bookings").collect();
    // Cache athlete -> {postcode,suburb} resolutions by athleteId.
    const cache = new Map<string, { postcode?: string; suburb?: string }>();
    let bookingsPatched = 0;
    let slotsFilled = 0;
    let slotsUnresolved = 0;
    for (const b of bookings) {
      if (!(b as any).isCoachBooking) continue;
      const slots = (b as any).athleteSlots as any[] | undefined;
      if (!slots || slots.length === 0) continue;
      let changed = false;
      const next: any[] = [];
      for (const s of slots) {
        if (s.athleteSuburb) { next.push(s); continue; } // already snapshotted
        let snap: { postcode?: string; suburb?: string } = {};
        const aid = s.athleteId ? String(s.athleteId) : "";
        if (aid) {
          const cached = cache.get(aid);
          if (cached !== undefined) {
            snap = cached;
          } else {
            const athlete: any = await ctx.db.get(s.athleteId);
            if (athlete?.accountCustomerId) {
              const parent: any = await ctx.db.get(athlete.accountCustomerId);
              if (parent?.postcode && parent?.suburb) {
                snap = { postcode: parent.postcode, suburb: parent.suburb };
              }
            }
            cache.set(aid, snap);
          }
        }
        if (snap.suburb) {
          next.push({ ...s, athletePostcode: snap.postcode, athleteSuburb: snap.suburb });
          slotsFilled++;
          changed = true;
        } else {
          next.push(s);
          slotsUnresolved++;
        }
      }
      if (changed) {
        await ctx.db.patch(b._id, { athleteSlots: next });
        bookingsPatched++;
      }
    }
    return {
      totalBookings: bookings.length,
      bookingsPatched,
      slotsFilled,
      slotsUnresolved,
    };
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
        // SPEC_COACH_SESSION_LENGTH §2.2: default session length 60 for new coaches.
        defaultSessionDuration: (existing as any).defaultSessionDuration ?? 60,
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
      defaultSessionDuration: 60,
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

// SPEC_CHECKOUT_ABANDONMENT — store the live Stripe Checkout session id on an
// unpaid booking so the abandonment-expiry action can (a) actively expire that
// exact session and (b) detect a "Pay now" resume that created a newer session.
// Only writes while the booking is still awaiting payment.
export const setBookingCheckoutSession = internalMutation({
  args: { bookingId: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId as any);
    if (!booking) return;
    const b = booking as any;
    if (b.status !== "pending_payment" && b.status !== "pending") return;
    await ctx.db.patch(args.bookingId as any, { stripeSessionId: args.sessionId } as any);
  },
});

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
    receiptUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Idempotency: don't double-record the same booking on webhook retry.
    // MON-2 (audit 2026-06): use the by_bookingId index instead of a full-table
    // .filter() scan (ran on every payment confirm; cost grew with the table).
    const existing = await ctx.db
      .query("stripePayments")
      .withIndex("by_bookingId", (q: any) => q.eq("bookingId", args.bookingId))
      .first();
    if (existing) {
      // Backfill the receipt URL if it arrived on a retry and wasn't stored yet.
      if (args.receiptUrl && !(existing as any).receiptUrl) {
        await ctx.db.patch(existing._id, { receiptUrl: args.receiptUrl });
      }
      return existing._id;
    }

    const id = await ctx.db.insert("stripePayments", {
      bookingId: args.bookingId,
      stripeSessionId: args.stripeSessionId,
      customerEmail: args.customerEmail.toLowerCase().trim(),
      customerName: args.customerName,
      amount: args.amount,
      currency: args.currency,
      status: args.status,
      laneName: args.laneName,
      date: args.date,
      description: args.description,
      receiptUrl: args.receiptUrl,
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

// Seed sample Stripe payment records for a customer (ADMIN ONLY) — used to demo
// the Payments "Tax Invoices & Receipts" list. Re-running replaces the prior seed
// set (rows tagged with a 'seed-' bookingId prefix), so it's safe to call again.
export const seedTestStripePayments = mutation({
  args: { email: v.string(), customerName: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const email = args.email.toLowerCase().trim();
    const name = args.customerName ?? "Test Customer";
    const existing = await ctx.db
      .query("stripePayments")
      .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", email))
      .collect();
    for (const r of existing) {
      if (typeof r.bookingId === "string" && r.bookingId.startsWith("seed-")) {
        await ctx.db.delete(r._id);
      }
    }
    const samples = [
      { lane: "Bowling Machine 1", desc: "1 hour net — Bowling Machine 1", amount: 35, date: "2026-06-01", receipt: true },
      { lane: "9m Run Up 1", desc: "1.5 hour net — 9m Run Up 1", amount: 50, date: "2026-05-24", receipt: true },
      { lane: "Bowling Machine 3 (Truman)", desc: "1 hour net — Truman lane", amount: 45, date: "2026-05-18", receipt: false },
    ];
    let i = 0;
    for (const s of samples) {
      const session = `cs_test_seed_${email.replace(/[^a-z0-9]/g, "").slice(0, 10)}_${i}`;
      await ctx.db.insert("stripePayments", {
        bookingId: `seed-${email}-${i}`,
        stripeSessionId: session,
        customerEmail: email,
        customerName: name,
        amount: s.amount,
        currency: "aud",
        status: "paid",
        laneName: s.lane,
        date: s.date,
        description: s.desc,
        receiptUrl: s.receipt ? `https://pay.stripe.com/receipts/payment/${session}` : undefined,
      });
      i++;
    }
    return { inserted: samples.length, email };
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
    // COL-2 (audit 2026-06): capture status before delete — an 'offered' entry also
    // owns a live 'waitlist' slotHold + a scheduled roll-on.
    const wasOffered = ((entry as any).status ?? "waiting") === "offered";
    await ctx.db.delete(args.id);

    // COL-2: deleting an OFFERED entry alone orphans its waitlist hold — that hold
    // keeps fencing the freed slot out of the pool (and the next member is never
    // offered) until it expires. Mirror declineWaitlistOffer: drop this user's
    // overlapping waitlist hold(s) (found via the slotHolds by_date index, lane-
    // agnostic) and roll the offer to the next member immediately.
    if (wasOffered) {
      const slotEnd = entry.hour + 1;
      const emailLc = entry.userEmail?.toLowerCase().trim();
      const holds = await ctx.db
        .query("slotHolds")
        .withIndex("by_date", (q: any) => q.eq("date", entry.date))
        .collect();
      for (const h of holds) {
        if (h.holdType !== "waitlist") continue;
        if (h.userId !== entry.userId && h.userEmail?.toLowerCase().trim() !== emailLc) continue;
        const hEnd = h.startHour + h.duration / 60;
        if (entry.hour < hEnd && slotEnd > h.startHour) await ctx.db.delete(h._id);
      }
      await ctx.scheduler.runAfter(0, internal.waitlist.advanceWaitlistOffer, {
        laneId: entry.laneId,
        date: entry.date,
        hour: entry.hour,
      });
    }
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
    trumanPricePerHour: v.optional(v.number()),
    thirtyMinPrice: v.optional(v.number()),
    trumanThirtyMinPrice: v.optional(v.number()),
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
    releaseCountdownHours: v.optional(v.number()),
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
    pushEnabledGlobal: v.optional(v.boolean()),
    faultReportEmail: v.optional(v.string()), // EML-3 (audit 2026-06)
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
      trumanPricePerHour: 50,
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

// SPEC_STATEMENTS_EDITING — admin edits a coach BOOKING-charge line item directly
// on the statement (the booking's coach charge = coachPrice, which the ledger reads).
// Admin only; audited to modificationHistory; no GCal/email side-effects.
export const adminSetCoachPrice = mutation({
  args: { bookingId: v.id("bookings"), coachPrice: v.number() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new ConvexError("Booking not found.");
    if (args.coachPrice < 0) throw new ConvexError("Charge can't be negative.");
    const identity = await ctx.auth.getUserIdentity();
    const oldValue = (booking as any).coachPrice ?? 0;
    const history = Array.isArray((booking as any).modificationHistory)
      ? [...(booking as any).modificationHistory]
      : [];
    history.push({
      // schema requires oldValue/newValue to be strings.
      changes: [{ field: "coachPrice", oldValue: String(oldValue), newValue: String(args.coachPrice) }],
      modifiedAt: new Date().toISOString(),
      modifiedByName: (admin as any).name ?? "Admin",
      modifiedByUserId: identity?.subject ?? "",
    });
    await ctx.db.patch(args.bookingId, { coachPrice: args.coachPrice, modificationHistory: history } as any);
    return args.bookingId;
  },
});

// SPEC_STATEMENTS_EDITING — admin removes (or restores) a coach booking-charge line
// from the statement. Reversible: the booking + its data are preserved; the charge
// is just excluded from the statement ledger (treated as $0). Admin only; audited.
export const adminSetBookingStatementExcluded = mutation({
  args: { bookingId: v.id("bookings"), excluded: v.boolean() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new ConvexError("Booking not found.");
    const identity = await ctx.auth.getUserIdentity();
    const history = Array.isArray((booking as any).modificationHistory)
      ? [...(booking as any).modificationHistory]
      : [];
    history.push({
      // schema requires oldValue/newValue to be strings.
      changes: [{ field: "statementExcluded", oldValue: String((booking as any).statementExcluded === true), newValue: String(args.excluded) }],
      modifiedAt: new Date().toISOString(),
      modifiedByName: (admin as any).name ?? "Admin",
      modifiedByUserId: identity?.subject ?? "",
    });
    await ctx.db.patch(args.bookingId, { statementExcluded: args.excluded, modificationHistory: history } as any);
    return args.bookingId;
  },
});

// BUGFIX 2026-06-22 backfill — confirmBookingPayment used to skip creating the
// Google Calendar event, so Stripe-paid CUSTOMER bookings have no event (no door
// code / no machine power in HA). This one-off creates the missing events for all
// CONFIRMED, non-coach, TODAY-or-FUTURE bookings that have no googleCalendarEventId.
// Past sessions are skipped (moot). Idempotent: re-running skips any that now have
// an event. Staggered ~1.5s apart to respect the Google Calendar API.
export const backfillMissingCalendarEvents = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); // AWST
    const all = await ctx.db.query("bookings").collect();
    let scheduled = 0;
    const fixed: string[] = [];
    for (const b of all as any[]) {
      if (b.status !== "confirmed") continue;
      if (b.isCoachBooking === true) continue;       // coaches get their event at create time
      // INT-3 (audit 2026-06): a partially-synced booking can have per-lane event
      // ids without a primary id — also skip it (re-invoking would duplicate the
      // lanes that DID sync), not just the `googleCalendarEventId` case.
      if (b.googleCalendarEventId) continue;          // already synced
      if ((b.googleCalendarEventIds?.length ?? 0) > 0) continue; // partially/fully synced
      if ((b.date || "") < todayStr) continue;        // past sessions are moot
      await ctx.scheduler.runAfter(scheduled * 1500, internal.googleCalendar.createCalendarEvent, {
        bookingId: b._id.toString(),
        laneId: b.laneId,
        variantId: b.variantId,
        date: b.date,
        startHour: b.startHour,
        duration: b.duration,
        customerName: b.customerName ?? "Customer",
        customerEmail: b.customerEmail ?? "",
        customerPhone: b.customerPhone,
        status: "confirmed",
        isCoachBooking: false,
        accessCode: b.accessCode,
        additionalLaneIds: b.additionalLaneIds,
        laneNameSnapshot: b.laneNameSnapshot,
        variantLabelSnapshot: b.variantLabelSnapshot,
        // BUGM-4 (audit 2026-06): strip stored slots to exactly the validator's
        // shape — raw athleteSlots carry athleteId/suburb which fail
        // createCalendarEvent's arg validation (silent backfill failure).
        athleteSlots: (b.athleteSlots as any[] | undefined)?.map((s: any) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
      });
      scheduled++;
      fixed.push(`${b.customerName ?? b.customerEmail} · ${b.laneNameSnapshot ?? b.laneId} ${b.date} ${b.startHour}:00`);
    }
    return { scheduled, fixed };
  },
});

// SPEC_CALENDAR_SYNC_RELIABILITY_2026-06 (fix #1) — one-off backfill for COACH
// bookings whose Google Calendar event silently failed to write (the 13 found in
// the 2026-06-23 prod audit: confirmed coach bookings with a stored door code but
// NO event → HA never loads the code → lockout). The customer backfill above
// deliberately skips coach bookings; this is its coach counterpart.
//
// ⚠️ Creating events has PHYSICAL effects (HA arms the door code + machine power for
// these sessions) — that's the intended fix, but every row returned should be a
// legitimate current booking. Run a count first, eyeball `fixed`, then it's done.
// Idempotent: re-running skips any that now have an event. Detection is DB-only (no
// Google reads). The daily reconcile cron also covers this going forward.
export const backfillMissingCoachCalendarEvents = mutation({
  // dryRun=true returns the list it WOULD fix without scheduling any event (no
  // physical HA effect) — preview the rows first, then run for real.
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); // AWST
    const all = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.gte("date", todayStr))
      .collect();
    let scheduled = 0;
    const fixed: string[] = [];
    for (const b of all as any[]) {
      if (b.status !== "confirmed") continue;
      if (b.isCoachBooking !== true) continue;            // customers handled by the sibling backfill
      if (b.googleCalendarEventId) continue;              // already synced
      if ((b.googleCalendarEventIds?.length ?? 0) > 0) continue; // partially/fully synced
      if (!b.accessCode) continue;                        // nothing to load into HA without a code
      scheduled++;
      fixed.push(`${b.customerName ?? b.customerEmail} · ${b.laneNameSnapshot ?? b.laneId} ${b.date} ${b.startHour}:00 · code ${b.accessCode}`);
      if (args.dryRun) continue;                          // preview only — no physical effect
      await ctx.scheduler.runAfter((scheduled - 1) * 1500, internal.googleCalendar.createCalendarEvent, {
        bookingId: b._id.toString(),
        laneId: b.laneId,
        variantId: b.variantId,
        date: b.date,
        startHour: b.startHour,
        duration: b.duration,
        customerName: b.customerName ?? "Coach",
        customerEmail: b.customerEmail ?? "",
        customerPhone: b.customerPhone,
        status: "confirmed",
        isCoachBooking: true,
        accessCode: b.accessCode,
        additionalLaneIds: b.additionalLaneIds,
        laneNameSnapshot: b.laneNameSnapshot,
        variantLabelSnapshot: b.variantLabelSnapshot,
        // BUGM-4: strip stored slots to exactly createCalendarEvent's validator
        // shape — raw slots carry athleteId/suburb which fail its arg validation.
        athleteSlots: (b.athleteSlots as any[] | undefined)?.map((s: any) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
      });
    }
    return { scheduled, fixed };
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

// Admin-only: directly correct a booking's stored `priceInCents` (the "cash paid"
// figure that cancellation refunds + future edit-diffs key off). For reconciling a
// booking whose stored price drifted from what was actually paid after a manual
// admin fix — e.g. a customer reduced a paid booking for credit, then an admin
// re-extended it free, leaving priceInCents below the amount paid. Pure data fix:
// touches NOTHING else (no Stripe, calendar, credit, or email). Logged to
// modificationHistory for audit.
export const adminSetBookingPrice = mutation({
  args: { bookingId: v.id("bookings"), priceInCents: v.number() },
  handler: async (ctx, args) => {
    const adminUser = await requireAdmin(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new ConvexError("Booking not found.");
    if (!Number.isFinite(args.priceInCents) || args.priceInCents < 0) {
      throw new ConvexError("priceInCents must be a non-negative number.");
    }
    const newPrice = Math.round(args.priceInCents);
    const oldPrice = (booking as any).priceInCents;
    if (oldPrice === newPrice) return { success: true, unchanged: true, oldPrice, newPrice };
    const prevHistory = (booking as any).modificationHistory ?? [];
    await ctx.db.patch(args.bookingId, {
      priceInCents: newPrice,
      modificationHistory: [
        ...prevHistory,
        {
          modifiedAt: new Date().toISOString(),
          modifiedByUserId: (adminUser as any)?._id?.toString?.() ?? undefined,
          modifiedByName: (adminUser as any)?.name ?? (adminUser as any)?.email ?? "Admin",
          changes: [
            {
              field: "priceInCents",
              oldValue: oldPrice === undefined || oldPrice === null ? undefined : String(oldPrice),
              newValue: String(newPrice),
            },
          ],
        },
      ],
    } as any);
    return { success: true, oldPrice, newPrice };
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
      // MONM-2 (audit 2026-06): never mint more than was actually SETTLED — an admin
      // typo could otherwise create spendable credit from nothing. Mirror exactly the
      // cancelBooking C2 ceiling: CASH counts only when the booking was truly paid
      // (paymentStatus "paid"; priceInCents holds the full price even when settled by
      // credit, so it must be gated on paid), while REDEEMED account credit
      // (creditApplied) is ALWAYS refundable — this covers credit-only bookings, which
      // are confirmed with paymentStatus undefined. Clamp to that ceiling; reject only
      // when there is genuinely nothing to refund (a never-paid, no-credit booking).
      if ((booking as any).isCoachBooking) {
        throw new ConvexError("Coach bookings aren't paid online — there is no charge to refund as credit.");
      }
      const wasPaid = (booking as any).paymentStatus === "paid";
      const cashPaid = wasPaid && (booking as any).priceInCents != null ? (booking as any).priceInCents / 100 : 0;
      const maxRefund = cashPaid + ((booking as any).creditApplied ?? 0);
      const creditToIssue = Math.min(amount, maxRefund);
      if (creditToIssue <= 0) {
        throw new ConvexError("This booking has no paid charge or applied credit to refund.");
      }
      amountCredited = await issueCredit(ctx, {
        email: booking.customerEmail,
        amount: creditToIssue,
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

// Carpet-wear reset (2026-06): record that a lane's carpet was replaced — cumulative
// lane-wear analytics counts booked hours from this date forward. ADMIN ONLY.
export const resetLaneWear = mutation({
  args: { laneId: v.string(), resetDate: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.resetDate)) {
      throw new ConvexError("resetDate must be YYYY-MM-DD.");
    }
    return await ctx.db.insert("laneWearResets", {
      laneId: args.laneId,
      resetDate: args.resetDate,
      note: args.note,
      createdAt: new Date().toISOString(),
      createdByEmail: (admin as any)?.email ?? undefined,
    });
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
      trumanPricePerHour: 50,
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

          // M8 fix (audit 2026-07): extend the SURVIVOR's OWN calendar event to the
          // merged duration. Previously the merge only deleted the later blocks'
          // events and never grew the first block's event, so HA still saw a 1-hour
          // session → the bowling-machine power cut off + the door code deactivated
          // mid-session. Update in place (create if the survivor had no event yet).
          // Note: if the merge unions additionalLaneIds the primary event carries the
          // duration fix; per-extra-lane events are a rare admin-tool edge.
          {
            const survSlots = ((patch.athleteSlots ?? first.athleteSlots ?? []) as any[]).map((s: any) => ({
              athleteName: s.athleteName,
              startHour: s.startHour,
              durationMinutes: s.durationMinutes,
            }));
            const survHadEvent =
              !!first.googleCalendarEventId ||
              (Array.isArray(first.googleCalendarEventIds) && first.googleCalendarEventIds.length > 0);
            const survPayload = {
              laneId: first.laneId,
              variantId: first.variantId,
              date: first.date,
              startHour: first.startHour,
              duration: totalDuration,
              customerName: first.customerName,
              customerEmail: first.customerEmail,
              customerPhone: first.customerPhone,
              status: "confirmed",
              isCoachBooking: true,
              accessCode: first.accessCode,
              additionalLaneIds: patch.additionalLaneIds ?? first.additionalLaneIds,
              athleteSlots: survSlots,
              laneNameSnapshot: first.laneNameSnapshot,
              variantLabelSnapshot: first.variantLabelSnapshot,
            };
            if (survHadEvent) {
              await ctx.scheduler.runAfter(0, internal.googleCalendar.updateCalendarEvent, {
                googleCalendarEventId: first.googleCalendarEventId ?? "",
                laneCalendarEventIds: first.googleCalendarEventIds,
                ...survPayload,
              });
            } else {
              await ctx.scheduler.runAfter(0, internal.googleCalendar.createCalendarEvent, {
                bookingId: first._id.toString(),
                ...survPayload,
              });
            }
          }

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
