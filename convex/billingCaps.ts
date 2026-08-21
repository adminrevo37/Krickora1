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
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";
import {
  isCoachChargeBooking,
  coachBookingCost,
  awstTodayKey,
  round2,
} from "./lib/coachLedger";

const WEEKLY_CAP_CREATED_BY = "system:weekly-cap";

// Add N days to a YYYY-MM-DD (UTC arithmetic, calendar-safe, no TZ drift).
function addDaysStr(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Monday (YYYY-MM-DD) of the week containing dateStr.
export function mondayOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDaysStr(dateStr, diff);
}

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

// Core reconciler — idempotent. Upserts/removes the cap line for one (coach, week).
export const reconcileCoachWeeklyCapInternal = internalMutation({
  args: { coachId: v.id("customers"), weekStart: v.string() },
  handler: async (ctx, { coachId, weekStart }) => {
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
  },
});

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
    const thisWk = mondayOfWeek(awstTodayKey());
    const lastWk = addDaysStr(thisWk, -7);
    for (const c of coaches as any[]) {
      if (c.weeklyBillingCap == null) continue;
      await ctx.scheduler.runAfter(0, internal.billingCaps.reconcileCoachWeeklyCapInternal, { coachId: c._id, weekStart: thisWk });
      await ctx.scheduler.runAfter(0, internal.billingCaps.reconcileCoachWeeklyCapInternal, { coachId: c._id, weekStart: lastWk });
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
