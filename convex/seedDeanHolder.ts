import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { defaultLaneName } from "./lib/lanes";

// ============================================================================
// SEED — Dean Holder demo data (idempotent).
//
// Creates/refreshes a realistic L1 coach ("Dean Holder", default session 45min),
// 10 athletes across 4 existing test-customer accounts, and 15 coach bookings
// THIS WEEK with deliberately varied allocation patterns so the day-view dots
// (red / amber / green), the allocation timeline, the admin-managed lock, and the
// Past tab all have something real to show.
//
// IDEMPOTENT: re-running deletes every prior Dean COACH booking (by_customerEmail
// + isCoachBooking) before re-inserting, and upserts athletes by (account, name).
// The coach must already exist as a signed-up + verified account (the email below)
// — this mutation promotes it to a coach and fills the rest. Run via deploy key:
//   npx convex run seedDeanHolder:seedDeanHolder
// ============================================================================

const COACH_EMAIL = "test.dean.pout984@passmail.net";
const COACH_NAME = "Dean Holder";
const COACH_COLOR = "#2563eb"; // blue — distinct from the other test coaches

// 10 athletes across 4 existing test-customer (parent) accounts.
const PARENTS: { email: string; athletes: string[] }[] = [
  { email: "customer.a.retriever197@passmail.net", athletes: ["Liam Carter", "Noah Carter", "Mia Carter"] },
  { email: "customer.b.resigned666@passmail.net", athletes: ["Oliver Brooks", "Charlotte Brooks"] },
  { email: "customer.c.avenging165@passmail.net", athletes: ["Jack Davies", "Ava Davies", "Ella Davies"] },
  { email: "customer.d.rink965@passmail.net", athletes: ["Lucas Evans", "Grace Evans"] },
];

type SlotDef = { athlete: string; startHour: number; durationMinutes: number };
type BookingDef = {
  date: string;
  startHour: number;
  duration: number;
  laneId: string;
  createdByAdmin?: boolean;
  slots: SlotDef[];
};

