import { internalMutation, mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin, getCallerContext } from "./lib/adminGuard";
import { resolveLanesAtHour } from "./lanes";
import { segmentHasCustomStarts, segmentStartHours } from "./lib/lanes";
import { fmtAwstDateLabel } from "./lib/dates";

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

// SPEC_WAITLIST_SPLIT_BM_RU — the waitlist is split into two POOLS keyed by the
// lane MODE at the entry's (date, hour): BM (bowling machines, incl. Truman) and
// RU (run-ups). Entries carry a sentinel laneId: '*bm' / '*ru'. Legacy '*' rows
// (pre-split "any lane") are honoured as matching EITHER pool until they resolve.
// Pool membership of a real lane is resolved from live lane config per hour
// (resolveLanesAtHour) — a lane running as BM for part of a day is in the BM pool
// for exactly those hours. This also removed the old hardcoded LANE_NAME_MAP (F3).
export type WaitlistPool = "bm" | "ru";
export const POOL_SENTINELS: Record<WaitlistPool, string> = { bm: "*bm", ru: "*ru" };
const ALL_SENTINELS = ["*", "*bm", "*ru"];

function fmtHour12(h: number): string {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  const period = hr >= 12 ? "PM" : "AM";
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${display}:${min.toString().padStart(2, "0")} ${period}`;
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

// SPEC_ANALYTICS_BUILD_2026-06 — log a waitlist-offer lifecycle event. Response
// actions (accepted/declined/expired) carry latencyMs = now − the entry's
// offeredAt, so the dashboard can report median time-to-accept/reject and the
// share who never press a button. Best-effort: never blocks the engine.
async function logWaitlistOfferEvent(
  ctx: any,
  // 'lapsed' (Part A reaper) = the session ended with the entry never offered —
  // a different signal from an offer someone ignored ('expired').
  action: "offered" | "accepted" | "declined" | "expired" | "lapsed",
  entry: any,
  slot?: { laneId?: string; date?: string; hour?: number }
): Promise<void> {
  try {
    const offeredAt = entry?.offeredAt;
    const latencyMs =
      action !== "offered" && typeof offeredAt === "number"
        ? Math.max(0, Date.now() - offeredAt)
        : undefined;
    await ctx.db.insert("waitlistOfferEvents", {
      at: Date.now(),
      action,
      email: entry?.userEmail?.toLowerCase?.().trim?.(),
      laneId: slot?.laneId,
      date: slot?.date ?? entry?.date,
      hour: slot?.hour ?? entry?.hour,
      latencyMs,
    });
  } catch {
    /* analytics logging must never break the waitlist engine */
  }
}

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
  args: {
    laneId: string;
    // SPEC_WAITLIST_SPLIT_BM_RU — a freed REAL lane services only ITS pool's
    // queue now, so a multi-lane booking (primary + additionalLaneIds spanning
    // BM and RU lanes) must schedule an advance for EVERY freed lane, or the
    // other pool's waiters are never offered the freed lane. The engine is
    // idempotent — a second invocation for the same pool no-ops / offer_lives.
    additionalLaneIds?: string[];
    date: string;
    startHour: number;
    duration: number;
  }
): Promise<void> {
  const endHour = args.startHour + args.duration / 60;
  const firstHour = Math.floor(args.startHour);
  const lastHour = Math.ceil(endHour) - 1;
  const lanes = Array.from(new Set([args.laneId, ...(args.additionalLaneIds ?? [])]));
  for (const laneId of lanes) {
    for (let h = firstHour; h <= lastHour; h++) {
      await ctx.scheduler.runAfter(0, internal.waitlist.advanceWaitlistOffer, {
        laneId,
        date: args.date,
        hour: h,
      });
    }
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

  // Entries are keyed by pool sentinel ('*bm'/'*ru', legacy '*') — the customer
  // waitlisted for the HOUR, not this specific lane. Look them up by sentinel,
  // not the booked lane, or the offeree's entry is never marked booked. Booking
  // ANY lane in the hour retires their entries in BOTH pools (they have a
  // session that hour — decision #2 of SPEC_WAITLIST_SPLIT_BM_RU).
  const entries: any[] = [];
  for (const sentinel of ALL_SENTINELS) {
    const rows = await ctx.db
      .query("waitlist")
      .withIndex("by_laneId_date", (q: any) => q.eq("laneId", sentinel).eq("date", args.date))
      .collect();
    entries.push(...rows);
  }
  for (const e of entries) {
    if (e.userId !== args.userId) continue;
    const eEnd = e.hour + 1;
    if (args.startHour < eEnd && endHour > e.hour) {
      const st = statusOf(e);
      if (st === "offered" || st === "waiting") {
        await ctx.db.patch(e._id, { status: "booked" });
        // An offered entry that books the held slot = the offer was ACCEPTED.
        if (st === "offered") await logWaitlistOfferEvent(ctx, "accepted", e);
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

    // SPEC_WAITLIST_SPLIT_BM_RU — the engine is POOL-aware. Lane set + each
    // lane's pool ('bm'/'ru') come from live lane config resolved at this
    // (date, hour) (override + segment aware — the F3 fix), so a lane running
    // as BM for part of a day is BM-pool for exactly those hours. A freed REAL
    // lane services its own pool's queue; '*'/'*bm'/'*ru' invocations (manual
    // kicks, roll-ons, legacy triggers) service the named pool(s). One
    // invocation can make one offer PER pool (two holds on different lanes).
    const lanesAt = await resolveLanesAtHour(ctx, date, hour);
    const laneInfo = new Map(lanesAt.map((l) => [l.laneId, l]));
    const openLanes = lanesAt.filter((l) => !l.closed);
    const poolLaneIds = (p: WaitlistPool) =>
      openLanes.filter((l) => l.pool === p).map((l) => l.laneId);

    let targetPools: WaitlistPool[];
    if (preferLaneId === "*bm") targetPools = ["bm"];
    else if (preferLaneId === "*ru") targetPools = ["ru"];
    else if (laneInfo.has(preferLaneId)) targetPools = [laneInfo.get(preferLaneId)!.pool];
    else targetPools = ["bm", "ru"];

    // Entries: each pool's queue = its sentinel rows + legacy '*' (any-lane)
    // rows, FIFO by creation time across both.
    const readEntries = async (sentinel: string) =>
      await ctx.db
        .query("waitlist")
        .withIndex("by_slot", (q: any) =>
          q.eq("laneId", sentinel).eq("date", date).eq("hour", hour)
        )
        .collect();
    const legacyEntries = await readEntries("*");
    const byCreation = (a: any, b: any) => a._creationTime - b._creationTime;
    const entriesByPool: Record<WaitlistPool, any[]> = {
      bm: [...(await readEntries("*bm")), ...legacyEntries].sort(byCreation),
      ru: [...(await readEntries("*ru")), ...legacyEntries].sort(byCreation),
    };
    const allEntries = [
      ...entriesByPool.bm,
      ...entriesByPool.ru.filter((e) => e.laneId !== "*"),
    ];

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
    const IN_FLIGHT = ["pending_payment", "pending", "pending_edit_payment"];
    const laneConfirmed = (lid: string) =>
      dayBookings.some((b: any) => b.status === "confirmed" && occupiesLane(b, lid));
    const laneInFlight = (lid: string) =>
      dayBookings.some((b: any) => IN_FLIGHT.includes(b.status) && occupiesLane(b, lid));

    // THIS hour's waitlist holds (by_date — no hardcoded lane loop). Owned-hour
    // scoping is by floor(startHour), NOT window overlap: a SNAPPED offer hold
    // (e.g. 10:30–11:30 on a custom-start grid) spills into the next hour, and
    // hour-11 engine runs must never clean up hour-10's live offer hold.
    // Pool-scoped deletion resolves each hold's lane to its pool, so clearing
    // one pool never drops the OTHER pool's live offer hold either.
    const dayHolds = await ctx.db
      .query("slotHolds")
      .withIndex("by_date", (q: any) => q.eq("date", date))
      .collect();
    const hourWaitlistHolds = dayHolds.filter(
      (h: any) => h.holdType === "waitlist" && Math.floor(h.startHour) === hour
    );
    const deleted = new Set<string>();
    const deleteHoldsForPool = async (p: WaitlistPool | "all") => {
      for (const h of hourWaitlistHolds) {
        if (deleted.has(h._id)) continue;
        if (p !== "all" && laneInfo.get(h.laneId)?.pool !== p) continue;
        await ctx.db.delete(h._id);
        deleted.add(h._id);
      }
    };

    // COL-3 (audit 2026-06): never hand out a slot the offeree can't actually
    // book. Whole-day closure → no offerable lane in EITHER pool: revert any
    // outstanding offers to 'waiting' (the roll-on re-evaluates on reopen) and
    // clear all waitlist holds for the hour.
    const closure = await ctx.db
      .query("closures")
      .withIndex("by_date", (q: any) => q.eq("date", date))
      .first();
    if (closure) {
      for (const e of allEntries) {
        if (statusOf(e) === "offered") {
          await ctx.db.patch(e._id, { status: "waiting", offerExpiresAt: undefined });
        }
      }
      await deleteHoldsForPool("all");
      return { result: "closed" };
    }

    // Lanes with a service/repair block overlapping this hour aren't offerable.
    // Keep the rows per lane too — a SNAPPED offer window (custom-start grid)
    // can extend past the hour and must be re-checked against blocks.
    const blockedLanes = new Set<string>();
    const blocksByLane = new Map<string, any[]>();
    for (const l of openLanes) {
      const blocks = await ctx.db
        .query("laneBlocks")
        .withIndex("by_laneId_date", (q: any) => q.eq("laneId", l.laneId).eq("date", date))
        .collect();
      blocksByLane.set(l.laneId, blocks);
      if (
        blocks.some(
          (b: any) => slotStart < b.startHour + b.duration / 60 && slotEnd > b.startHour
        )
      ) {
        blockedLanes.add(l.laneId);
      }
    }

    // Legacy '*' entries only die when EVERY open lane (both pools) is confirmed.
    const allOpenConfirmed =
      openLanes.length > 0 && openLanes.every((l) => laneConfirmed(l.laneId));

    const results: Record<string, string> = {};
    // An entry may appear in both pools' lists (legacy '*') — never offer it twice
    // in one invocation.
    const claimed = new Set<string>();

    for (const pool of targetPools) {
      const lanes = poolLaneIds(pool);
      const entries = entriesByPool[pool];
      if (lanes.length === 0) {
        // No lanes of this mode at this hour (layout override / all closed) —
        // nothing to offer OR expire; the queue survives a layout change back.
        results[pool] = "no_lanes";
        continue;
      }

      // 1. Pool fully booked (every lane of this mode has a CONFIRMED booking)
      // → this pool's queue dies. B-2: only confirmed bookings destroy a queue.
      const filled = lanes.every((lid) => laneConfirmed(lid));
      if (filled) {
        await deleteHoldsForPool(pool);
        for (const e of entries) {
          const st = statusOf(e);
          const isLegacy = e.laneId === "*";
          if ((st === "waiting" || st === "offered") && (!isLegacy || allOpenConfirmed)) {
            await ctx.db.patch(e._id, { status: "expired", offerExpiresAt: undefined });
            if (st === "offered") await logWaitlistOfferEvent(ctx, "expired", e, { date, hour });
          } else if (isLegacy && st === "offered") {
            // Legacy '*' offer surviving a pool-fill (the other pool still has
            // room): if its protecting hold was on THIS pool's just-cleared
            // lanes, don't leave a hold-less live offer — revert it to waiting
            // so the other pool's advance can re-offer it a fresh lane. If its
            // hold sits in the other pool, it's untouched and the offer stands.
            const hasLiveHold = hourWaitlistHolds.some(
              (h: any) => !deleted.has(h._id) && h.userId === e.userId
            );
            if (!hasLiveHold) {
              await ctx.db.patch(e._id, { status: "waiting", offerExpiresAt: undefined });
            }
          }
        }
        results[pool] = "filled_cleared";
        continue;
      }

      // 2. Live offer outstanding? A pool-sentinel offer blocks only its pool.
      // A live LEGACY '*' offer conservatively blocks both pools (its held lane
      // isn't recorded on the entry; resolves within the hold window).
      const offered = entries.find((e: any) => statusOf(e) === "offered" && !claimed.has(e._id));
      if (offered) {
        const exp = offered.offerExpiresAt ? new Date(offered.offerExpiresAt).getTime() : 0;
        if (exp > now) {
          results[pool] = "offer_live";
          continue;
        }
        // Expired offer → retire it and roll on. The offeree never pressed a button.
        // Hold cleanup: this pool's lanes + (for a legacy '*' entry, whose held
        // lane could sit in either pool) THIS offer instance's hold, matched by
        // expiresAt — never the same user's live offer in the other pool.
        const offeredExp = offered.offerExpiresAt
          ? new Date(offered.offerExpiresAt).getTime()
          : 0;
        await ctx.db.patch(offered._id, { status: "expired", offerExpiresAt: undefined });
        await logWaitlistOfferEvent(ctx, "expired", offered, { date, hour });
        await deleteHoldsForPool(pool);
        if (offered.laneId === "*") {
          for (const h of hourWaitlistHolds) {
            if (deleted.has(h._id)) continue;
            if (h.userId === offered.userId && h.expiresAt === offeredExp) {
              await ctx.db.delete(h._id);
              deleted.add(h._id);
            }
          }
        }
      }

      // 3. Choose the lane AND the exact start to offer: prefer the freed lane
      // if it's in this pool, else any free lane OF THIS POOL. A lane is
      // offerable if it has no confirmed booking and nothing mid-checkout.
      // OFFER-SNAP (2026-08-11): on a segment with admin-defined custom starts,
      // an :00 deep-link would be server-rejected (off-cadence) — snap to the
      // earliest allowed start inside [hour, hour+1) whose 60-min window is
      // conflict-free, stays inside the segment, and passes the Option A
      // end-alignment. No such start → the lane isn't offerable this hour.
      const isFree = (lid: string) =>
        !laneConfirmed(lid) && !laneInFlight(lid) && !blockedLanes.has(lid);
      const overlapsWindow = (b: any, ws: number, we: number) => {
        const bEnd = b.startHour + b.duration / 60;
        return ws < bEnd && we > b.startHour;
      };
      const windowTaken = (lid: string, ws: number, we: number) =>
        dayBookings.some(
          (b: any) =>
            (b.status === "confirmed" || IN_FLIGHT.includes(b.status)) &&
            occupiesLane(b, lid) &&
            overlapsWindow(b, ws, we)
        );
      const windowBlocked = (lid: string, ws: number, we: number) =>
        (blocksByLane.get(lid) ?? []).some(
          (b: any) => ws < b.startHour + b.duration / 60 && we > b.startHour
        );
      // Another live waitlist hold overlapping the window (e.g. a neighbouring
      // hour's SNAPPED offer spilling into this one) — never double-hold a lane.
      const windowHeldByOther = (lid: string, ws: number, we: number) =>
        dayHolds.some(
          (h: any) =>
            (h.holdType === "waitlist" || h.holdType === "waitlist-alt") &&
            !deleted.has(h._id) &&
            h.laneId === lid &&
            ws < h.startHour + h.duration / 60 &&
            we > h.startHour
        );
      const offerStartFor = (lid: string): number | null => {
        if (!isFree(lid)) return null;
        const seg = laneInfo.get(lid)?.segment;
        if (!seg || !segmentHasCustomStarts(seg)) {
          return windowHeldByOther(lid, hour, hour + 1) ? null : hour;
        }
        const allowed = segmentStartHours(seg);
        const cands = allowed
          .filter((s) => s >= hour - 1e-6 && s < hour + 1 - 1e-6)
          .sort((a, b) => a - b);
        for (const s of cands) {
          const end = s + 1;
          if (end > seg.endHour + 1e-6) continue; // would cross the segment
          const endAligned =
            Math.abs(end - seg.endHour) < 1e-6 ||
            allowed.some((h2) => Math.abs(h2 - end) < 1e-6) ||
            dayBookings.some(
              (b: any) =>
                b.status !== "cancelled" &&
                occupiesLane(b, lid) &&
                Math.abs(b.startHour - end) < 1e-6
            );
          if (!endAligned) continue; // duration-alignment would reject the booking
          if (windowTaken(lid, s, end) || windowBlocked(lid, s, end)) continue;
          if (windowHeldByOther(lid, s, end)) continue;
          return s;
        }
        return null;
      };
      let offerLane: string | undefined;
      let offerStart = hour;
      const preferSnap = lanes.includes(preferLaneId) ? offerStartFor(preferLaneId) : null;
      if (preferSnap != null) {
        offerLane = preferLaneId;
        offerStart = preferSnap;
      } else {
        for (const lid of lanes) {
          if (lid === preferLaneId) continue;
          const s = offerStartFor(lid);
          if (s != null) {
            offerLane = lid;
            offerStart = s;
            break;
          }
        }
      }
      if (!offerLane) {
        // No offerable lane in this pool right now (e.g. the only openings are
        // mid-checkout) — the checkout hold protects the slot; revisit on
        // confirm / abandonment.
        results[pool] = "in_flight";
        continue;
      }

      // 4. Next waiting member (oldest first).
      const next = entries.find((e: any) => statusOf(e) === "waiting" && !claimed.has(e._id));
      if (!next) {
        await deleteHoldsForPool(pool);
        results[pool] = "no_waiting";
        // SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part B — this hour's own queue is
        // empty and a lane of this pool is free (offerLane/offerStart): offer it
        // to nearby-hour waiters whose own hour is still full. R1 by
        // construction — this only runs once the exact-hour queue is exhausted.
        await ctx.scheduler.runAfter(0, internal.waitlistAutoAlt.runAutoAltTimeOffers, {
          pool,
          date,
          hour: offerStart,
          freedHour: hour,
        });
        continue;
      }
      claimed.add(next._id);

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
        offeredAt: now,
      });
      await logWaitlistOfferEvent(ctx, "offered", { ...next, offeredAt: now }, { laneId: offerLane, date, hour });
      await ctx.db.insert("slotHolds", {
        laneId: offerLane,
        date,
        startHour: offerStart,
        duration: 60,
        holdType: "waitlist",
        userId: next.userId,
        userEmail: next.userEmail,
        expiresAt: expiresAtMs,
        createdAt: new Date().toISOString(),
      });

      // 6. Email the exclusive offer with the AWST deadline. Lane name comes from
      // the resolved config ("BM 2" / "RU 4") — it carries the pool naturally.
      // The BOOK deep-link uses the SNAPPED start (what they'll actually book);
      // the DECLINE link keeps the entry's hour (declineWaitlistOffer looks the
      // entry up by its queued hour).
      const laneName = laneInfo.get(offerLane)?.name ?? offerLane;
      await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistVacancy, {
        to: next.userEmail,
        customerName: next.userName,
        laneName,
        date: fmtAwstDateLabel(date),
        timeSlot: `${fmtHour12(offerStart)} - ${fmtHour12(offerStart + 1)}`,
        bookingUrl: `https://cricketrevolution.com.au/?book=${offerLane}&date=${date}&hour=${offerStart}`,
        otherWaitlistCount: "0",
        offerDeadline: `${fmtAwstTime(expiresAtMs)} AWST`,
      });

      // SPEC_PWA_PUSH §5.1 + V2 §5/§8 — waitlist vacancy offer push (time-sensitive),
      // deep-linked straight to checkout for the held slot (&wl=1) with Accept/Deny
      // action buttons. Accept → checkout; Deny → release + roll to the next person.
      const checkoutUrl = `/?book=${offerLane}&date=${date}&hour=${offerStart}&wl=1`;
      const declineUrl = `/?wlDecline=${offerLane}&date=${date}&hour=${hour}`;
      await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
        email: next.userEmail,
        category: "waitlist-offers",
        title: "Waitlist session has been allocated to you! 🏏",
        body: `${laneName} · ${fmtAwstDateLabel(date)}, ${fmtHour12(offerStart)} - ${fmtHour12(offerStart + 1)} — reserved for you. Accept to pay, or Deny to pass it on (until ${fmtAwstTime(expiresAtMs)} AWST).`,
        url: checkoutUrl,
        tag: `waitlist-${offerLane}-${date}-${hour}`,
        actions: [
          { action: "accept", title: "Accept", url: checkoutUrl },
          { action: "deny", title: "Pass", url: declineUrl },
        ],
      });

      // 7. Roll on at expiry if they don't book — targeted at THIS pool.
      await ctx.scheduler.runAfter(holdMs, internal.waitlist.advanceWaitlistOffer, {
        laneId: POOL_SENTINELS[pool],
        date,
        hour,
      });

      // V2 §6.3 — "expiring soon" reminder push a few minutes before the hold lapses
      // (only if the hold is long enough to make it meaningful). It re-checks the
      // offer is still live + unclaimed before sending.
      const EXPIRY_REMINDER_LEAD_MS = 5 * 60 * 1000;
      if (holdMs > EXPIRY_REMINDER_LEAD_MS + 60 * 1000) {
        await ctx.scheduler.runAfter(
          holdMs - EXPIRY_REMINDER_LEAD_MS,
          internal.waitlist.remindWaitlistOfferExpiring,
          { waitlistId: next._id, offerLane, laneName, date, hour, offerStartHour: offerStart, expiresAtMs }
        );
      }

      results[pool] = "offered";
    }

    return { results };
  },
});

