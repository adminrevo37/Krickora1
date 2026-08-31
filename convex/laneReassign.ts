// Admin lane reassignment / swap tool.
//
// Two UI flows share one engine:
//  - Bulk move: N bookings (any date/time) -> all reassigned to ONE target lane.
//  - Hour swap: N bookings that share a date+hour -> each reassigned to a
//    different lane among the selected set (the 2-booking case is a plain
//    "lane 4 <-> lane 5" swap; N-booking is a rotation).
// Both are just "a set of {bookingId, newLaneId} pairs applied atomically" —
// the validation below is what makes that safe:
//  - updateBooking's single-edit conflict scan only excludes the ONE booking
//    being edited, so a genuine 2-way swap would false-positive against
//    itself (booking A's old slot looks "taken" by booking B, which is
//    moving OUT of it in the same operation). This engine excludes every
//    booking in the whole batch, not just one.
//  - Every leg still gets the full CAL-4 delete-old-event + create-new-event
//    dance (convex/mutations.ts ~2860-2887) so the door code correctly moves
//    with the booking to its new lane's calendar (HA reads per-lane
//    calendars; this IS the door-code sync mechanism in this codebase).
//  - Multi-lane bookings (additionalLaneIds) are out of scope for v1 and are
//    rejected with a clear message rather than silently mishandled.
//
// The customer email is a SEPARATE, explicit step (adminSendLaneChangeEmails)
// so the admin can review/edit the intro text before anything sends — nothing
// here sends email on its own.

import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";
import { hasActiveHoldConflict } from "./lib/slotHolds";
import { recordBookingEvent } from "./bookingEvents";
import { validateAndSnapshotLane } from "./lanes";
import { defaultLaneName } from "./lib/lanes";

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
};