// THIS WEEK (today = Thu 2026-06-04, facility CLOSED that day → none placed on it).
// Upcoming (Fri 05 → Wed 10) populate the L1 rolling strip; 3 past bookings (Mon 01,
// Tue 02, Wed 03) populate the Past tab.
const BOOKINGS: BookingDef[] = [
  // Fri 06-05 — multi-booking day, mixed coverage
  { date: "2026-06-05", startHour: 9, duration: 90, laneId: "bm1", slots: [ // back-to-back full → GREEN
      { athlete: "Liam Carter", startHour: 9, durationMinutes: 45 },
      { athlete: "Noah Carter", startHour: 9.75, durationMinutes: 45 } ] },
  { date: "2026-06-05", startHour: 11, duration: 90, laneId: "bm2", slots: [ // 45+30, 15-min trailing gap (non-tappable, still GREEN)
      { athlete: "Mia Carter", startHour: 11, durationMinutes: 45 },
      { athlete: "Jack Davies", startHour: 11.75, durationMinutes: 30 } ] },
  { date: "2026-06-05", startHour: 14, duration: 90, laneId: "ru1", slots: [ // 45 allocated + 45 free → AMBER
      { athlete: "Oliver Brooks", startHour: 14, durationMinutes: 45 } ] },

  // Sat 06-06 — multi-booking day
  { date: "2026-06-06", startHour: 8, duration: 90, laneId: "bm3", slots: [ // full → GREEN
      { athlete: "Charlotte Brooks", startHour: 8, durationMinutes: 45 },
      { athlete: "Ava Davies", startHour: 8.75, durationMinutes: 45 } ] },
  { date: "2026-06-06", startHour: 10, duration: 60, laneId: "bm1", slots: [] }, // no athletes → RED

  // Sun 06-07
  { date: "2026-06-07", startHour: 9, duration: 90, laneId: "bm1", slots: [ // 45 + 45 free → AMBER
      { athlete: "Ella Davies", startHour: 9, durationMinutes: 45 } ] },

  // Mon 06-08 — multi-booking day; #7 is admin-managed (lock test)
  { date: "2026-06-08", startHour: 16, duration: 90, laneId: "bm1", createdByAdmin: true, slots: [ // full + LOCKED
      { athlete: "Lucas Evans", startHour: 16, durationMinutes: 45 },
      { athlete: "Grace Evans", startHour: 16.75, durationMinutes: 45 } ] },
  { date: "2026-06-08", startHour: 17.5, duration: 60, laneId: "bm2", slots: [ // 2×30 back-to-back → GREEN
      { athlete: "Liam Carter", startHour: 17.5, durationMinutes: 30 },
      { athlete: "Noah Carter", startHour: 18, durationMinutes: 30 } ] },

  // Tue 06-09 — multi-booking day
  { date: "2026-06-09", startHour: 15, duration: 90, laneId: "bm3", slots: [ // 45 + 45 free → AMBER
      { athlete: "Mia Carter", startHour: 15, durationMinutes: 45 } ] },
  { date: "2026-06-09", startHour: 16.5, duration: 60, laneId: "ru1", slots: [] }, // no athletes → RED

  // Wed 06-10 — WHOLE unallocated day (both bookings have no athletes) → RED
  { date: "2026-06-10", startHour: 9, duration: 60, laneId: "bm1", slots: [] },
  { date: "2026-06-10", startHour: 10, duration: 60, laneId: "bm2", slots: [] },

  // PAST (this week) — populate the Past tab
  { date: "2026-06-03", startHour: 10, duration: 60, laneId: "bm1", slots: [
      { athlete: "Liam Carter", startHour: 10, durationMinutes: 45 } ] },
  { date: "2026-06-02", startHour: 16, duration: 60, laneId: "bm2", slots: [
      { athlete: "Jack Davies", startHour: 16, durationMinutes: 30 },
      { athlete: "Ava Davies", startHour: 16.5, durationMinutes: 30 } ] },
  // (Mon 06-01 is a facility closure → placed on the open Wed 06-03 instead.)
  { date: "2026-06-03", startHour: 14, duration: 90, laneId: "ru1", slots: [
      { athlete: "Oliver Brooks", startHour: 14, durationMinutes: 45 },
      { athlete: "Charlotte Brooks", startHour: 14.75, durationMinutes: 45 } ] },
];

const RESERVED = new Set(["0000", "1234", "1111", "9999", "0123"]);

function makeCode(used: Set<string>): string {
  for (let i = 0; i < 9999; i++) {
    // CSPRNG (Web Crypto) — same approach as the production door-code path
    // (mutations.ts generateServerAccessCode), not the guessable Math.random.
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    const c = String(1000 + (arr[0] % 9000)); // 4-digit (1000-9999)
    if (!used.has(c) && !RESERVED.has(c)) { used.add(c); return c; }
  }
  // Fallback (effectively unreachable on this dataset size)
  let n = 1000;
  while (used.has(String(n))) n++;
  used.add(String(n));
  return String(n);
}