// ---------------------------------------------------------------------------
// SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part A1 — the reaper. There was NO
// time-based expiry: an entry only ever left 'waiting' when something HAPPENED
// (pool filled / they booked / an offer lapsed). If the hour simply passed with
// a lane still free and nobody booked, nothing ran and the entry stayed
// 'waiting' forever — which is why the admin list showed months-old sessions.
//
// Hourly cron. Keys on the session END (hour + 1), not the start: the facility
// takes walk-ups (minBookingNoticeMinutes = 0), so a running session can still
// be joined late. Indexed reads (by_laneId_date, date <= today) — never a scan.
// ---------------------------------------------------------------------------
export const expirePassedWaitlistEntries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const awst = new Date(now + 8 * 60 * 60 * 1000);
    const today = awst.toISOString().slice(0, 10);
    const nowHourFrac = awst.getUTCHours() + awst.getUTCMinutes() / 60;
    const LIMIT = 300;
    let reaped = 0;
    let more = false;
    for (const sentinel of ALL_SENTINELS) {
      const rows = await ctx.db
        .query("waitlist")
        .withIndex("by_laneId_date", (q: any) => q.eq("laneId", sentinel).lte("date", today))
        .collect();
      for (const e of rows) {
        const st = statusOf(e);
        if (st !== "waiting" && st !== "offered") continue;
        const ended = e.date < today || e.hour + 1 <= nowHourFrac;
        if (!ended) continue;
        if (reaped >= LIMIT) {
          more = true;
          break;
        }
        await ctx.db.patch(e._id, { status: "expired", offerExpiresAt: undefined });
        await logWaitlistOfferEvent(ctx, "lapsed", e);
        reaped++;
      }
      if (more) break;
    }
    // First run drains a months-long backlog in batches rather than one huge write.
    if (more) {
      await ctx.scheduler.runAfter(0, internal.waitlist.expirePassedWaitlistEntries, {});
    }
    return { reaped, more };
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
// laneId is the entry-group sentinel ('*bm'/'*ru'/legacy '*') from the admin tab.
// Clearing a pool group also retires a legacy '*' offer (its hold may sit on
// either pool's lane); hold deletion is by (date, hour) across all lanes — the
// immediate re-advance re-establishes any offer that should still stand.
export const adminClearWaitlistOffer = mutation({
  args: { laneId: v.string(), date: v.string(), hour: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    // The hold deletion below is by (date, hour) across all lanes, so no group's
    // offer may be left "live" — it would stand with no protecting hold (another
    // customer could book the lane out from under the offeree). The TARGET group's
    // offer is expired (that's what the admin asked to clear); other groups'
    // offers revert to 'waiting' (they keep their queue position and the
    // immediate '*' re-advance re-offers them a lane straight away).
    const targetSentinel = ALL_SENTINELS.includes(args.laneId) ? args.laneId : null;
    for (const sentinel of ALL_SENTINELS) {
      const entries = await ctx.db
        .query("waitlist")
        .withIndex("by_slot", (q: any) =>
          q.eq("laneId", sentinel).eq("date", args.date).eq("hour", args.hour)
        )
        .collect();
      const isTarget = targetSentinel === null || sentinel === targetSentinel;
      for (const e of entries) {
        if (statusOf(e) === "offered") {
          await ctx.db.patch(e._id, {
            status: isTarget ? "expired" : "waiting",
            offerExpiresAt: undefined,
          });
        }
      }
    }
    const holds = await ctx.db
      .query("slotHolds")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
    // Owned-hour scoping (floor of startHour), matching the engine — a window-
    // overlap test would collaterally delete a NEIGHBOURING hour's snapped
    // offer hold (e.g. 10:30–11:30 belongs to hour 10, not hour 11).
    for (const h of holds) {
      if (h.holdType !== "waitlist") continue;
      if (Math.floor(h.startHour) === args.hour) await ctx.db.delete(h._id);
    }
    // Roll to the next member immediately — '*' so BOTH pools re-evaluate (the
    // non-target group's reverted offeree gets re-offered right away).
    await ctx.scheduler.runAfter(0, internal.waitlist.advanceWaitlistOffer, {
      laneId: "*",
      date: args.date,
      hour: args.hour,
    });
    return { cleared: true };
  },
});

