import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";

/**
 * Waitlist — sequential first-refusal engine (SPEC_WAITLIST_OFFER_REDESIGN).
 *
 * Replaces the old "notify everyone, first-to-book-wins, delete all entries"
 * blast with a fair, automatic, one-at-a-time offer:
 *   • A freed slot is offered to the LONGEST-WAITING member first.
 *   • While offered, a 'waitlist' slotHold blocks the public (the offeree
 *     passes their own hold in createBooking — see lib/slotHolds).
 *   • If they don't book within waitlistOfferHoldMinutes, the offer rolls to
 *     the next member. A self-scheduled re-invoke drives the roll-on.
 *
 * `advanceWaitlistOffer` is the single, idempotent engine. Triggers (cancel,
 * reschedule/modify, abandoned-checkout release, confirmation, admin override)
 * all just schedule it for the affected slot-hours; the engine decides whether
 * to offer-next, hold, or clear.
 */

const DEFAULT_HOLD_MINUTES = 15;

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

// Weekday-long date label in AWST (avoids the Bug #4 day-boundary flip).
function fmtAwstDateLabel(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    timeZone: "Australia/Perth",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Clock-time label (e.g. "3:42 PM") in AWST for the offer deadline.
function fmtAwstTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "Australia/Perth",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const statusOf = (e: any): string => e.status ?? "waiting";

// ---------------------------------------------------------------------------
// Shared helpers (imported by mutations.ts / slotHolds.ts triggers)
// ---------------------------------------------------------------------------

/**
 * Schedule the engine for every hourly slot a (now-freed or newly-filled)
 * booking window touches. The engine no-ops where there's nothing to do, so
 * callers never need to pre-check for waitlist entries.
 */
export async function scheduleWaitlistAdvance(
  ctx: any,
  args: { laneId: string; date: string; startHour: number; duration: number }
): Promise<void> {
  const endHour = args.startHour + args.duration / 60;
  const firstHour = Math.floor(args.startHour);
  const lastHour = Math.ceil(endHour) - 1;
  for (let h = firstHour; h <= lastHour; h++) {
    await ctx.scheduler.runAfter(0, internal.waitlist.advanceWaitlistOffer, {
      laneId: args.laneId,
      date: args.date,
      hour: h,
    });
  }
}

/**
 * The offeree just booked their held slot. Consume the 'waitlist' hold and mark
 * their entries 'booked' so the queue doesn't roll on while they're in checkout.
 * No-op for any booking whose user holds no overlapping waitlist hold.
 */
export async function consumeWaitlistHoldForBooking(
  ctx: any,
  args: { userId?: string; laneId: string; date: string; startHour: number; duration: number }
): Promise<void> {
  if (!args.userId) return;
  const endHour = args.startHour + args.duration / 60;

  const holds = await ctx.db
    .query("slotHolds")
    .withIndex("by_laneId_date", (q: any) => q.eq("laneId", args.laneId).eq("date", args.date))
    .collect();
  let consumedAny = false;
  for (const h of holds) {
    if (h.holdType !== "waitlist" || h.userId !== args.userId) continue;
    const hEnd = h.startHour + h.duration / 60;
    if (args.startHour < hEnd && endHour > h.startHour) {
      await ctx.db.delete(h._id);
      consumedAny = true;
    }
  }
  if (!consumedAny) return;

  // Entries are keyed any-lane ('*') — the customer waitlisted for the HOUR, not
  // this specific lane (see advanceWaitlistOffer). Look them up by '*', not the
  // booked lane, or the offeree's entry is never marked booked.
  const entries = await ctx.db
    .query("waitlist")
    .withIndex("by_laneId_date", (q: any) => q.eq("laneId", "*").eq("date", args.date))
    .collect();
  for (const e of entries) {
    if (e.userId !== args.userId) continue;
    const eEnd = e.hour + 1;
    if (args.startHour < eEnd && endHour > e.hour) {
      const st = statusOf(e);
      if (st === "offered" || st === "waiting") {
        await ctx.db.patch(e._id, { status: "booked" });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export const advanceWaitlistOffer = internalMutation({
  args: { laneId: v.string(), date: v.string(), hour: v.number() },
  handler: async (ctx, { laneId: preferLaneId, date, hour }) => {
    const slotStart = hour;
    const slotEnd = hour + 1;
    const now = Date.now();
    const ALL_LANES = Object.keys(LANE_NAME_MAP);

    // FIX — the waitlist auto-offer was dead in production. Customers join the
    // waitlist for an HOUR (any lane): BookingCalendar stores `laneId: '*'`. But
    // every trigger (cancel/reschedule/abandon) passed the freed booking's SPECIFIC
    // lane, so the old `by_slot(laneId)` lookup queried e.g. 'bm3' and never matched
    // the '*' entries → no offer ever fired. The engine is now hour-based: entries
    // are read with '*', occupancy is computed across ALL lanes (primary AND
    // additionalLaneIds), and the exclusive offer + hold land on a currently-free lane.
    const entries = await ctx.db
      .query("waitlist")
      .withIndex("by_slot", (q: any) =>
        q.eq("laneId", "*").eq("date", date).eq("hour", hour)
      )
      .collect();

    const overlaps = (b: any) => {
      const bEnd = b.startHour + b.duration / 60;
      return slotStart < bEnd && slotEnd > b.startHour;
    };
    const occupiesLane = (b: any, lid: string) =>
      b.laneId === lid ||
      (Array.isArray(b.additionalLaneIds) && b.additionalLaneIds.includes(lid));

    // All non-cancelled bookings overlapping this hour (any lane).
    const dayBookings = (
      await ctx.db
        .query("bookings")
        .withIndex("by_date", (q: any) => q.eq("date", date))
        .collect()
    ).filter((b: any) => b.status !== "cancelled" && overlaps(b));
    const IN_FLIGHT = ["pending_payment", "pending", "pending_edit_payment", "tentative"];
    const laneConfirmed = (lid: string) =>
      dayBookings.some((b: any) => b.status === "confirmed" && occupiesLane(b, lid));
    const laneInFlight = (lid: string) =>
      dayBookings.some((b: any) => IN_FLIGHT.includes(b.status) && occupiesLane(b, lid));

    // Delete every 'waitlist' hold overlapping this hour, on ANY lane.
    const deleteWaitlistHolds = async () => {
      for (const lid of ALL_LANES) {
        const holds = await ctx.db
          .query("slotHolds")
          .withIndex("by_laneId_date", (q: any) => q.eq("laneId", lid).eq("date", date))
          .collect();
        for (const h of holds) {
          if (h.holdType !== "waitlist") continue;
          const hEnd = h.startHour + h.duration / 60;
          if (slotStart < hEnd && slotEnd > h.startHour) await ctx.db.delete(h._id);
        }
      }
    };

    // 1. Hour fully booked (every lane has a CONFIRMED booking) → queue dies
    // (decision #6). B-2: only a confirmed booking destroys the queue.
    const filled = ALL_LANES.every((lid) => laneConfirmed(lid));
    if (filled) {
      await deleteWaitlistHolds();
      for (const e of entries) {
        const st = statusOf(e);
        if (st === "waiting" || st === "offered") {
          await ctx.db.patch(e._id, { status: "expired", offerExpiresAt: undefined });
        }
      }
      return { result: "filled_cleared" };
    }

    // 2. Is there a live offer outstanding?
    const offered = entries.find((e: any) => statusOf(e) === "offered");
    if (offered) {
      const exp = offered.offerExpiresAt ? new Date(offered.offerExpiresAt).getTime() : 0;
      if (exp > now) return { result: "offer_live" };
      // Expired offer → retire it and roll on.
      await ctx.db.patch(offered._id, { status: "expired", offerExpiresAt: undefined });
      await deleteWaitlistHolds();
    }

    // 3. Choose the lane to offer: prefer the freed lane, else any lane free this
    // hour. A lane is offerable if it has no confirmed booking and nothing
    // mid-checkout (a checkout hold corresponds to a pending booking = inFlight).
    const isFree = (lid: string) => !laneConfirmed(lid) && !laneInFlight(lid);
    const offerLane =
      preferLaneId !== "*" && isFree(preferLaneId)
        ? preferLaneId
        : ALL_LANES.find((lid) => isFree(lid));
    if (!offerLane) {
      // No free lane right now (e.g. the only openings are mid-checkout) — the
      // checkout hold protects the slot; revisit on confirm / abandonment.
      return { result: "in_flight" };
    }

    // 4. Next waiting member (oldest first).
    const next = entries.find((e: any) => statusOf(e) === "waiting");
    if (!next) {
      await deleteWaitlistHolds();
      return { result: "no_waiting" };
    }

    // 5. Make the exclusive offer (hold + email + roll-on) on the free lane.
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const holdMinutes = (settings as any)?.waitlistOfferHoldMinutes ?? DEFAULT_HOLD_MINUTES;
    const holdMs = holdMinutes * 60 * 1000;
    const expiresAtMs = now + holdMs;

    await ctx.db.patch(next._id, {
      status: "offered",
      offerExpiresAt: new Date(expiresAtMs).toISOString(),
    });
    await ctx.db.insert("slotHolds", {
      laneId: offerLane,
      date,
      startHour: hour,
      duration: 60,
      holdType: "waitlist",
      userId: next.userId,
      userEmail: next.userEmail,
      expiresAt: expiresAtMs,
      createdAt: new Date().toISOString(),
    });

    // 6. Email the exclusive offer with the AWST deadline.
    const laneName = LANE_NAME_MAP[offerLane] ?? offerLane;
    await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistVacancy, {
      to: next.userEmail,
      customerName: next.userName,
      laneName,
      date: fmtAwstDateLabel(date),
      timeSlot: `${fmtHour12(hour)} - ${fmtHour12(hour + 1)}`,
      bookingUrl: `https://krickora.com/?book=${offerLane}&date=${date}&hour=${hour}`,
      otherWaitlistCount: "0",
      offerDeadline: `${fmtAwstTime(expiresAtMs)} AWST`,
    });

    // 7. Roll on at expiry if they don't book.
    await ctx.scheduler.runAfter(holdMs, internal.waitlist.advanceWaitlistOffer, {
      laneId: preferLaneId,
      date,
      hour,
    });

    return { result: "offered", userId: next.userId };
  },
});

// ---------------------------------------------------------------------------
// Admin manual override — re-offer a slot now (NOT the old notify-all blast).
// ---------------------------------------------------------------------------

export const manualAdvanceWaitlistOffer = mutation({
  args: { laneId: v.string(), date: v.string(), hours: v.array(v.number()) },
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

// Admin: clear the live offer + hold for a slot and roll to the next member.
export const adminClearWaitlistOffer = mutation({
  args: { laneId: v.string(), date: v.string(), hour: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const entries = await ctx.db
      .query("waitlist")
      .withIndex("by_slot", (q: any) =>
        q.eq("laneId", args.laneId).eq("date", args.date).eq("hour", args.hour)
      )
      .collect();
    for (const e of entries) {
      if (statusOf(e) === "offered") {
        await ctx.db.patch(e._id, { status: "expired", offerExpiresAt: undefined });
      }
    }
    const holds = await ctx.db
      .query("slotHolds")
      .withIndex("by_laneId_date", (q: any) => q.eq("laneId", args.laneId).eq("date", args.date))
      .collect();
    const slotEnd = args.hour + 1;
    for (const h of holds) {
      if (h.holdType !== "waitlist") continue;
      const hEnd = h.startHour + h.duration / 60;
      if (args.hour < hEnd && slotEnd > h.startHour) await ctx.db.delete(h._id);
    }
    // Roll to the next member immediately.
    await ctx.scheduler.runAfter(0, internal.waitlist.advanceWaitlistOffer, {
      laneId: args.laneId,
      date: args.date,
      hour: args.hour,
    });
    return { cleared: true };
  },
});
