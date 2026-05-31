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

  const entries = await ctx.db
    .query("waitlist")
    .withIndex("by_laneId_date", (q: any) => q.eq("laneId", args.laneId).eq("date", args.date))
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
  handler: async (ctx, { laneId, date, hour }) => {
    const slotStart = hour;
    const slotEnd = hour + 1;
    const now = Date.now();

    // Entries for this exact slot. by_slot fully specifies the key, so remaining
    // order is _creationTime ascending → oldest waitlisted member first.
    const entries = await ctx.db
      .query("waitlist")
      .withIndex("by_slot", (q: any) =>
        q.eq("laneId", laneId).eq("date", date).eq("hour", hour)
      )
      .collect();

    // Delete every 'waitlist' hold overlapping this slot.
    const deleteWaitlistHolds = async () => {
      const holds = await ctx.db
        .query("slotHolds")
        .withIndex("by_laneId_date", (q: any) => q.eq("laneId", laneId).eq("date", date))
        .collect();
      for (const h of holds) {
        if (h.holdType !== "waitlist") continue;
        const hEnd = h.startHour + h.duration / 60;
        if (slotStart < hEnd && slotEnd > h.startHour) await ctx.db.delete(h._id);
      }
    };

    // 1. Is the slot actually filled / in-flight?
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_laneId_date", (q: any) => q.eq("laneId", laneId).eq("date", date))
      .collect();
    const overlaps = (b: any) => {
      const bEnd = b.startHour + b.duration / 60;
      return slotStart < bEnd && slotEnd > b.startHour;
    };
    const filled = bookings.some(
      (b: any) => overlaps(b) && (b.status === "confirmed" || b.status === "tentative")
    );
    if (filled) {
      // Slot taken — clear the queue for this exact slot (decision #6) and drop
      // any leftover hold. Members can re-add if it reopens.
      await deleteWaitlistHolds();
      for (const e of entries) {
        const st = statusOf(e);
        if (st === "waiting" || st === "offered") {
          await ctx.db.patch(e._id, { status: "expired", offerExpiresAt: undefined });
        }
      }
      return { result: "filled_cleared" };
    }
    const inFlight = bookings.some(
      (b: any) =>
        overlaps(b) &&
        (b.status === "pending_payment" ||
          b.status === "pending" ||
          b.status === "pending_edit_payment")
    );
    if (inFlight) {
      // Someone (often the offeree) is mid-checkout — don't roll. Their checkout
      // hold protects the slot; we revisit on confirm / abandonment.
      return { result: "in_flight" };
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

    // 3. Next waiting member (oldest first).
    const next = entries.find((e: any) => statusOf(e) === "waiting");
    if (!next) {
      await deleteWaitlistHolds();
      return { result: "no_waiting" };
    }

    // 4. Make the exclusive offer.
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
      laneId,
      date,
      startHour: hour,
      duration: 60,
      holdType: "waitlist",
      userId: next.userId,
      userEmail: next.userEmail,
      expiresAt: expiresAtMs,
      createdAt: new Date().toISOString(),
    });

    // 5. Email the exclusive offer with the AWST deadline.
    const laneName = LANE_NAME_MAP[laneId] ?? laneId;
    await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistVacancy, {
      to: next.userEmail,
      customerName: next.userName,
      laneName,
      date: fmtAwstDateLabel(date),
      timeSlot: `${fmtHour12(hour)} - ${fmtHour12(hour + 1)}`,
      bookingUrl: `https://krickora.com/?book=${laneId}&date=${date}&hour=${hour}`,
      otherWaitlistCount: "0",
      offerDeadline: `${fmtAwstTime(expiresAtMs)} AWST`,
    });

    // 6. Roll on at expiry if they don't book.
    await ctx.scheduler.runAfter(holdMs, internal.waitlist.advanceWaitlistOffer, {
      laneId,
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
