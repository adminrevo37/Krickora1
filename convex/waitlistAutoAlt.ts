// SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part B — AUTOMATIC alternative-time offers.
//
// "Waitlisted for 7–8pm; a 5pm/6pm/8pm/9pm lane frees up" → tell them, without
// an admin having to notice. This is an automatic TRIGGER for the alternative-
// time offer mechanism that already exists (`waitlistOffers`, the ?offer=<token>
// deep link, the accept sheet). Nothing about how a customer accepts changes.
//
// Decisions (Inspector, 2026-09-02):
//   D1  HOLD — the offeree gets an exclusive 15-min hold (`waitlistOfferHoldMinutes`).
//   D2  HYBRID — one person at a time (hold, roll on at expiry/decline), UNLESS the
//       freed session starts within `waitlistAltTimeBroadcastWithinHours` (default
//       5), in which case EVERY eligible waiter is told at once with no hold (the
//       existing race mechanism) — a sequential chain can't clear a queue before a
//       near-term session starts.
//   D3  Nearest alternative first, ties to the EARLIER alternative.
//   D4  Opt-in checkbox at join, default ON (`waitlist.altTimeOptIn`).
//   D5  Accepting asks whether to drop the original queue entry (existing sheet).
//
// Rules that hold regardless (spec §4.2):
//   R1  The exact-hour queue always wins — this pass only runs once the freed
//       hour's own queue is exhausted (the engine schedules it on `no_waiting`),
//       and re-checks at entry in case someone joined the exact queue since.
//   R2  Only offer to a waiter whose OWN hour is still full for their pool.
//   R3  Never cross pools (BM waiter is never offered an RU lane).
//   R4  Never a time that has passed, or one they already have a booking at.
//   R5  Window is a setting (`waitlistAltTimeWindowHours`, default ±2).
//   R6  At most one auto alt-offer per entry per AWST day; never again for an
//       entry whose owner pressed Pass on one.
//
// Holds use holdType 'waitlist-alt' (NOT 'waitlist') so the exact-hour engine's
// pool-wide hold cleanup can never delete a live auto-offer hold. The conflict
// checker treats both as waitlist-class (offeree passes their own; coaches/admin
// bypass) — see lib/slotHolds.hasActiveHoldConflict.
//
// These offers are deliberately NOT logged to `waitlistOfferEvents` — that series
// measures the exact-hour first-refusal engine and the analytics dashboard reads
// it as such. The `waitlistOffers` rows (status live/booked/expired/declined,
// source 'auto') are the record for auto alt-offers.
import { internalMutation, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { getCallerContext } from "./lib/adminGuard";
import { resolveDayLanes } from "./lanes";
import { segmentIsClosed, segmentStartHours } from "./lib/lanes";
import { fmtAwstDateLabel, fmtAwstDateShort } from "./lib/dates";
import { awstDateKey } from "./lib/analyticsHelpers";
import {
  loadDayAvailability,
  freeLaneIdsAt,
  slotStartMs,
  fmtHour12,
  type DayLane,
  type DayAvailability,
  type Pool,
} from "./waitlistOffers";

const POOL_SENTINEL: Record<Pool, string> = { bm: "*bm", ru: "*ru" };
const DEFAULT_HOLD_MINUTES = 15;
const DEFAULT_WINDOW_HOURS = 2;
const DEFAULT_BROADCAST_WITHIN_HOURS = 5;
export const ALT_HOLD_TYPE = "waitlist-alt";

const statusOf = (e: any): string => e.status ?? "waiting";
const EPS = 1e-6;

function fmtAwstTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "Australia/Perth",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

async function loadSettings(ctx: any): Promise<any> {
  return (
    (await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first()) ?? {}
  );
}

/** This pool's queue rows for a date: its sentinel + legacy '*' (any-lane) rows. */
async function readPoolDayEntries(ctx: any, pool: Pool, date: string): Promise<any[]> {
  const out: any[] = [];
  for (const sentinel of [POOL_SENTINEL[pool], "*"]) {
    const rows = await ctx.db
      .query("waitlist")
      .withIndex("by_laneId_date", (q: any) => q.eq("laneId", sentinel).eq("date", date))
      .collect();
    out.push(...rows);
  }
  return out;
}

/** Every start time this pool's segments offer on the date (explicit starts,
 *  cadences, half-hour openings) — the same enumeration listOfferableTimes uses. */
function poolCandidateStarts(dayLanes: DayLane[], pool: Pool): number[] {
  const set = new Set<number>();
  for (const lane of dayLanes) {
    for (const seg of lane.segments as any[]) {
      if (segmentIsClosed(seg)) continue;
      const segPool: Pool = seg.mode === "RU" ? "ru" : "bm";
      if (segPool !== pool) continue;
      for (const h of segmentStartHours(seg)) set.add(h);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * D3 — for a waiter queued on `entryHour`, the best free alternative start in
 * the pool within ±window: nearest first, ties to the EARLIER alternative.
 * Returns null if nothing nearby is free.
 */
function bestAlternativeFor(
  day: DayAvailability,
  dayLanes: DayLane[],
  starts: number[],
  pool: Pool,
  date: string,
  entryHour: number,
  windowHours: number,
  nowMs: number
): number | null {
  let best: number | null = null;
  for (const t of starts) {
    if (Math.floor(t) === entryHour) continue; // their own hour, not an alternative
    if (Math.abs(t - entryHour) > windowHours + EPS) continue;
    if (slotStartMs(date, t) <= nowMs) continue;
    if (freeLaneIdsAt(day, dayLanes, t, pool).length === 0) continue;
    if (best === null) {
      best = t;
      continue;
    }
    const dBest = Math.abs(best - entryHour);
    const dT = Math.abs(t - entryHour);
    if (dT < dBest - EPS || (Math.abs(dT - dBest) < EPS && t < best)) best = t;
  }
  return best;
}

function makeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `wo_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type AutoAltPlan =
  | { result: "disabled" | "window_zero" | "passed" | "offer_live" | "not_free" | "no_candidates" }
  | { result: "exact_queue"; kickEngine: boolean }
  | {
      result: "broadcast";
      groups: Array<{ sourceHour: number; entries: any[] }>;
      total: number;
      note: string;
    }
  | { result: "all_deferred"; deferredTo: number[] }
  | {
      result: "offered";
      chosen: any;
      deferredTo: number[];
      laneId: string;
      holdMs: number;
    };

/**
 * THE PLANNER — pure reads, no writes, no scheduling. Decides what the pass
 * would do for (pool, date, hour, freedHour). Split out so it can be exercised
 * read-only against real data; runAutoAltTimeOffers executes the plan.
 *
 *   pool       'bm' | 'ru'
 *   date       YYYY-MM-DD
 *   hour       the OFFERED start (may be a snapped :30 on a custom-start grid)
 *   freedHour  the whole hour whose free-up triggered this (defaults to floor(hour))
 */
export async function planAutoAltOffers(
  ctx: any,
  args: { pool: string; date: string; hour: number; freedHour?: number }
): Promise<AutoAltPlan & { candidatesConsidered?: Array<{ email: string; hour: number }> }> {
  const pool: Pool = args.pool === "ru" ? "ru" : "bm";
  const F = args.hour;
  const freedHour = args.freedHour ?? Math.floor(F);
  const now = Date.now();

  const settings = await loadSettings(ctx);
  if (settings.waitlistAutoAltOffersEnabled === false) return { result: "disabled" };
  const windowHours = Number(settings.waitlistAltTimeWindowHours ?? DEFAULT_WINDOW_HOURS);
  const broadcastWithinHours = Number(
    settings.waitlistAltTimeBroadcastWithinHours ?? DEFAULT_BROADCAST_WITHIN_HOURS
  );
  const holdMinutes = Number(settings.waitlistOfferHoldMinutes ?? DEFAULT_HOLD_MINUTES);
  if (!(windowHours > 0)) return { result: "window_zero" };

  // R4 — never a time that has passed.
  const startMs = slotStartMs(args.date, F);
  if (startMs <= now) return { result: "passed" };

  const entries = await readPoolDayEntries(ctx, pool, args.date);

  // R1 — if anyone is WAITING on (or currently OFFERED) the freed hour itself,
  // the exact-hour engine owns this slot. Kick it and stop.
  const exactLive = entries.filter(
    (e) => e.hour === freedHour && (statusOf(e) === "waiting" || statusOf(e) === "offered")
  );
  if (exactLive.length > 0) {
    return { result: "exact_queue", kickEngine: exactLive.some((e) => statusOf(e) === "waiting") };
  }

  // A live sequential auto-offer already stands for this slot → the chain is
  // running; its expiry/decline will re-enter here.
  const sameSlotOffers = await ctx.db
    .query("waitlistOffers")
    .withIndex("by_slot", (q: any) => q.eq("date", args.date).eq("hour", F))
    .collect();
  if (
    sameSlotOffers.some(
      (o: any) => o.status === "live" && o.source === "auto" && o.exclusive && o.pool === pool
    )
  ) {
    return { result: "offer_live" };
  }

  const [day, dayLanesRaw] = await Promise.all([
    loadDayAvailability(ctx, args.date),
    resolveDayLanes(ctx, args.date),
  ]);
  const dayLanes = dayLanesRaw as DayLane[];
  const freeNow = freeLaneIdsAt(day, dayLanes, F, pool);
  if (freeNow.length === 0) return { result: "not_free" };

  const todayKey = awstDateKey(now);
  const emailOf = (e: any) => String(e.userEmail ?? "").toLowerCase().trim();
  const ownsBookingOver = (e: any, ws: number, we: number) =>
    day.bookings.some((b: any) => {
      const mine =
        (e.userId && b.userId === e.userId) ||
        emailOf(e) === String(b.customerEmail ?? "").toLowerCase().trim();
      if (!mine) return false;
      const bEnd = b.startHour + b.duration / 60;
      return ws < bEnd && we > b.startHour;
    });

  // Candidates: waiting, within ±window of the freed hour, opted in, not capped
  // today, never declined, own hour still full (R2), no booking over the offered
  // window (R4). One row per user — if they queued several hours in the window,
  // keep the nearest.
  const byUser = new Map<string, any>();
  for (const e of entries) {
    if (statusOf(e) !== "waiting") continue;
    if (e.hour === freedHour) continue;
    if (Math.abs(e.hour - freedHour) > windowHours + EPS) continue;
    if (e.altTimeOptIn === false) continue;
    if (e.altOfferDeclined) continue;
    if (typeof e.lastAltOfferAt === "number" && awstDateKey(e.lastAltOfferAt) === todayKey) continue;
    if (freeLaneIdsAt(day, dayLanes, e.hour, pool).length > 0) continue; // R2
    if (ownsBookingOver(e, F, F + 1)) continue; // R4
    const key = emailOf(e) || e.userId;
    const prev = byUser.get(key);
    if (!prev || Math.abs(e.hour - freedHour) < Math.abs(prev.hour - freedHour)) byUser.set(key, e);
  }
  // D3 ordering from the freed slot's side: nearest waiter first; on a tie the
  // waiter for whom F is the EARLIER alternative (their hour is later than F)
  // goes first; then FIFO.
  const candidates = [...byUser.values()].sort((a, b) => {
    const da = Math.abs(a.hour - freedHour);
    const db = Math.abs(b.hour - freedHour);
    if (Math.abs(da - db) > EPS) return da - db;
    if (a.hour !== b.hour) return b.hour - a.hour;
    return a._creationTime - b._creationTime;
  });
  const considered = candidates.map((e) => ({ email: emailOf(e), hour: e.hour }));
  if (candidates.length === 0) return { result: "no_candidates", candidatesConsidered: considered };

  const broadcast = startMs - now <= broadcastWithinHours * 60 * 60 * 1000;

  // ---------------------------------------------------------------- BROADCAST
  if (broadcast) {
    // Everyone eligible, at once, no hold (the existing race mechanism). One
    // waitlistOffers row per SOURCE hour so the copy ("you asked for 8pm") is
    // right for each recipient group.
    const groupMap = new Map<number, any[]>();
    for (const e of candidates) {
      const arr = groupMap.get(e.hour) ?? [];
      arr.push(e);
      groupMap.set(e.hour, arr);
    }
    const total = candidates.length;
    const note =
      total === 1
        ? "This slot is not reserved — it stays available to everyone until someone books it, so book now to secure it."
        : `This has been offered to ${total} people on the waitlist, and the slot also stays on sale to everyone else — first to book gets it.`;
    return {
      result: "broadcast",
      groups: [...groupMap].map(([sourceHour, es]) => ({ sourceHour, entries: es })),
      total,
      note,
      candidatesConsidered: considered,
    };
  }

  // --------------------------------------------------------------- SEQUENTIAL
  // One person, one hold. If a NEARER free alternative exists for the front
  // candidate (D3), defer them to that hour's pass instead — and make sure that
  // pass actually runs, since its own free-up may have happened before they
  // joined. Walk down until someone whose best alternative IS this slot.
  const starts = poolCandidateStarts(dayLanes, pool);
  const deferred = new Set<number>();
  let chosen: any = null;
  for (const e of candidates) {
    const best = bestAlternativeFor(day, dayLanes, starts, pool, args.date, e.hour, windowHours, now);
    if (best === null) continue; // shouldn't happen (F is free) — skip defensively
    if (Math.abs(best - F) < EPS) {
      chosen = e;
      break;
    }
    deferred.add(best);
  }
  if (!chosen) return { result: "all_deferred", deferredTo: [...deferred], candidatesConsidered: considered };
  return {
    result: "offered",
    chosen,
    deferredTo: [...deferred],
    laneId: freeNow[0],
    holdMs: Math.max(1, holdMinutes) * 60 * 1000,
    candidatesConsidered: considered,
  };
}

/**
 * THE PASS. Scheduled by advanceWaitlistOffer when a freed hour's own queue is
 * empty (`no_waiting`) and a lane in the pool is free; re-scheduled by the
 * sequential chain on expiry / decline. Executes planAutoAltOffers.
 */
export const runAutoAltTimeOffers = internalMutation({
  args: {
    pool: v.string(),
    date: v.string(),
    hour: v.number(),
    freedHour: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pool: Pool = args.pool === "ru" ? "ru" : "bm";
    const F = args.hour;
    const freedHour = args.freedHour ?? Math.floor(F);
    const now = Date.now();
    const plan = await planAutoAltOffers(ctx, args);

    if (plan.result === "exact_queue") {
      if (plan.kickEngine) {
        await ctx.scheduler.runAfter(0, internal.waitlist.advanceWaitlistOffer, {
          laneId: POOL_SENTINEL[pool],
          date: args.date,
          hour: freedHour,
        });
      }
      return { result: plan.result };
    }
    if (plan.result !== "broadcast" && plan.result !== "offered" && plan.result !== "all_deferred") {
      return { result: plan.result };
    }

    const scheduleDeferred = async (hours: number[]) => {
      for (const best of hours) {
        await ctx.scheduler.runAfter(0, internal.waitlistAutoAlt.runAutoAltTimeOffers, {
          pool,
          date: args.date,
          hour: best,
          freedHour: Math.floor(best),
        });
      }
    };
    if (plan.result === "all_deferred") {
      await scheduleDeferred(plan.deferredTo);
      return { result: plan.result, deferredTo: plan.deferredTo };
    }

    const dateLabel = fmtAwstDateLabel(args.date);
    const dateLabelShort = fmtAwstDateShort(args.date);
    const poolLabel = pool === "bm" ? "bowling machine" : "run-up";
    const when = `${fmtHour12(F)} - ${fmtHour12(F + 1)}`;
    const notify = async (
      r: { userEmail: string; userName: string },
      sourceHour: number,
      note: string,
      token: string,
      title: string
    ) => {
      const offerUrl = `/?offer=${token}`;
      await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistAltTimeOffer, {
        to: r.userEmail,
        customerName: r.userName,
        poolLabel,
        date: dateLabel,
        dateShort: dateLabelShort,
        timeSlot: when,
        requestedSlot: `${fmtHour12(sourceHour)} - ${fmtHour12(sourceHour + 1)}`,
        note,
        bookingUrl: `https://cricketrevolution.com.au${offerUrl}`,
      });
      await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
        email: r.userEmail,
        category: "waitlist-offers",
        title,
        body: `${dateLabel}, ${when} on a ${poolLabel} lane — you asked for ${fmtHour12(sourceHour)}. ${note}`,
        url: offerUrl,
        tag: `wl-alt-${args.date}-${F}`,
      });
    };

    if (plan.result === "broadcast") {
      let created = 0;
      for (const { sourceHour, entries: group } of plan.groups) {
        const token = makeToken();
        await ctx.db.insert("waitlistOffers", {
          pool,
          date: args.date,
          hour: F,
          sourceHour,
          recipients: group.map((e: any) => ({
            userId: e.userId,
            userEmail: e.userEmail,
            userName: e.userName,
            waitlistEntryId: String(e._id),
          })),
          exclusive: false,
          status: "live",
          token,
          createdAt: now,
          createdByEmail: "system:auto-alt",
          source: "auto",
          freedHour,
        });
        created++;
        for (const e of group) {
          await ctx.db.patch(e._id, { lastAltOfferAt: now });
          await notify(e, sourceHour, plan.note, token, "A nearby time has opened up 🏏");
        }
      }
      return { result: "broadcast", offers: created, recipients: plan.total };
    }

    // offered — one person, one hold, one timer.
    await scheduleDeferred(plan.deferredTo);
    const chosen = plan.chosen;
    const expiresAt = now + plan.holdMs;
    const token = makeToken();
    const offerId = await ctx.db.insert("waitlistOffers", {
      pool,
      date: args.date,
      hour: F,
      sourceHour: chosen.hour,
      recipients: [
        {
          userId: chosen.userId,
          userEmail: chosen.userEmail,
          userName: chosen.userName,
          waitlistEntryId: String(chosen._id),
        },
      ],
      exclusive: true,
      status: "live",
      token,
      createdAt: now,
      createdByEmail: "system:auto-alt",
      source: "auto",
      expiresAt,
      freedHour,
      laneId: plan.laneId,
    });
    await ctx.db.insert("slotHolds", {
      laneId: plan.laneId,
      date: args.date,
      startHour: F,
      duration: 60,
      holdType: ALT_HOLD_TYPE,
      userId: chosen.userId,
      userEmail: chosen.userEmail,
      expiresAt,
      createdAt: new Date(now).toISOString(),
    });
    await ctx.db.patch(chosen._id, { lastAltOfferAt: now });

    const note = `This slot is reserved for you until ${fmtAwstTime(expiresAt)} AWST — after that it's offered to the next person on the waitlist.`;
    await notify(chosen, chosen.hour, note, token, "A nearby time is reserved for you 🏏");

    // Roll on at expiry.
    await ctx.scheduler.runAfter(plan.holdMs, internal.waitlistAutoAlt.expireAutoAltOffer, {
      offerId: String(offerId),
    });
    return { result: "offered", to: chosen.userEmail, sourceHour: chosen.hour, expiresAt };
  },
});

