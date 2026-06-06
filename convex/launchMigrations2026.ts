// One-off launch migrations (2026-06). Internal functions, runnable from the CLI
// with a prod deploy key: `npx convex run launchMigrations2026:<fn> '<jsonArgs>'`.
// Kept in their own module so they're easy to find + delete once executed.

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * BATCH 3 — remove the "tentative" booking feature.
 * 1. Any booking still in `status: "tentative"` is cancelled (frees its slot — the
 *    waitlist double-book guard treats cancelled as free).
 * 2. The vestigial `tentativeSourceId` / `tentativeForDate` fields are unset on EVERY
 *    booking that carries them, so the schema can drop the columns in the next deploy
 *    without tripping document validation.
 * Idempotent — safe to run more than once.
 */
export const migrateRemoveTentative = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("bookings").collect();
    let cancelled = 0;
    let fieldsCleared = 0;
    for (const b of all) {
      const patch: Record<string, unknown> = {};
      if (b.status === "tentative") {
        patch.status = "cancelled";
        cancelled++;
      }
      if ((b as any).tentativeSourceId !== undefined) {
        patch.tentativeSourceId = undefined;
        fieldsCleared++;
      }
      if ((b as any).tentativeForDate !== undefined) {
        patch.tentativeForDate = undefined;
        // count once per row even if both fields present
        if ((b as any).tentativeSourceId === undefined) fieldsCleared++;
      }
      if (Object.keys(patch).length > 0) await ctx.db.patch(b._id, patch as any);
    }
    return { totalBookings: all.length, cancelled, fieldsCleared };
  },
});

/**
 * BATCH 2C — audit a coach's identity before re-pointing athletes. Pass an email or
 * a name fragment; returns every matching `customers` row (with role/tier/tombstone
 * flags), the athletes whose assignedCoachIds point at each row, and that email's
 * coach-booking count. Read-only.
 */
export const auditCoachIdentity = internalQuery({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const q = query.toLowerCase().trim();
    const customers = await ctx.db.query("customers").collect();
    const matches = customers.filter(
      (c: any) =>
        (c.email ?? "").toLowerCase().includes(q) ||
        (c.name ?? "").toLowerCase().includes(q),
    );
    const athletes = await ctx.db.query("athletes").collect();
    const bookings = await ctx.db.query("bookings").collect();
    return matches.map((c: any) => {
      const idStr = c._id as string;
      const email = (c.email ?? "").toLowerCase();
      const athletesPointingHere = athletes
        .filter((a: any) => (a.assignedCoachIds ?? []).includes(idStr))
        .map((a: any) => ({ _id: a._id, name: a.name, accountCustomerId: a.accountCustomerId }));
      const coachBookingCount = bookings.filter(
        (b: any) => b.isCoachBooking && (b.customerEmail ?? "").toLowerCase() === email,
      ).length;
      return {
        _id: idStr,
        email: c.email,
        name: c.name,
        role: c.role,
        coachTier: c.coachTier ?? null,
        mergedIntoCustomerId: c.mergedIntoCustomerId ?? null,
        deactivatedAt: c.deactivatedAt ?? null,
        athletesPointingHere,
        coachBookingCount,
      };
    });
  },
});

/**
 * BATCH 2C — re-point athletes from a coach's historical/duplicate customer id(s) to
 * their CURRENT canonical id. Run after `auditCoachIdentity` confirms the ids.
 * Replaces any id in `fromCoachIds` with `toCoachId` inside each athlete's
 * assignedCoachIds (de-duplicated). Idempotent.
 */
export const repointAthletesToCoach = internalMutation({
  args: { fromCoachIds: v.array(v.string()), toCoachId: v.string() },
  handler: async (ctx, { fromCoachIds, toCoachId }) => {
    const fromSet = new Set(fromCoachIds.filter((id) => id !== toCoachId));
    if (fromSet.size === 0) return { updated: 0 };
    const athletes = await ctx.db.query("athletes").collect();
    let updated = 0;
    for (const a of athletes) {
      const ids: string[] = (a as any).assignedCoachIds ?? [];
      if (!ids.some((id) => fromSet.has(id))) continue;
      const next = Array.from(new Set(ids.map((id) => (fromSet.has(id) ? toCoachId : id))));
      await ctx.db.patch(a._id, { assignedCoachIds: next } as any);
      updated++;
    }
    return { updated };
  },
});
