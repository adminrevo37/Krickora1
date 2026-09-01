// Admin lane reassignment / swap tool.
//
// The engine is one thing: "a set of {booking, which lane leg, new lane} moves
// applied atomically". Every UI flow (straight 2-way swap, whole-day shuffle,
// bulk move onto one lane, moving a single lane out of a club booking) is just
// a different set of legs.
//
// v2 (2026-09-01) — two changes, both driven by real admin use:
//  - PER-LEG MOVES. A multi-lane booking (club bookings, mostly) used to be
//    rejected outright. Now an assignment names the leg via `fromLaneId`, so
//    one lane can be moved out of a 4-lane club booking while the other three
//    stay put. `fromLaneId` is optional only for single-lane bookings.
//  - OCCUPANCY-BASED CONFLICT SCAN. The old scan excluded every booking in the
//    batch (needed so a genuine A<->B swap doesn't false-positive against
//    itself). That shortcut breaks the moment a booking only PARTIALLY vacates:
//    a club booking moving its lane-1 leg still occupies lanes 2/3, and a
//    blanket exclusion would happily let another booking land on top of them.
//    So instead of excluding anything, we build the post-move occupancy map
//    (batch bookings at their FINAL lane sets, everyone else where they are)
//    and look for overlaps in that. Strictly more correct, and it subsumes the
//    old separate intra-batch collision check.
//
// Unchanged and load-bearing:
//  - Every affected booking gets the full CAL-4 teardown + rebuild of its
//    calendar events (convex/mutations.ts ~2860-2887). This IS the door-code
//    sync mechanism — HA reads per-lane Google Calendars — so a reassignment
//    without it leaves a live door code on the lane the customer no longer has.
//    Rebuilding the WHOLE set (not just the moved leg) is deliberate: it reuses
//    the reconciler's proven recreate pattern and can't leave orphan events.
//  - The customer email is a SEPARATE, explicit step (adminSendLaneChangeEmails)
//    so the admin reviews/edits the text first — nothing here sends email.

import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";
import { hasActiveHoldConflict } from "./lib/slotHolds";
import { recordBookingEvent } from "./bookingEvents";
import { validateAndSnapshotLane } from "./lanes";
import { defaultLaneName } from "./lib/lanes";
import { fmtAwstDateLabel, fmtAwstDateShort } from "./lib/dates";

const LANE_TYPE_LABEL: Record<string, string> = { BM: "Bowling Machine", RU: "Run Up" };

function fmtTimeSlot(h: number): string {
  const wholeHour = Math.floor(h);
  const min = Math.round((h - wholeHour) * 60);
  const period = wholeHour >= 12 ? "PM" : "AM";
  const displayHour = wholeHour > 12 ? wholeHour - 12 : wholeHour === 0 ? 12 : wholeHour;
  return `${displayHour}:${min.toString().padStart(2, "0")} ${period}`;
}

function fmtDuration(mins: number): string {
  if (mins === 60) return "1 hour";
  if (mins === 90) return "1.5 hours";
  if (mins === 120) return "2 hours";
  if (mins === 30) return "30 minutes";
  return `${mins} min`;
}

/** Ordered lane set of a booking: [primary, ...additional]. */
function laneSetOf(b: any): string[] {
  return [b.laneId, ...(((b.additionalLaneIds as string[] | undefined) ?? []))];
}

type ReassignResult = {
  bookingId: string;
  customerEmail: string;
  customerName: string;
  date: string;
  startHour: number;
  duration: number;
  timeSlot: string;
  durationLabel: string;
  oldLaneName: string;
  newLaneName: string;
  newLaneId: string;
  laneType: string;
  isMultiLane: boolean;
};

