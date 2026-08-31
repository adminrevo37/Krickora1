// SPEC_WAITLIST_ALT_TIME_OFFER_2026-08 — offer a waitlist queue a DIFFERENT time.
//
// Motivating case (Inspector, 2026-08-14): two customers are queued for 8–9am
// tomorrow; a 9–10am booking cancels. The existing engine cannot help — it is
// keyed on (pool, date, hour) all the way down, so "Offer now" on the 8am queue
// only ever looks for a free lane AT 8am and quietly does nothing.
//
// This module adds a separate mechanism rather than bending that engine, because
// the semantics are genuinely different:
//
//   · MULTIPLE recipients  → an open RACE. No hold. First to book wins. The
//     notification says so explicitly, which is what makes it fair.
//   · SINGLE recipient     → the usual EXCLUSIVE first-refusal: a real slotHold
//     is placed so nobody can take it from under them.
//
// Other locked decisions:
//   · Pool-level, never a pinned lane — the offer is "a BM lane at 9am", so it
//     survives the originally-freed lane being taken while another is free.
//   · No timer. The offer dies when the session start passes, or when the slot
//     fills, or when an admin cancels it.
//   · Accepting ASKS whether to drop their original queue entry — never silent.
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin, getCallerContext } from "./lib/adminGuard";
import { resolveDayLanes } from "./lanes";
import { resolveSegment, segmentIsClosed, segmentStartHours } from "./lib/lanes";
import { fmtAwstDateLabel, fmtAwstDateShort } from "./lib/dates";

type Pool = "bm" | "ru";