/** Delete the exclusive auto hold belonging to an offer (idempotent). */
async function releaseAutoHold(ctx: any, offer: any): Promise<void> {
  const holds = await ctx.db
    .query("slotHolds")
    .withIndex("by_date", (q: any) => q.eq("date", offer.date))
    .collect();
  const userId = offer.recipients?.[0]?.userId;
  for (const h of holds as any[]) {
    if (h.holdType !== ALT_HOLD_TYPE) continue;
    if (Math.abs(h.startHour - offer.hour) > EPS) continue;
    if (offer.laneId && h.laneId !== offer.laneId) continue;
    if (userId && h.userId !== userId) continue;
    await ctx.db.delete(h._id);
  }
}

/** Continue the sequential chain for the slot this offer was about. */
async function rerunChain(ctx: any, offer: any): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.waitlistAutoAlt.runAutoAltTimeOffers, {
    pool: offer.pool,
    date: offer.date,
    hour: offer.hour,
    freedHour: offer.freedHour ?? Math.floor(offer.hour),
  });
}

/**
 * The hold lapsed with no action. Scheduled by runAutoAltTimeOffers at offer
 * time; safe to fire late or twice (status-gated).
 */
export const expireAutoAltOffer = internalMutation({
  args: { offerId: v.string() },
  handler: async (ctx, args) => {
    const offer: any = await ctx.db.get(args.offerId as any);
    if (!offer || offer.source !== "auto") return { expired: false, reason: "not_auto" };
    if (offer.status !== "live") return { expired: false, reason: offer.status };
    // Not yet due (e.g. the hold was re-timed)? Leave it.
    if (typeof offer.expiresAt === "number" && offer.expiresAt > Date.now() + 1000) {
      return { expired: false, reason: "not_due" };
    }
    await ctx.db.patch(offer._id, { status: "expired" });
    await releaseAutoHold(ctx, offer);
    await rerunChain(ctx, offer);
    return { expired: true };
  },
});

