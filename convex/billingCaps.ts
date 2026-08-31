// WEEKLY COACH BILLING CAP (2026-07)
// ============================================================================
// A coach can have a per-week charge ceiling (customers.weeklyBillingCap, dollars).
// When a Mon–Sun week's booked coach charges exceed it, a SYSTEM statement
// adjustment line ("Weekly billing cap ($X)") credits the excess so the week nets
// to the cap. The adjustment is a real statementAdjustments row, so it shows on the
// coach's statement AND flows into the weekly report's closing balance with no
// extra rendering. Reconciled idempotently: on coach booking create/cancel, a
// nightly cron backstop, and whenever the cap is set/changed.
//
// The reconciler owns ONLY its own lines (createdBy = WEEKLY_CAP_CREATED_BY, one per
// coach+week keyed by the week-end date) — it never touches an admin's manual
// adjustment.
//
// PAYMENT NET-OFF (2026-08-31, Inspector): a capped coach paying a flat weekly amount
// (e.g. Dean's habitual $600 cash) doesn't necessarily match that week's capped
// liability exactly — the mismatch used to just sit as a permanent, non-resolving
// credit (proven: `charges - 600 (payment) - (charges-cap) (auto cap credit) = -cap`
// is a fixed point independent of `charges`, so nothing ever paid it down). A SECOND
// reconciler now runs whenever a payment is saved/edited/deleted: it recomputes the
// coach's real balance as at that week's end and, ONLY if it's a CREDIT, adds a
// second adjustment line ("Payment net-off") to bring it to exactly $0. It never
// forgives a genuine shortfall — a balance still owed (>= 0) is left untouched.
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";
import {
  isCoachChargeBooking,
  coachBookingCost,
  computeCoachLedger,
  awstTodayKey,
  round2,
  addDaysStr,
  mondayOfWeek,
} from "./lib/coachLedger";

const WEEKLY_CAP_CREATED_BY = "system:weekly-cap";
const PAYMENT_NETOFF_CREATED_BY = "system:weekly-cap-payment-netoff";

// How far back the nightly backstop re-derives cap credits (weeks, including this one).
const BACKSTOP_WEEKS = 13;

// Phase 5: the Mon–Sun week is defined ONCE, in the shared module, so the billing cap,
// the weekly report and the coach-facing "end of week" balance cannot disagree about
// which days a week contains. Re-exported here because call sites already import it.
export { mondayOfWeek };

// Sum a coach's booked charges for a Mon–Sun week.
//
// SPEC_COACH_LEDGER_UNIFICATION_2026-08 Phase 1: this used to carry its OWN inline
// copy of the charge rules — the third hand-maintained copy — with a comment claiming
// a parity it did not enforce. It now uses the shared definitions, so a rule change
// can no longer land in the statement and miss the cap.
// (Behaviour is unchanged: the old code `continue`d on statementExcluded, the shared
// helper costs it at $0, and a sum treats those identically.)
async function weekChargesForCoach(
  ctx: any,
  coachEmail: string,
  weekStart: string,
  weekEnd: string
): Promise<number> {
  const email = coachEmail.toLowerCase().trim();
  const bookings = await ctx.db
    .query("bookings")
    .withIndex("by_date", (q: any) => q.gte("date", weekStart).lte("date", weekEnd))
    .collect();
  let total = 0;
  for (const b of bookings) {
    if (!isCoachChargeBooking(b)) continue;
    if ((b.customerEmail ?? "").toLowerCase().trim() !== email) continue;
    total += coachBookingCost(b);
  }
  return round2(total);
}

async function findCapLine(ctx: any, coachId: any, weekEnd: string): Promise<any | null> {
  const rows = await ctx.db
    .query("statementAdjustments")
    .withIndex("by_subject", (q: any) => q.eq("subjectType", "coach").eq("subjectId", coachId))
    .collect();
  return rows.find((r: any) => r.createdBy === WEEKLY_CAP_CREATED_BY && r.date === weekEnd) ?? null;
}