function fmtHour12(h: number): string {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  const period = hr >= 12 ? "PM" : "AM";
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${display}:${min.toString().padStart(2, "0")} ${period}`;
}
/** ms for a (date, hour) in AWST — used only to tell whether the slot has passed. */
function slotStartMs(date: string, hour: number): number {
  const whole = Math.floor(hour);
  const mins = Math.round((hour - whole) * 60);
  return Date.parse(
    `${date}T${String(whole).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00+08:00`
  );
}

const POOL_SENTINEL: Record<Pool, string> = { bm: "*bm", ru: "*ru" };

/** The day's bookings / service blocks / live holds, read ONCE. */
async function loadDayAvailability(ctx: any, date: string) {
  const now = Date.now();
  return {
    bookings: (
      await ctx.db.query("bookings").withIndex("by_date", (q: any) => q.eq("date", date)).collect()
    ).filter((b: any) => b.status !== "cancelled"),
    blocks: await ctx.db
      .query("laneBlocks")
      .withIndex("by_date", (q: any) => q.eq("date", date))
      .collect(),
    holds: (
      await ctx.db.query("slotHolds").withIndex("by_date", (q: any) => q.eq("date", date)).collect()
    ).filter((h: any) => h.expiresAt > now),
  };
}

type DayAvailability = Awaited<ReturnType<typeof loadDayAvailability>>;
type DayLane = { laneId: string; bayNumber: number; segments: any[] };

/**
 * Lane ids of `pool` that can host a full hour starting at `hour`:
 *   · the segment covering that hour runs this pool's mode and is open
 *   · the hour does not cross the segment's end (bookings may not cross a boundary)
 *   · no overlapping booking, service block, or someone else's live hold
 * Pure/in-memory so a whole day can be evaluated from one set of reads.
 */
function freeLaneIdsAt(
  day: DayAvailability,
  dayLanes: DayLane[],
  hour: number,
  pool: Pool,
  ignoreHoldUserId?: string
): string[] {
  const slotEnd = hour + 1;
  const overlaps = (startHour: number, durationMinutes: number) =>
    hour < startHour + durationMinutes / 60 && slotEnd > startHour;
  const occupies = (row: any, laneId: string) =>
    row.laneId === laneId ||
    (Array.isArray(row.additionalLaneIds) && row.additionalLaneIds.includes(laneId));

  const out: string[] = [];
  for (const lane of dayLanes) {
    const seg = resolveSegment(lane.segments as any, hour);
    if (!seg) continue;
    if (segmentIsClosed(seg)) continue;
    // Mode is a property of the SEGMENT — this is what makes "RU 4 running as a
    // bowling machine from 9:30am" land in the BM pool for exactly those hours.
    const segPool: Pool = seg.mode === "RU" ? "ru" : "bm";
    if (segPool !== pool) continue;
    if (slotEnd > seg.endHour + 1e-9) continue; // would cross the boundary
    if (day.bookings.some((b: any) => overlaps(b.startHour, b.duration) && occupies(b, lane.laneId))) continue;
    if (day.blocks.some((b: any) => overlaps(b.startHour, b.duration) && (b.laneId === lane.laneId || b.laneId === "all"))) continue;
    if (
      day.holds.some(
        (h: any) =>
          overlaps(h.startHour, h.duration) &&
          occupies(h, lane.laneId) &&
          (!ignoreHoldUserId || h.userId !== ignoreHoldUserId)
      )
    )
      continue;
    out.push(lane.laneId);
  }
  return out;
}

/**
 * Same question for a single hour, loading what it needs. Used by the create-time
 * validation and the customer-side liveness check so they can never disagree with
 * the dropdown the admin picked from.
 */
async function freeLanesInPool(
  ctx: any,
  date: string,
  hour: number,
  pool: Pool,
  ignoreHoldUserId?: string
): Promise<string[]> {
  const [day, dayLanes] = await Promise.all([
    loadDayAvailability(ctx, date),
    resolveDayLanes(ctx, date),
  ]);
  return freeLaneIdsAt(day, dayLanes as DayLane[], hour, pool, ignoreHoldUserId);
}

// ---------------------------------------------------------------------------
// ADMIN — which times can actually be offered for this pool on this date
// ---------------------------------------------------------------------------
/**
 * The admin dropdown used to be a naive 6am–9pm whole-hour loop, which offered
 * times with no free lane and was blind to per-date layouts. This enumerates the
 * day's REAL start times from the segment config — explicit start lists, cadences
 * and half-hour segment openings all included — and returns only those where a
 * lane of this pool is genuinely free for the full hour.
 */
export const listOfferableTimes = query({
  args: { date: v.string(), pool: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return [];
    const pool = args.pool === "ru" ? "ru" : ("bm" as Pool);

    const [day, dayLanesRaw] = await Promise.all([
      loadDayAvailability(ctx, args.date),
      resolveDayLanes(ctx, args.date),
    ]);
    const dayLanes = dayLanesRaw as DayLane[];

    // Candidate starts = every start time any THIS-POOL segment actually offers.
    const candidates = new Set<number>();
    for (const lane of dayLanes) {
      for (const seg of lane.segments as any[]) {
        if (segmentIsClosed(seg)) continue;
        const segPool: Pool = seg.mode === "RU" ? "ru" : "bm";
        if (segPool !== pool) continue;
        for (const h of segmentStartHours(seg)) candidates.add(h);
      }
    }

    const nowMs = Date.now();
    return [...candidates]
      .sort((a, b) => a - b)
      .filter((h) => slotStartMs(args.date, h) > nowMs) // never offer a time that has passed
      .map((hour) => ({ hour, freeLaneIds: freeLaneIdsAt(day, dayLanes, hour, pool) }))
      .filter((r) => r.freeLaneIds.length > 0)
      .map((r) => ({
        hour: r.hour,
        label: `${fmtHour12(r.hour)} – ${fmtHour12(r.hour + 1)}`,
        // Name resolved at THIS hour, so a run-up lane running BM shows as "BM 4".
        laneNames: r.freeLaneIds.map((id) => {
          const lane = dayLanes.find((l) => l.laneId === id)!;
          const seg = resolveSegment(lane.segments as any, r.hour);
          return `${seg.mode} ${lane.bayNumber}`;
        }),
      }));
  },
});

// ---------------------------------------------------------------------------
// ADMIN — create an offer
// ---------------------------------------------------------------------------
export const createWaitlistOffer = mutation({
  args: {
    pool: v.string(), // 'bm' | 'ru'
    date: v.string(),
    hour: v.number(), // the OFFERED hour (e.g. 9 for the 9–10am cancellation)
    sourceHour: v.number(), // the hour the queue is waiting on (e.g. 8)
    waitlistEntryIds: v.array(v.string()), // whom to offer it to
    // Optional free-text note from the admin, shown in BOTH the email and the
    // push, above the standard exclusive/race note.
    customNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const pool = args.pool === "ru" ? "ru" : ("bm" as Pool);

    if (args.waitlistEntryIds.length === 0) {
      throw new ConvexError("Pick at least one customer to offer this slot to.");
    }
    if (slotStartMs(args.date, args.hour) <= Date.now()) {
      throw new ConvexError("That session has already started — pick a later slot.");
    }

    // The slot must actually be offerable right now, or we'd send a dead link.
    const free = await freeLanesInPool(ctx, args.date, args.hour, pool);
    if (free.length === 0) {
      throw new ConvexError(
        `No ${pool.toUpperCase()} lane is free at ${fmtHour12(args.hour)} — nothing to offer.`
      );
    }

    // Resolve the chosen queue rows into recipients.
    const recipients: Array<{
      userId: string;
      userEmail: string;
      userName: string;
      waitlistEntryId: string;
    }> = [];
    const sentinel = POOL_SENTINEL[pool];
    for (const id of args.waitlistEntryIds) {
      let row: any = null;
      try { row = await ctx.db.get(id as any); } catch { row = null; }
      // Only rows that are genuinely in the queue being offered: right table shape,
      // right date, right pool, and waiting on the hour the admin said they were.
      // Without this an id from another queue (or another table) could be offered a
      // slot its owner never asked about.
      if (!row || typeof row.userEmail !== "string" || typeof row.hour !== "number") continue;
      if (row.date !== args.date) continue;
      if (row.hour !== args.sourceHour) continue;
      if (row.laneId !== sentinel && row.laneId !== "*") continue; // pool or legacy any-lane
      if (recipients.some((r) => r.userEmail.toLowerCase() === row.userEmail.toLowerCase())) continue;
      recipients.push({
        userId: row.userId,
        userEmail: row.userEmail,
        userName: row.userName,
        waitlistEntryId: String(row._id),
      });
    }
    if (recipients.length === 0) throw new ConvexError("Those waitlist entries no longer exist.");

    // 2026-08-18 (Inspector) — an alt-time offer NEVER holds the slot, whatever
    // the recipient count. It is a heads-up that a slot is free, not a
    // reservation: the general public must still be able to book it.
    //
    // This reverses the original 2026-08-14 decision (single recipient => a real
    // exclusive slotHold until the session started). In practice that took a
    // sellable slot off the market for hours on the chance one person acted on a
    // notification, which is the wrong trade for a facility trying to fill lanes.
    //
    // The field is KEPT on the schema, and every release path below still honours
    // it, so any offer created before today that still holds a lane is cleaned up
    // correctly when it is cancelled or accepted. Nothing new sets it true.
    const exclusive = false;

    const tokenBytes = new Uint8Array(16);
    crypto.getRandomValues(tokenBytes);
    const token = `wo_${Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

    const offerId = await ctx.db.insert("waitlistOffers", {
      pool,
      date: args.date,
      hour: args.hour,
      sourceHour: args.sourceHour,
      recipients,
      exclusive,
      status: "live",
      token,
      createdAt: Date.now(),
      createdByEmail: admin.email ?? "admin",
    });

    // No slotHold is written. An alt-time offer is a notification, not a
    // reservation — the slot stays on sale to the public the whole time.

    // Notify every recipient on BOTH channels — push AND email, every time
    // (Inspector 2026-08-14). Push alone would silently miss anyone who hasn't
    // enabled notifications or is on a device that never registered.
    const when = `${fmtHour12(args.hour)} - ${fmtHour12(args.hour + 1)}`;
    const dateLabel = fmtAwstDateLabel(args.date);
    const dateLabelShort = fmtAwstDateShort(args.date);
    const poolLabel = pool === "bm" ? "bowling machine" : "run-up";
    const offerUrl = `/?offer=${token}`;
    // The recipient must never think the slot is being held for them — it isn't.
    // Say so plainly, and scale the wording to how many people were told.
    const sharedNote =
      recipients.length === 1
        ? "This slot is not reserved — it stays available to everyone until someone books it, so book now to secure it."
        : `This has been offered to ${recipients.length} people on the waitlist, and the slot also stays on sale to everyone else — first to book gets it.`;
    const customNote = (args.customNote ?? "").trim();

    for (const r of recipients) {
      await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistAltTimeOffer, {
        to: r.userEmail,
        customerName: r.userName,
        poolLabel,
        date: dateLabel,
        dateShort: dateLabelShort,
        timeSlot: when,
        requestedSlot: `${fmtHour12(args.sourceHour)} - ${fmtHour12(args.sourceHour + 1)}`,
        note: sharedNote,
        customNote: customNote || undefined,
        bookingUrl: `https://cricketrevolution.com.au${offerUrl}`,
      });
      await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
        email: r.userEmail,
        category: "waitlist-offers",
        title: "A different time has opened up 🏏",
        body: [
          `${dateLabel}, ${when} on a ${poolLabel} lane — you asked for ${fmtHour12(args.sourceHour)}.`,
          customNote,
          sharedNote,
        ]
          .filter(Boolean)
          .join(" "),
        url: offerUrl,
        tag: `wl-alt-${args.date}-${args.hour}`,
      });
    }

    return { offerId, token, recipients: recipients.length, exclusive };
  },
});