/**
 * CUSTOMER — "Pass" on an automatic exclusive offer. Releases the hold, marks
 * the queue entry so it is never auto-offered again (R6), and rolls the chain
 * to the next person immediately.
 */
export const declineAutoAltOffer = mutation({
  args: { offerId: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    const email = (caller.email ?? "").toLowerCase().trim();
    if (!email) throw new ConvexError("Please sign in.");
    const offer: any = await ctx.db.get(args.offerId as any);
    if (!offer) return { ok: false as const, reason: "not_found" };
    const me = offer.recipients.find((r: any) => r.userEmail.toLowerCase() === email);
    if (!me) return { ok: false as const, reason: "not_yours" };
    if (offer.source !== "auto") return { ok: false as const, reason: "not_auto" };
    if (offer.status !== "live") return { ok: false as const, reason: offer.status };

    await ctx.db.patch(offer._id, { status: "declined" });
    if (offer.exclusive) await releaseAutoHold(ctx, offer);
    if (me.waitlistEntryId) {
      const entry: any = await ctx.db.get(me.waitlistEntryId as any);
      if (entry && String(entry.userEmail ?? "").toLowerCase() === email) {
        await ctx.db.patch(entry._id, { altOfferDeclined: true });
      }
    }
    if (offer.exclusive) await rerunChain(ctx, offer);
    // C9 — close the loop on a Pass.
    await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
      email: me.userEmail,
      category: "waitlist-offers",
      title: "Passed ✔",
      body: `${fmtAwstDateLabel(offer.date)}, ${fmtHour12(offer.hour)} - ${fmtHour12(offer.hour + 1)} has been offered to the next person. You're still on the waitlist for ${fmtHour12(offer.sourceHour)}.`,
      url: `/?wlDay=${offer.date}`,
      tag: `wl-passed-${offer.date}-${offer.hour}`,
    });
    return { ok: true as const };
  },
});