// ---------------------------------------------------------------------------
// SPEC_MOBILE_BOOKING_UPDATES §4.5 — the caller's 1-based position in the FIFO
// queue for a {date, hour} (any-lane '*' entries). Returns null if not queued.
// Ordered by insertion time (_creationTime); only waiting/offered entries count.
// ---------------------------------------------------------------------------
export const myWaitlistPosition = query({
  args: { date: v.string(), hour: v.number(), pool: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number | null> => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return null;
    const email = (caller.email ?? "").toLowerCase().trim();
    const subject = caller.identity.subject;
    // SPEC_WAITLIST_SPLIT_BM_RU — a pool's queue = its sentinel rows + legacy
    // '*' rows, FIFO. Without a pool arg, return the caller's best position in
    // either pool.
    const pools: WaitlistPool[] =
      args.pool === "bm" ? ["bm"] : args.pool === "ru" ? ["ru"] : ["bm", "ru"];
    const read = async (sentinel: string) =>
      await ctx.db
        .query("waitlist")
        .withIndex("by_slot", (q: any) =>
          q.eq("laneId", sentinel).eq("date", args.date).eq("hour", args.hour)
        )
        .collect();
    const legacy = await read("*");
    let best: number | null = null;
    for (const p of pools) {
      const active = [...(await read(POOL_SENTINELS[p])), ...legacy]
        .filter((e: any) => {
          const s = e.status ?? "waiting";
          return s === "waiting" || s === "offered";
        })
        .sort((a: any, b: any) => a._creationTime - b._creationTime);
      const idx = active.findIndex(
        (e: any) => e.userEmail?.toLowerCase().trim() === email || e.userId === subject
      );
      if (idx !== -1 && (best === null || idx + 1 < best)) best = idx + 1;
    }
    return best;
  },
});