// Core reconciler logic — idempotent. Upserts/removes the cap line for one (coach,
// week). Factored out of the internalMutation below (plain async fn, not a Convex
// mutation itself) so `reconcileCoachPaymentInternal` can run it and the payment
// net-off reconciler in the SAME mutation, guaranteeing the net-off sees a fresh
// cap-credit line rather than racing two separately-scheduled mutations.
async function reconcileCapCore(ctx: any, coachId: any, weekStart: string): Promise<void> {
  const coach: any = await ctx.db.get(coachId);
  const weekEnd = addDaysStr(weekStart, 6);
  const existing = await findCapLine(ctx, coachId, weekEnd);
  const cap = coach?.weeklyBillingCap;
  // No coach / no cap → drop any stray cap line and stop.
  if (coach?.role !== "coach" || cap == null || !(cap >= 0)) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  const charges = await weekChargesForCoach(ctx, coach.email ?? "", weekStart, weekEnd);
  const overage = round2(charges - cap);
  const nowIso = new Date().toISOString();
  if (overage > 0) {
    const delta = -overage; // negative = a credit that reduces the balance
    const label = `Weekly billing cap ($${cap.toFixed(0)})`;
    const note = `Auto: $${charges.toFixed(2)} in coach sessions capped to $${cap.toFixed(2)} for the week of ${weekStart}.`;
    if (existing) {
      if (existing.delta !== delta || existing.label !== label || existing.note !== note) {
        await ctx.db.patch(existing._id, { delta, label, note, updatedAt: nowIso });
      }
    } else {
      await ctx.db.insert("statementAdjustments", {
        subjectType: "coach",
        subjectId: coachId,
        delta,
        label,
        note,
        date: weekEnd,
        createdBy: WEEKLY_CAP_CREATED_BY,
        createdAt: nowIso,
      });
    }
  } else if (existing) {
    await ctx.db.delete(existing._id); // back under the cap → remove the credit
  }
}

export const reconcileCoachWeeklyCapInternal = internalMutation({
  args: { coachId: v.id("customers"), weekStart: v.string() },
  handler: async (ctx, { coachId, weekStart }) => {
    await reconcileCapCore(ctx, coachId, weekStart);
  },
});

async function findNetOffLine(ctx: any, coachId: any, weekEnd: string): Promise<any | null> {
  const rows = await ctx.db
    .query("statementAdjustments")
    .withIndex("by_subject", (q: any) => q.eq("subjectType", "coach").eq("subjectId", coachId))
    .collect();
  return rows.find((r: any) => r.createdBy === PAYMENT_NETOFF_CREATED_BY && r.date === weekEnd) ?? null;
}

// Idempotent — deletes its own prior line first (so the balance recompute below isn't
// self-referential), then re-adds exactly enough to zero a CREDIT. Never touches a
// genuine amount still owed.
async function reconcilePaymentNetOffCore(ctx: any, coachId: any, weekEnd: string): Promise<void> {
  const coach: any = await ctx.db.get(coachId);
  const existing = await findNetOffLine(ctx, coachId, weekEnd);
  if (!coach || coach.role !== "coach" || coach.weeklyBillingCap == null) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  if (existing) await ctx.db.delete(existing._id);

  const email = (coach.email ?? "").toLowerCase().trim();
  const bookings = email
    ? await ctx.db.query("bookings").withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", email)).collect()
    : [];
  const payments = await ctx.db.query("payments").withIndex("by_coachId", (q: any) => q.eq("coachId", String(coachId))).collect();
  const adjustments = await ctx.db
    .query("statementAdjustments")
    .withIndex("by_subject", (q: any) => q.eq("subjectType", "coach").eq("subjectId", coachId))
    .collect();

  const { balance } = computeCoachLedger({ bookings, payments, adjustments, asAt: weekEnd });
  if (balance < 0) {
    const delta = round2(-balance); // positive charge, bringing the credit up to $0
    await ctx.db.insert("statementAdjustments", {
      subjectType: "coach",
      subjectId: coachId,
      delta,
      label: "Payment net-off",
      note: `Auto: this week's payment left a $${(-balance).toFixed(2)} credit — netted to $0.00.`,
      date: weekEnd,
      createdBy: PAYMENT_NETOFF_CREATED_BY,
      createdAt: new Date().toISOString(),
    });
  }
}

// Runs both reconcilers for one (coach, week) in a single mutation — the cap-credit
// line first, then the net-off, so the net-off sees a fresh cap-credit rather than
// racing two separately-scheduled mutations. Triggered after a payment is saved.
export const reconcileCoachPaymentInternal = internalMutation({
  args: { coachId: v.id("customers"), weekStart: v.string() },
  handler: async (ctx, { coachId, weekStart }) => {
    await reconcileCapCore(ctx, coachId, weekStart);
    await reconcilePaymentNetOffCore(ctx, coachId, addDaysStr(weekStart, 6));
  },
});