export const seedDeanHolder = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const log: string[] = [];

    // ── 1. Coach ───────────────────────────────────────────────────────────
    const coach = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", COACH_EMAIL))
      .first();
    if (!coach) {
      throw new Error(
        `Coach account ${COACH_EMAIL} not found — sign up + verify that email first, then re-run.`,
      );
    }
    const coachId = coach._id as Id<"customers">;
    if (!args.dryRun) {
      await ctx.db.patch(coachId, {
        name: COACH_NAME,
        role: "coach",
        coachTier: "L1",
        color: COACH_COLOR,
        defaultSessionDuration: 45,
        athleteCapacity: 4,
        postcode: "6008",
        suburb: "Subiaco",
      });
    }
    log.push(`coach ${COACH_NAME} (${coachId}) → L1, 45min default, cap 4`);

    // ── 2. Athletes (upsert by account + name, assign Dean) ─────────────────
    const athleteByName: Record<string, { id: Id<"athletes">; name: string }> = {};
    let athletesCreated = 0, athletesPatched = 0;
    for (const parent of PARENTS) {
      const acct = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", parent.email))
        .first();
      if (!acct) { log.push(`SKIP parent ${parent.email} — not found`); continue; }
      const existing = await ctx.db
        .query("athletes")
        .withIndex("by_account", (q: any) => q.eq("accountCustomerId", acct._id))
        .collect();
      for (const name of parent.athletes) {
        const match = existing.find((a: any) => a.name === name);
        if (match) {
          const coaches = new Set<string>([...(match.assignedCoachIds ?? []), coachId]);
          if (!args.dryRun) await ctx.db.patch(match._id, { assignedCoachIds: [...coaches] });
          athleteByName[name] = { id: match._id, name };
          athletesPatched++;
        } else {
          let newId: Id<"athletes">;
          if (!args.dryRun) {
            newId = await ctx.db.insert("athletes", {
              accountCustomerId: acct._id,
              name,
              assignedCoachIds: [coachId],
              isSelf: false,
              createdAt: new Date().toISOString(),
            });
          } else {
            newId = ("dry_" + name) as unknown as Id<"athletes">;
          }
          athleteByName[name] = { id: newId, name };
          athletesCreated++;
        }
      }
    }
    log.push(`athletes: ${athletesCreated} created, ${athletesPatched} re-assigned (${Object.keys(athleteByName).length} total)`);

    // ── 3. Clear prior Dean coach bookings (idempotency) ────────────────────
    const prior = await ctx.db
      .query("bookings")
      .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", COACH_EMAIL))
      .collect();
    let deleted = 0;
    for (const b of prior) {
      if (b.isCoachBooking) { if (!args.dryRun) await ctx.db.delete(b._id); deleted++; }
    }
    log.push(`deleted ${deleted} prior Dean coach bookings`);

    // ── 4. Active access codes (collision avoidance) ────────────────────────
    const usedCodes = new Set<string>();
    const allBookings = await ctx.db.query("bookings").collect();
    for (const b of allBookings) {
      if (b.status === "cancelled") continue;
      if (b.accessCode) usedCodes.add(b.accessCode);
      for (const s of b.athleteSlots ?? []) if (s.accessCode) usedCodes.add(s.accessCode);
    }

    // coach rate
    const settings: any = await ctx.db.query("siteSettings").first();
    const coachPerHour: number = settings?.coachPerHour ?? 25;

    // ── 5. Insert the 15 bookings ───────────────────────────────────────────
    let created = 0;
    for (const def of BOOKINGS) {
      const code = makeCode(usedCodes);
      const slots = def.slots.map((s) => {
        const a = athleteByName[s.athlete];
        if (!a) throw new Error(`Unknown athlete in booking def: ${s.athlete}`);
        return {
          athleteId: a.id,
          athleteName: a.name,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
          accessCode: code,
          codeGeneratedAt: new Date().toISOString(),
        };
      });
      const coachPrice = Math.round((def.duration / 60) * coachPerHour * 100) / 100;
      if (!args.dryRun) {
        await ctx.db.insert("bookings", {
          laneId: def.laneId,
          date: def.date,
          startHour: def.startHour,
          duration: def.duration,
          customerName: COACH_NAME,
          customerEmail: COACH_EMAIL,
          // Coach bookings are matched to the coach by customerEmail (queries.ts
          // ownership filter), so no userId is needed (customers has no userId field).
          status: "confirmed",
          isCoachBooking: true,
          coachPrice,
          athleteSlots: slots.length ? slots : undefined,
          accessCode: code,
          paymentStatus: "paid",
          laneNameSnapshot: defaultLaneName(def.laneId),
          createdByAdmin: def.createdByAdmin ? true : undefined,
        });
      }
      created++;
    }
    log.push(`inserted ${created} Dean coach bookings (coachPerHour=${coachPerHour})`);

    return { dryRun: !!args.dryRun, coachId, athletesCreated, athletesPatched, deleted, created, log };
  },
});