// Shared: the caller's 1-based queue position PER POOL for every hour they're
// queued on `date`. A pool's queue = its sentinel rows + legacy '*' rows, FIFO;
// a legacy entry holds a position in both pools.
async function computeDayPoolPositions(
  ctx: any,
  date: string
): Promise<Record<string, { bm?: number; ru?: number }>> {
  const caller = await getCallerContext(ctx);
  if (!caller.identity) return {};
  const email = (caller.email ?? "").toLowerCase().trim();
  const subject = caller.identity.subject;
  const read = async (sentinel: string) =>
    await ctx.db
      .query("waitlist")
      .withIndex("by_laneId_date", (q: any) => q.eq("laneId", sentinel).eq("date", date))
      .collect();
  const isActive = (e: any) => {
    const s = e.status ?? "waiting";
    return s === "waiting" || s === "offered";
  };
  const legacy = (await read("*")).filter(isActive);
  const out: Record<string, { bm?: number; ru?: number }> = {};
  for (const pool of ["bm", "ru"] as WaitlistPool[]) {
    const rows = (await read(POOL_SENTINELS[pool])).filter(isActive);
    const byHour = new Map<number, any[]>();
    for (const e of [...rows, ...legacy]) {
      const arr = byHour.get(e.hour) ?? [];
      arr.push(e);
      byHour.set(e.hour, arr);
    }
    for (const [hour, arr] of byHour) {
      arr.sort((a: any, b: any) => a._creationTime - b._creationTime);
      const idx = arr.findIndex(
        (e: any) => e.userEmail?.toLowerCase().trim() === email || e.userId === subject
      );
      if (idx !== -1) {
        const key = String(hour);
        out[key] = { ...(out[key] ?? {}), [pool]: idx + 1 };
      }
    }
  }
  return out;
}