export const adminReassignLanes = mutation({
  args: {
    assignments: v.array(
      v.object({
        bookingId: v.id("bookings"),
        newLaneId: v.string(),
      })
    ),
  },
  handler: async (ctx, args): Promise<{ moved: ReassignResult[] }> => {
    const adminUser = await requireAdmin(ctx);

    if (args.assignments.length === 0) {
      throw new ConvexError("No bookings selected.");
    }
    const seen = new Set<string>();
    for (const a of args.assignments) {
      const key = a.bookingId.toString();
      if (seen.has(key)) throw new ConvexError("The same booking was selected twice.");
      seen.add(key);
    }

    const loaded = await Promise.all(
      args.assignments.map(async (a) => {
        const booking = await ctx.db.get(a.bookingId);
        if (!booking) throw new ConvexError("A selected booking no longer exists — refresh and try again.");
        if (booking.status === "cancelled") {
          throw new ConvexError(`${booking.customerName}'s booking is cancelled — cannot move it.`);
        }
        if ((booking.additionalLaneIds?.length ?? 0) > 0) {
          throw new ConvexError(
            `${booking.customerName}'s booking spans multiple lanes — this tool only handles single-lane bookings. Use the booking editor for that one.`
          );
        }
        return { assignment: a, booking };
      })
    );

    const batchIds = new Set(loaded.map((l) => l.assignment.bookingId.toString()));
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

    const results: ReassignResult[] = [];

    for (const { assignment, booking } of loaded) {
      const { newLaneId } = assignment;
      if (newLaneId === booking.laneId) continue; // no-op, nothing to do for this one

      // Lane-type/variant compatibility + the date-resolved display snapshot,
      // in one call (also rejects a closed segment / a boundary-crossing move).
      const snap = await validateAndSnapshotLane(ctx, {
        laneId: newLaneId,
        variantId: booking.variantId,
        date: booking.date,
        startHour: booking.startHour,
        durationMinutes: booking.duration,
        isAdmin: true,
      });

      const endHour = booking.startHour + booking.duration / 60;
      const day = await dayBookings(booking.date);
      const conflict = day.some((b: any) => {
        if (batchIds.has(b._id.toString())) return false; // vacated together in this same batch
        if (b.status === "cancelled") return false;
        const occupies = b.laneId === newLaneId || ((b.additionalLaneIds as string[] | undefined) ?? []).includes(newLaneId);
        if (!occupies) return false;
        const bEnd = b.startHour + b.duration / 60;
        return booking.startHour < bEnd && endHour > b.startHour;
      });
      if (conflict) {
        throw new ConvexError(`${booking.customerName}'s new lane is already booked at that time.`);
      }
      if (
        await hasActiveHoldConflict(ctx, {
          laneIds: [newLaneId],
          date: booking.date,
          startHour: booking.startHour,
          endHour,
          excludeBookingId: booking._id.toString(),
          bypassWaitlistHolds: true,
        })
      ) {
        throw new ConvexError(`${booking.customerName}'s new lane has an in-flight checkout — try again shortly.`);
      }

      results.push({
        bookingId: booking._id.toString(),
        customerEmail: booking.customerEmail,
        customerName: booking.customerName,
        date: booking.date,
        startHour: booking.startHour,
        duration: booking.duration,
        timeSlot: fmtTimeSlot(booking.startHour),
        durationLabel: fmtDuration(booking.duration),
        oldLaneName: booking.laneNameSnapshot || defaultLaneName(booking.laneId),
        newLaneName: snap.laneNameSnapshot,
        newLaneId,
        laneType: LANE_TYPE_LABEL[snap.segment.mode] ?? snap.segment.mode,
      });
    }

    if (results.length === 0) {
      return { moved: [] };
    }

    // Cross-batch conflict: two bookings in THIS batch could both land on the
    // same new lane at overlapping times (a bad bulk-move selection) — nothing
    // above catches that, since each leg is only checked against bookings
    // OUTSIDE the batch.
    const byLaneDate = new Map<string, ReassignResult[]>();
    for (const r of results) {
      const key = `${r.newLaneId}|${r.date}`;
      const arr = byLaneDate.get(key) ?? [];
      arr.push(r);
      byLaneDate.set(key, arr);
    }
    for (const group of byLaneDate.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const aEnd = a.startHour + a.duration / 60;
          const bEnd = b.startHour + b.duration / 60;
          if (a.startHour < bEnd && aEnd > b.startHour) {
            throw new ConvexError(
              `${a.customerName} and ${b.customerName} would both end up on the same lane at overlapping times — check your selection.`
            );
          }
        }
      }
    }

    // Everything validated — apply. (Convex mutations are transactional: if
    // anything above threw, nothing below ever ran and nothing was written.)
    const byId = new Map(loaded.map((l) => [l.assignment.bookingId.toString(), l]));
    for (const r of results) {
      const { assignment, booking } = byId.get(r.bookingId)!;
      const prevHistory = booking.modificationHistory ?? [];

      await ctx.db.patch(assignment.bookingId, {
        laneId: assignment.newLaneId,
        laneNameSnapshot: r.newLaneName,
        modificationHistory: [
          ...prevHistory,
          {
            modifiedAt: new Date().toISOString(),
            modifiedByUserId: (adminUser as any)?._id?.toString?.() ?? (adminUser as any)?.id ?? undefined,
            modifiedByName: (adminUser as any)?.name ?? (adminUser as any)?.email ?? "Admin",
            changes: [{ field: "laneId", oldValue: booking.laneId, newValue: assignment.newLaneId }],
          },
        ],
      });

      await recordBookingEvent(ctx, {
        type: "modified",
        bookingId: r.bookingId,
        customerName: r.customerName,
        actorName: (adminUser as any)?.name ?? (adminUser as any)?.email ?? "Admin",
        isCoachBooking: booking.isCoachBooking,
        before: { date: booking.date, startHour: booking.startHour, duration: booking.duration, lane: r.oldLaneName },
        after: { date: booking.date, startHour: booking.startHour, duration: booking.duration, lane: r.newLaneName },
      });

      // Calendar resync (CAL-4 pattern): a reassignment is always a lane-set
      // change here (no-ops were skipped above), so this always deletes the old
      // event + clears the stored ids + creates a fresh event on the new lane's
      // calendar — never an update-in-place. Clearing the ids before the create
      // matters: otherwise the new lane's id gets MERGED alongside the stale
      // now-deleted old-lane id (mutations.ts CAL-4, 2026-06-23).
      const hadEvents =
        !!booking.googleCalendarEventId ||
        (Array.isArray(booking.googleCalendarEventIds) && booking.googleCalendarEventIds.length > 0);
      if (hadEvents) {
        await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
          googleCalendarEventId: booking.googleCalendarEventId ?? "",
          laneCalendarEventIds: booking.googleCalendarEventIds,
        });
        await ctx.db.patch(assignment.bookingId, {
          googleCalendarEventId: undefined,
          googleCalendarEventIds: undefined,
        });
      }
      await ctx.scheduler.runAfter(500, internal.googleCalendar.createCalendarEvent, {
        bookingId: r.bookingId,
        laneId: assignment.newLaneId,
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
        additionalLaneIds: [],
        athleteSlots: (booking.athleteSlots ?? []).map((s: any) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
        laneNameSnapshot: r.newLaneName,
        variantLabelSnapshot: booking.variantLabelSnapshot,
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

      await ctx.scheduler.runAfter(0, internal.emails.sendLaneChangeEmail, {
        to: booking.customerEmail,
        customerName: booking.customerName,
        introText: item.introText,
        closingText: item.closingText,
        date: booking.date,
        timeSlot: fmtTimeSlot(booking.startHour),
        duration: fmtDuration(booking.duration),
        newLaneName: booking.laneNameSnapshot || defaultLaneName(booking.laneId),
        laneType: LANE_TYPE_LABEL[segment.mode] ?? segment.mode ?? "",
      });
      sent.push(item.bookingId.toString());
    }

    return { sent, skipped };
  },
});