export const adminReassignLanes = mutation({
  args: {
    assignments: v.array(
      v.object({
        bookingId: v.id("bookings"),
        newLaneId: v.string(),
        // Which lane leg to move. Optional ONLY for single-lane bookings (where
        // it can be inferred); required for multi-lane, so the caller can never
        // silently move "the" lane of a booking that has several.
        fromLaneId: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args): Promise<{ moved: ReassignResult[] }> => {
    const adminUser = await requireAdmin(ctx);

    if (args.assignments.length === 0) {
      throw new ConvexError("No bookings selected.");
    }

    // ── Load each booking once ────────────────────────────────────────────
    const bookingById = new Map<string, any>();
    for (const a of args.assignments) {
      const id = a.bookingId.toString();
      if (bookingById.has(id)) continue;
      const booking = await ctx.db.get(a.bookingId);
      if (!booking) {
        throw new ConvexError("A selected booking no longer exists — refresh and try again.");
      }
      if (booking.status === "cancelled") {
        throw new ConvexError(`${booking.customerName}'s booking is cancelled — cannot move it.`);
      }
      bookingById.set(id, booking);
    }

    // ── Resolve each assignment to a concrete leg move, building each
    //    booking's FINAL lane set as we go (a booking may have >1 leg moved).
    const finalLanes = new Map<string, string[]>();
    const movedLegsByBooking = new Map<string, Array<{ from: string; to: string }>>();
    const seenLegs = new Set<string>();

    for (const a of args.assignments) {
      const id = a.bookingId.toString();
      const booking = bookingById.get(id)!;
      const origSet = laneSetOf(booking);
      const current = finalLanes.get(id) ?? origSet;

      let from: string;
      if (a.fromLaneId != null) {
        from = a.fromLaneId;
      } else {
        if (origSet.length > 1) {
          throw new ConvexError(
            `${booking.customerName}'s booking uses ${origSet.length} lanes — select the specific lane to move.`
          );
        }
        from = booking.laneId as string;
      }
      if (!origSet.includes(from)) {
        throw new ConvexError(
          `${booking.customerName}'s booking isn't on ${defaultLaneName(from)} — refresh and try again.`
        );
      }

      const legKey = `${id}|${from}`;
      if (seenLegs.has(legKey)) {
        throw new ConvexError(
          `${booking.customerName}'s ${defaultLaneName(from)} was selected twice — pick one destination for it.`
        );
      }
      seenLegs.add(legKey);

      if (a.newLaneId === from) continue; // no-op leg, nothing to do

      const idx = current.indexOf(from);
      if (idx < 0) {
        throw new ConvexError(`${booking.customerName}'s ${defaultLaneName(from)} leg was already moved in this batch.`);
      }
      if (current.includes(a.newLaneId)) {
        throw new ConvexError(
          `${booking.customerName}'s booking already uses ${defaultLaneName(a.newLaneId)} — pick a different lane.`
        );
      }

      const next = [...current];
      next[idx] = a.newLaneId;
      finalLanes.set(id, next);
      movedLegsByBooking.set(id, [...(movedLegsByBooking.get(id) ?? []), { from, to: a.newLaneId }]);
    }

    if (finalLanes.size === 0) {
      return { moved: [] };
    }

    // ── Validate every newly-occupied lane (type/variant compatibility, the
    //    date-resolved display snapshot, closed segments, boundary crossings).
    const snapshotByLane = new Map<string, { laneNameSnapshot: string; mode: string }>();
    for (const [id, legs] of movedLegsByBooking) {
      const booking = bookingById.get(id)!;
      for (const leg of legs) {
        const snap = await validateAndSnapshotLane(ctx, {
          laneId: leg.to,
          variantId: booking.variantId,
          date: booking.date,
          startHour: booking.startHour,
          durationMinutes: booking.duration,
          isAdmin: true,
        });
        snapshotByLane.set(`${id}|${leg.to}`, {
          laneNameSnapshot: snap.laneNameSnapshot,
          mode: snap.segment.mode,
        });
      }
    }

    // ── Conflict scan over POST-MOVE occupancy ────────────────────────────
    // Nothing is "excluded". Each booking is placed at the lane set it will
    // actually hold once this batch commits, then we look for two different
    // bookings overlapping in time on the same lane. This is what makes a real
    // swap pass (both vacate together) while still catching a partially-vacating
    // multi-lane booking's retained lanes.
    const dayCache = new Map<string, any[]>();
    async function dayBookings(date: string) {
      if (!dayCache.has(date)) {
        dayCache.set(
          date,
          await ctx.db
            .query("bookings")
            .withIndex("by_date", (q: any) => q.eq("date", date))
            .collect()
        );
      }
      return dayCache.get(date)!;
    }

    const dates = new Set<string>();
    for (const id of finalLanes.keys()) dates.add(bookingById.get(id)!.date);

    for (const date of dates) {
      type Occ = { bookingId: string; lane: string; start: number; end: number; name: string; inBatch: boolean };
      const occ: Occ[] = [];
      for (const b of await dayBookings(date)) {
        if (b.status === "cancelled") continue;
        const id = b._id.toString();
        const inBatch = finalLanes.has(id);
        const lanes = inBatch ? finalLanes.get(id)! : laneSetOf(b);
        for (const lane of lanes) {
          occ.push({
            bookingId: id,
            lane,
            start: b.startHour,
            end: b.startHour + b.duration / 60,
            name: b.customerName,
            inBatch,
          });
        }
      }
      for (let i = 0; i < occ.length; i++) {
        for (let j = i + 1; j < occ.length; j++) {
          const a = occ[i];
          const b = occ[j];
          if (a.lane !== b.lane) continue;
          if (a.bookingId === b.bookingId) continue; // same booking, its own lanes
          if (!a.inBatch && !b.inBatch) continue; // pre-existing, not ours to police
          if (a.start < b.end && a.end > b.start) {
            throw new ConvexError(
              `${a.name} and ${b.name} would both be on ${defaultLaneName(a.lane)} at overlapping times — check your selection.`
            );
          }
        }
      }
    }

    // ── In-flight checkout holds on each newly-occupied lane ──────────────
    for (const [id, legs] of movedLegsByBooking) {
      const booking = bookingById.get(id)!;
      const endHour = booking.startHour + booking.duration / 60;
      for (const leg of legs) {
        if (
          await hasActiveHoldConflict(ctx, {
            laneIds: [leg.to],
            date: booking.date,
            startHour: booking.startHour,
            endHour,
            excludeBookingId: id,
            bypassWaitlistHolds: true,
          })
        ) {
          throw new ConvexError(`${booking.customerName}'s new lane has an in-flight checkout — try again shortly.`);
        }
      }
    }

    // ── Everything validated — apply. (Convex mutations are transactional: if
    //    anything above threw, nothing below ever ran and nothing was written.)
    const results: ReassignResult[] = [];

    for (const [id, finalSet] of finalLanes) {
      const booking = bookingById.get(id)!;
      const legs = movedLegsByBooking.get(id) ?? [];
      const origSet = laneSetOf(booking);
      const newPrimary = finalSet[0];
      const newAdditional = finalSet.slice(1);
      const isMultiLane = finalSet.length > 1;

      // The stored display snapshot tracks the PRIMARY lane only. If the primary
      // leg moved, take the freshly-resolved name; otherwise leave it alone.
      const primaryMoved = newPrimary !== booking.laneId;
      const newPrimaryName = primaryMoved
        ? snapshotByLane.get(`${id}|${newPrimary}`)!.laneNameSnapshot
        : booking.laneNameSnapshot || defaultLaneName(booking.laneId);

      const prevHistory = booking.modificationHistory ?? [];
      await ctx.db.patch(booking._id, {
        laneId: newPrimary,
        additionalLaneIds: newAdditional.length > 0 ? newAdditional : undefined,
        laneNameSnapshot: newPrimaryName,
        modificationHistory: [
          ...prevHistory,
          {
            modifiedAt: new Date().toISOString(),
            modifiedByUserId: (adminUser as any)?._id?.toString?.() ?? (adminUser as any)?.id ?? undefined,
            modifiedByName: (adminUser as any)?.name ?? (adminUser as any)?.email ?? "Admin",
            changes: [
              {
                field: isMultiLane || origSet.length > 1 ? "lanes" : "laneId",
                oldValue: origSet.join(", "),
                newValue: finalSet.join(", "),
              },
            ],
          },
        ],
      });

      const oldLaneName = legs.map((l) => defaultLaneName(l.from)).join(", ");
      const newLaneName = isMultiLane
        ? finalSet
            .map((l) => (l === newPrimary ? newPrimaryName : snapshotByLane.get(`${id}|${l}`)?.laneNameSnapshot ?? defaultLaneName(l)))
            .join(" + ")
        : newPrimaryName;
      // Lane type comes from a moved leg (they're all the same session, and a
      // mixed-type multi-lane move is rejected upstream by the variant check).
      const movedMode = snapshotByLane.get(`${id}|${legs[0].to}`)?.mode ?? "";

      await recordBookingEvent(ctx, {
        type: "modified",
        bookingId: id,
        customerName: booking.customerName,
        actorName: (adminUser as any)?.name ?? (adminUser as any)?.email ?? "Admin",
        isCoachBooking: booking.isCoachBooking,
        before: { date: booking.date, startHour: booking.startHour, duration: booking.duration, lane: origSet.join(", ") },
        after: { date: booking.date, startHour: booking.startHour, duration: booking.duration, lane: finalSet.join(", ") },
      });

      // Calendar resync (CAL-4 pattern), whole-set teardown + rebuild. Clearing
      // the stored ids before the create matters: setBookingLaneCalendarEventIds
      // MERGES by laneId, so a surviving stale entry for the vacated lane would
      // otherwise persist alongside the new one and keep a door code live there.
      const hadEvents =
        !!booking.googleCalendarEventId ||
        (Array.isArray(booking.googleCalendarEventIds) && booking.googleCalendarEventIds.length > 0);
      if (hadEvents) {
        await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
          googleCalendarEventId: booking.googleCalendarEventId ?? "",
          laneCalendarEventIds: booking.googleCalendarEventIds,
        });
        await ctx.db.patch(booking._id, {
          googleCalendarEventId: undefined,
          googleCalendarEventIds: undefined,
        });
      }
      await ctx.scheduler.runAfter(500, internal.googleCalendar.createCalendarEvent, {
        bookingId: id,
        laneId: newPrimary,
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
        additionalLaneIds: newAdditional,
        athleteSlots: (booking.athleteSlots ?? []).map((s: any) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
        laneNameSnapshot: newPrimaryName,
        variantLabelSnapshot: booking.variantLabelSnapshot,
      });

      results.push({
        bookingId: id,
        customerEmail: booking.customerEmail,
        customerName: booking.customerName,
        date: booking.date,
        startHour: booking.startHour,
        duration: booking.duration,
        timeSlot: fmtTimeSlot(booking.startHour),
        durationLabel: fmtDuration(booking.duration),
        oldLaneName,
        newLaneName,
        newLaneId: legs[0].to,
        laneType: LANE_TYPE_LABEL[movedMode] ?? movedMode,
        isMultiLane,
      });
    }

    return { moved: results };
  },
});

// Explicit review-then-send step. Nothing above sends email on its own — the
// admin sees the merged Session Details + editable intro text in the UI first
// and calls this only once they hit Send. Re-reads each booking fresh (rather
// than trusting whatever the reassign call returned) so the email always
// reflects the current state even if something changed in between.
export const adminSendLaneChangeEmails = mutation({
  args: {
    items: v.array(
      v.object({
        bookingId: v.id("bookings"),
        introText: v.string(),
        closingText: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args): Promise<{ sent: string[]; skipped: string[] }> => {
    await requireAdmin(ctx);
    const sent: string[] = [];
    const skipped: string[] = [];

    for (const item of args.items) {
      const booking = await ctx.db.get(item.bookingId);
      if (!booking || booking.status === "cancelled" || !booking.customerEmail || (booking as any).isClubBooking) {
        skipped.push(item.bookingId.toString());
        continue;
      }
      const { segment } = await validateAndSnapshotLane(ctx, {
        laneId: booking.laneId,
        variantId: booking.variantId,
        date: booking.date,
        startHour: booking.startHour,
        durationMinutes: booking.duration,
        isAdmin: true,
        skipVariantCheck: true,
      }).catch(() => ({ segment: { mode: "" } as any }));

      // Multi-lane: name every lane the customer now holds, not just the primary
      // (a club booking that kept 3 lanes and moved 1 needs the full picture).
      const laneNames = laneSetOf(booking)
        .map((l, i) => (i === 0 ? booking.laneNameSnapshot || defaultLaneName(l) : defaultLaneName(l)))
        .join(" + ");

      await ctx.scheduler.runAfter(0, internal.emails.sendLaneChangeEmail, {
        to: booking.customerEmail,
        customerName: booking.customerName,
        introText: item.introText,
        closingText: item.closingText,
        date: fmtAwstDateLabel(booking.date),
        dateShort: fmtAwstDateShort(booking.date),
        timeSlot: fmtTimeSlot(booking.startHour),
        duration: fmtDuration(booking.duration),
        newLaneName: laneNames,
        laneType: LANE_TYPE_LABEL[segment.mode] ?? segment.mode ?? "",
      });
      sent.push(item.bookingId.toString());
    }

    return { sent, skipped };
  },
});