// SPEC_MOBILE_BOOKING_UPDATES §4.5 — LEGACY SHAPE, kept for already-deployed
// PWA clients (the backend deploys before the frontend, and stale installs
// render this value directly as a React child — an object would CRASH their
// calendar). Returns the caller's BEST position across the two pools per hour.
// New clients use myWaitlistDayPoolPositions below.
export const myWaitlistDayPositions = query({
  args: { date: v.string() },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    const pools = await computeDayPoolPositions(ctx, args.date);
    const out: Record<string, number> = {};
    for (const [hour, p] of Object.entries(pools)) {
      const best = Math.min(p.bm ?? Infinity, p.ru ?? Infinity);
      if (Number.isFinite(best)) out[hour] = best;
    }
    return out;
  },
});

// SPEC_WAITLIST_SPLIT_BM_RU — pool-aware positions, { [hour]: { bm?, ru? } }.
// One query for the whole day so the calendar shows "#k in the queue" per band.
export const myWaitlistDayPoolPositions = query({
  args: { date: v.string() },
  handler: async (ctx, args): Promise<Record<string, { bm?: number; ru?: number }>> => {
    return await computeDayPoolPositions(ctx, args.date);
  },
});

// ---------------------------------------------------------------------------
// SPEC_PUSH_NOTIFICATIONS_V2 §6.3 — "expiring soon" reminder push.
// Scheduled by advanceWaitlistOffer for (hold − 5 min). Fires only if the offer
// is STILL live + unclaimed (same offer instance, identified by offerExpiresAt).
// ---------------------------------------------------------------------------
export const remindWaitlistOfferExpiring = internalMutation({
  args: {
    waitlistId: v.id("waitlist"),
    offerLane: v.string(),
    // Resolved display name captured at offer time (config-derived — F3 fix).
    laneName: v.optional(v.string()),
    date: v.string(),
    hour: v.number(),
    // OFFER-SNAP: the actual offered start (may be e.g. :30 on a custom-start
    // grid). Book deep-links use this; the entry stays keyed by `hour`.
    offerStartHour: v.optional(v.number()),
    expiresAtMs: v.number(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.waitlistId);
    if (!entry) return { sent: false, reason: "gone" };
    if (statusOf(entry) !== "offered") return { sent: false, reason: "not offered" };
    // Same offer instance? (A re-offer would carry a different expiry.)
    const exp = entry.offerExpiresAt ? new Date(entry.offerExpiresAt).getTime() : 0;
    if (exp !== args.expiresAtMs) return { sent: false, reason: "superseded" };
    if (Date.now() >= exp) return { sent: false, reason: "already expired" };

    const laneName = args.laneName ?? args.offerLane;
    const startH = args.offerStartHour ?? args.hour;
    const checkoutUrl = `/?book=${args.offerLane}&date=${args.date}&hour=${startH}&wl=1`;
    const declineUrl = `/?wlDecline=${args.offerLane}&date=${args.date}&hour=${args.hour}`;
    await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
      email: entry.userEmail,
      category: "waitlist-offers",
      title: "Your net is about to be released ⏳",
      body: `${laneName} · ${fmtAwstDateLabel(args.date)}, ${fmtHour12(startH)} - ${fmtHour12(startH + 1)} — claim it before ${fmtAwstTime(exp)} AWST.`,
      url: checkoutUrl,
      // Distinct tag so it doesn't overwrite the original offer notification.
      tag: `waitlist-expiry-${args.offerLane}-${args.date}-${args.hour}`,
      actions: [
        { action: "accept", title: "Accept", url: checkoutUrl },
        { action: "deny", title: "Pass", url: declineUrl },
      ],
    });
    return { sent: true };
  },
});

