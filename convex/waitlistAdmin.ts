// SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part C8 — admin adds someone to a queue on
// their behalf (the phone-call case: "can you put me down for Thursday 7pm?").
// Deferred as G7 in ADMIN_BOOKING_PARITY as an unconfirmed need; the phoned-in
// pattern is now measured (a third of coach cancellations are admin-made), so it
// is real. Writes the same row shape as addToWaitlist and sends the same
// confirmation email, so the engine, positions and reminders treat it identically.
//
// userId is the Better Auth subject (holds and the offeree's own-hold pass-through
// key on it), resolved from the email. An account that has never logged in has no
// subject and is refused — an offer to them could never be booked past the hold.
import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { components, internal } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";
import { resolveLanesAtHour } from "./lanes";
import { maybeAlertMachineDemand } from "./laneDemandMonitor";

async function resolveSubject(ctx: any, email: string): Promise<string | null> {
  try {
    const u = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", value: email }],
    });
    return (u as any)?._id ?? null;
  } catch {
    return null;
  }
}

export const adminAddToWaitlist = mutation({
  args: {
    email: v.string(),
    pool: v.string(), // 'bm' | 'ru'
    date: v.string(), // YYYY-MM-DD
    hours: v.array(v.number()),
    durationMinutes: v.optional(v.number()),
    altTimeOptIn: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const email = args.email.toLowerCase().trim();
    if (!email.includes("@")) throw new ConvexError("Enter the customer's email address.");
    const cust: any = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (!cust) throw new ConvexError(`No account found for ${email}.`);
    const subject = await resolveSubject(ctx, email);
    if (!subject) throw new ConvexError(`${email} has never logged in, so an offer could not be booked by them. Ask them to sign in once first.`);
    const pool = args.pool === "ru" ? "ru" : "bm";
    const sentinel = pool === "ru" ? "*ru" : "*bm";
    if (args.hours.length === 0) throw new ConvexError("Pick at least one hour.");

    // The pool must exist at that hour (a layout override can remove it).
    const lanesAt = await resolveLanesAtHour(ctx, args.date, args.hours[0]);
    if (!lanesAt.some((l) => !l.closed && l.pool === pool)) {
      throw new ConvexError(`No ${pool.toUpperCase()} lane runs at ${args.hours[0]}:00 on that date.`);
    }

    const name = [cust.firstName, cust.lastName].filter(Boolean).join(" ") || cust.name || email;
    const d = Number(args.durationMinutes);
    const durationMinutes = Number.isFinite(d) && d > 60 ? Math.min(240, Math.round(d / 30) * 30) : undefined;

    const ids: string[] = [];
    const added: Array<{ date: string; hour: number; pool: string }> = [];
    for (const hour of args.hours) {
      const existing = await ctx.db
        .query("waitlist")
        .withIndex("by_slot", (q: any) => q.eq("laneId", sentinel).eq("date", args.date).eq("hour", hour))
        .collect();
      const dup = existing.some((e: any) => {
        const st = e.status ?? "waiting";
        return (e.userId === subject || String(e.userEmail).toLowerCase() === email) && (st === "waiting" || st === "offered");
      });
      if (dup) continue;
      const id = await ctx.db.insert("waitlist", {
        userId: subject,
        userName: name,
        userEmail: email,
        laneId: sentinel,
        date: args.date,
        hour,
        notified: false,
        ...(args.altTimeOptIn === false ? { altTimeOptIn: false } : {}),
        ...(durationMinutes ? { durationMinutes } : {}),
      });
      ids.push(id);
      added.push({ date: args.date, hour, pool: pool.toUpperCase() });
    }
    if (pool === "bm") {
      for (const a of added) {
        try { await maybeAlertMachineDemand(ctx, a.date, a.hour); } catch (err) { console.error("[demand-monitor]", err); }
      }
    }
    if (added.length > 0) {
      await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistConfirmation, {
        to: email,
        customerName: name,
        slots: added,
      });
    }
    return { added: added.length, skippedDuplicates: args.hours.length - added.length, name };
  },
});

/**
 * C5 follow-up (Inspector, 2026-09-03: "if it shows legacy I can't offer alternate
 * times"). Move legacy any-pool ('*') entries into a real pool so the admin tab's
 * pool-keyed actions (Offer a different time, etc.) apply to them. Only touches
 * '*' rows; a row already in a pool is left alone.
 */
export const adminAssignWaitlistPool = mutation({
  args: { entryIds: v.array(v.string()), pool: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const sentinel = args.pool === "ru" ? "*ru" : "*bm";
    let moved = 0;
    for (const id of args.entryIds) {
      let row: any = null;
      try { row = await ctx.db.get(id as any); } catch { row = null; }
      if (!row || typeof row.userEmail !== "string" || row.laneId !== "*") continue;
      await ctx.db.patch(row._id, { laneId: sentinel });
      moved++;
    }
    return { moved, pool: sentinel };
  },
});