// ---------------------------------------------------------------------------
// ADMIN — cancel a live offer
// ---------------------------------------------------------------------------
export const cancelWaitlistOffer = mutation({
  args: { offerId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const offer: any = await ctx.db.get(args.offerId as any);
    if (!offer) throw new ConvexError("Offer not found.");
    if (offer.status !== "live") return { ok: true, alreadyClosed: true };

    // Release the exclusive hold, if this was a single-recipient offer.
    if (offer.exclusive) {
      const holds = await ctx.db
        .query("slotHolds")
        .withIndex("by_date", (q: any) => q.eq("date", offer.date))
        .collect();
      for (const h of holds as any[]) {
        if (
          h.holdType === "waitlist" &&
          h.startHour === offer.hour &&
          h.userId === offer.recipients[0]?.userId
        ) {
          await ctx.db.delete(h._id);
        }
      }
    }
    await ctx.db.patch(args.offerId as any, { status: "cancelled" });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// ADMIN — live offers, for the waitlist tab
// ---------------------------------------------------------------------------
export const listLiveWaitlistOffers = query({
  args: {},
  handler: async (ctx) => {
    const caller = await getCallerContext(ctx);
    if (!caller.isAdmin) return [];
    const rows = await ctx.db
      .query("waitlistOffers")
      .withIndex("by_status", (q: any) => q.eq("status", "live"))
      .collect();
    const now = Date.now();
    return (rows as any[])
      .filter((o) => slotStartMs(o.date, o.hour) > now) // self-expired ones drop out
      .map((o) => ({
        id: String(o._id),
        pool: o.pool,
        date: o.date,
        hour: o.hour,
        sourceHour: o.sourceHour,
        exclusive: o.exclusive,
        recipientCount: o.recipients.length,
        recipientNames: o.recipients.map((r: any) => r.userName),
        createdAt: o.createdAt,
      }));
  },
});

// ---------------------------------------------------------------------------
// CUSTOMER — resolve the ?offer=<token> deep link
// ---------------------------------------------------------------------------
export const getOfferByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    const offer: any = await ctx.db
      .query("waitlistOffers")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first();
    if (!offer) return { state: "not_found" as const };

    // Only a named recipient may act on it (the token is not a bearer capability
    // for the general public).
    const email = (caller.email ?? "").toLowerCase();
    const me = offer.recipients.find((r: any) => r.userEmail.toLowerCase() === email);
    if (!me) return { state: "not_yours" as const };

    if (offer.status === "cancelled") return { state: "cancelled" as const };
    if (offer.status === "booked") {
      return {
        state: (offer.bookedByEmail?.toLowerCase() === email ? "booked_by_you" : "taken") as
          | "booked_by_you"
          | "taken",
      };
    }
    if (slotStartMs(offer.date, offer.hour) <= Date.now()) return { state: "passed" as const };

    // Liveness is COMPUTED: a public customer booking the slot kills the offer with
    // no write-path coupling. The exclusive holder ignores their own hold.
    const free = await freeLanesInPool(
      ctx,
      offer.date,
      offer.hour,
      offer.pool,
      offer.exclusive ? me.userId : undefined
    );
    if (free.length === 0) return { state: "taken" as const };

    return {
      state: "live" as const,
      offerId: String(offer._id),
      pool: offer.pool as Pool,
      laneId: free[0], // a lane that is free right now; server re-validates at booking
      date: offer.date,
      hour: offer.hour,
      sourceHour: offer.sourceHour,
      exclusive: offer.exclusive,
      recipientCount: offer.recipients.length,
      waitlistEntryId: me.waitlistEntryId ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// CUSTOMER — called after the booking succeeds
// ---------------------------------------------------------------------------
export const acceptWaitlistOffer = mutation({
  args: {
    offerId: v.string(),
    bookingId: v.string(),
    dropOriginalEntry: v.boolean(),
  },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    const email = (caller.email ?? "").toLowerCase();
    if (!email) throw new ConvexError("Please sign in.");

    const offer: any = await ctx.db.get(args.offerId as any);
    if (!offer) return { ok: false as const, reason: "not_found" };
    const me = offer.recipients.find((r: any) => r.userEmail.toLowerCase() === email);
    if (!me) return { ok: false as const, reason: "not_yours" };

    // Close the offer to everyone else. Losing this race is harmless — the booking
    // itself is already made and the server validated availability; this only
    // stops further links resolving as live.
    if (offer.status === "live") {
      await ctx.db.patch(args.offerId as any, {
        status: "booked",
        bookedByEmail: email,
        bookedBookingId: args.bookingId,
      });
    }

    // Release the exclusive hold now it has been used.
    if (offer.exclusive) {
      const holds = await ctx.db
        .query("slotHolds")
        .withIndex("by_date", (q: any) => q.eq("date", offer.date))
        .collect();
      for (const h of holds as any[]) {
        if (h.holdType === "waitlist" && h.startHour === offer.hour && h.userId === me.userId) {
          await ctx.db.delete(h._id);
        }
      }
    }

    // Their ORIGINAL queue entry is only dropped if they said so (decision: never
    // silently withdraw a preference they didn't withdraw).
    let droppedEntry = false;
    if (args.dropOriginalEntry && me.waitlistEntryId) {
      const entry: any = await ctx.db.get(me.waitlistEntryId as any);
      if (entry && entry.userEmail.toLowerCase() === email) {
        await ctx.db.delete(entry._id);
        droppedEntry = true;
      }
    }
    return { ok: true as const, droppedEntry };
  },
});