// Fire-and-forget: call after a coach payment is created/edited/deleted. No-op for
// uncapped coaches (one doc read). Never throws into the caller.
export async function scheduleCapReconcileForPayment(
  ctx: any,
  coachId: string | undefined,
  dateReceived: string | undefined
): Promise<void> {
  try {
    if (!coachId || !dateReceived) return;
    const coach = await ctx.db.get(coachId as any);
    if (!coach || (coach as any).role !== "coach" || (coach as any).weeklyBillingCap == null) return;
    await ctx.scheduler.runAfter(0, internal.billingCaps.reconcileCoachPaymentInternal, {
      coachId: coachId as any,
      weekStart: mondayOfWeek(dateReceived),
    });
  } catch (e: any) {
    console.warn(`[billing-cap] payment-netoff schedule skipped: ${e?.message}`);
  }
}

// Fire-and-forget helper: call after a coach charge changes (create/cancel/modify)
// to re-cap that coach's affected week. No-ops for uncapped coaches (one indexed
// email lookup). Never throws into the caller.
export async function scheduleCapReconcileForBooking(
  ctx: any,
  coachEmail: string | undefined,
  sessionDate: string | undefined
): Promise<void> {
  try {
    if (!coachEmail || !sessionDate) return;
    const email = coachEmail.toLowerCase().trim();
    const coach = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (!coach || (coach as any).role !== "coach" || (coach as any).weeklyBillingCap == null) return;
    await ctx.scheduler.runAfter(0, internal.billingCaps.reconcileCoachWeeklyCapInternal, {
      coachId: (coach as any)._id,
      weekStart: mondayOfWeek(sessionDate),
    });
  } catch (e: any) {
    console.warn(`[billing-cap] reconcile-schedule skipped: ${e?.message}`);
  }
}

// Nightly backstop — re-cap this + last week for every capped coach (covers
// modify / setCoachPrice / statement-exclude changes not individually triggered).
export const reconcileAllWeeklyCapsInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const coaches = await ctx.db
      .query("customers")
      .withIndex("by_role", (q: any) => q.eq("role", "coach"))
      .collect();
    // Phase 4 (#12): the backstop used to cover only this week and last week, so an edit
    // to a charge older than a fortnight left the cap credit wrong forever. The edit
    // itself now schedules its own reconcile (adminSetCoachPrice /
    // adminSetBookingStatementExcluded), and this widens the sweep to a rolling quarter
    // so anything that still slips through is corrected within a day.
    // Cheap: only CAPPED coaches are swept, and each week is one indexed read.
    const thisWk = mondayOfWeek(awstTodayKey());
    const weeks = Array.from({ length: BACKSTOP_WEEKS }, (_, i) => addDaysStr(thisWk, -7 * i));
    for (const c of coaches as any[]) {
      if (c.weeklyBillingCap == null) continue;
      for (const weekStart of weeks) {
        await ctx.scheduler.runAfter(0, internal.billingCaps.reconcileCoachWeeklyCapInternal, { coachId: c._id, weekStart });
      }
    }
  },
});

// ── Admin surface ────────────────────────────────────────────────────────────

export const getCoachWeeklyCap = query({
  args: { coachId: v.id("customers") },
  handler: async (ctx, { coachId }) => {
    await requireAdmin(ctx);
    const coach: any = await ctx.db.get(coachId);
    return { cap: coach?.weeklyBillingCap ?? null };
  },
});

// Set (or clear, cap=null) a coach's weekly cap, then backfill-reconcile the last
// 13 weeks so existing over-cap weeks get their credit line (and clearing the cap
// removes any stray lines).
export const setCoachWeeklyCap = mutation({
  args: { coachId: v.id("customers"), cap: v.union(v.number(), v.null()) },
  handler: async (ctx, { coachId, cap }) => {
    await requireAdmin(ctx);
    const coach: any = await ctx.db.get(coachId);
    if (!coach || coach.role !== "coach") throw new ConvexError("Not a coach.");
    if (cap != null && (!(cap >= 0) || cap > 100000)) throw new ConvexError("Enter a cap between 0 and 100000.");
    await ctx.db.patch(coachId, {
      weeklyBillingCap: cap == null ? undefined : round2(cap),
    });
    let wk = mondayOfWeek(awstTodayKey());
    for (let i = 0; i < 13; i++) {
      await ctx.scheduler.runAfter(0, internal.billingCaps.reconcileCoachWeeklyCapInternal, { coachId, weekStart: wk });
      wk = addDaysStr(wk, -7);
    }
    return { ok: true, cap: cap == null ? null : round2(cap) };
  },
});