// ---------------------------------------------------------------------------
// SPEC_PUSH_NOTIFICATIONS_V2 §8 — the offeree declines (notification "Pass"/Deny
// action, or the in-app "Pass" button on iOS). Releases this user's exclusive
// hold + marks their entry expired, then immediately rolls the offer to the next
// waiting member. Only the user who holds the live offer may decline it.
// ---------------------------------------------------------------------------
export const declineWaitlistOffer = mutation({
  args: { laneId: v.string(), date: v.string(), hour: v.number() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) throw new ConvexError("Authentication required.");
    const email = (caller.email ?? "").toLowerCase().trim();
    const subject = caller.identity.subject;

    const slotEnd = args.hour + 1;
    // Entries are keyed by pool sentinel ('*bm'/'*ru', legacy '*'); find THIS
    // caller's offered entry for the hour across all of them.
    const entries: any[] = [];
    for (const sentinel of ALL_SENTINELS) {
      const rows = await ctx.db
        .query("waitlist")
        .withIndex("by_slot", (q: any) =>
          q.eq("laneId", sentinel).eq("date", args.date).eq("hour", args.hour)
        )
        .collect();
      entries.push(...rows);
    }
    const mineAll = entries.filter(
      (e: any) =>
        statusOf(e) === "offered" &&
        (e.userEmail?.toLowerCase().trim() === email || e.userId === subject)
    );
    // SPEC_WAITLIST_SPLIT_BM_RU — a user may hold live offers in BOTH pools for
    // the same hour. The decline deep-link carries the OFFERED LANE (args.laneId):
    // prefer the entry whose offer instance (offerExpiresAt) matches the hold on
    // that lane, so tapping "Pass" on the BM push never kills the RU offer.
    const dayHolds = await ctx.db
      .query("slotHolds")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
    const myHourHolds = dayHolds.filter((h: any) => {
      if (h.holdType !== "waitlist") return false;
      if (h.userId !== subject && h.userEmail?.toLowerCase().trim() !== email) return false;
      const hEnd = h.startHour + h.duration / 60;
      return args.hour < hEnd && slotEnd > h.startHour;
    });
    const expOf = (e: any) => (e.offerExpiresAt ? new Date(e.offerExpiresAt).getTime() : 0);
    const mine =
      mineAll.find((e: any) =>
        myHourHolds.some((h: any) => h.laneId === args.laneId && h.expiresAt === expOf(e))
      ) ?? mineAll[0];
    if (!mine) {
      // Nothing to decline (already rolled / booked / never offered to them).
      return { declined: false, reason: "no live offer" };
    }
    await ctx.db.patch(mine._id, { status: "expired", offerExpiresAt: undefined });
    await logWaitlistOfferEvent(ctx, "declined", mine, { laneId: args.laneId, date: args.date, hour: args.hour });

    // Release only THIS offer's hold (instance-matched by expiresAt); fall back
    // to all the user's hour holds only if nothing matched (defensive).
    const instanceHolds = myHourHolds.filter((h: any) => h.expiresAt === expOf(mine));
    for (const h of instanceHolds.length > 0 ? instanceHolds : myHourHolds) {
      await ctx.db.delete(h._id);
    }

    // Roll to the next waiting member immediately.
    await ctx.scheduler.runAfter(0, internal.waitlist.advanceWaitlistOffer, {
      laneId: args.laneId,
      date: args.date,
      hour: args.hour,
    });
    return { declined: true };
  },
});
