// SPEC_COACH_LEDGER_UNIFICATION_2026-08 — Phase 3: THE GUARD.
// ============================================================================
// "What does a coach owe?" is answered in several places. Twice now those answers
// have silently disagreed, and BOTH times it was found by accident while doing
// something else:
//   2026-08-19 (MON-6)      — the statement counted future-dated payments.
//   2026-08-20 (BATCH 15.2) — the Coaches-tab badge disagreed with the statement for
//                             11 of 23 coaches, worst by $1,105.
// Nothing in the system compares these numbers, so a disagreement stays invisible
// until a human eyeballs two screens side by side. This module is that comparison:
// it recomputes every coach's balance through each engine and reports any that
// differ by more than a cent — on the admin Coaches tab, and once a day by push.
//
// ⭐ It deliberately calls THE ENGINES' OWN CODE (`computeCoachBadgeBalances`,
// `computeCoachWeekFinance`), not copies of them. A guard built from copied rules
// would drift in exactly the way it exists to detect.
//
// Phase 1 (2026-08-21) closed the one gap this guard could never have covered: the
// statement's day boundary was the VIEWER'S BROWSER date, which no server-side check
// can observe. It is now `awstTodayKey()` from the shared module, same as every other
// engine, so the balance no longer depends on who is looking or from where.
//
// ⚠️ What it still cannot see: it compares BALANCES, not the individual rows behind
// them — two offsetting errors of equal size would net out.
import { query, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";
import {
  isCoachChargeBooking,
  coachBookingCost,
  awstTodayKey,
  round2,
} from "./lib/coachLedger";
import { computeCoachBadgeBalances } from "./queries";
import { computeCoachWeekFinance } from "./analyticsAdmin";
import { mondayOfWeek } from "./billingCaps";

// A cent. Below this is float noise (the weekly report round2()s at each step, the
// badge and statement do not) — above it, someone is looking at a wrong number.
const TOLERANCE = 0.01;
const EPS = 1e-9;

export type LedgerCheckRow = {
  coachId: string;
  name: string;
  email: string;
  /** Admin Coaches-tab badge (convex/queries.ts listCoachBalances). */
  badge: number;
  /** The coach's own statement (src/lib/statementLedger.ts buildCoachLedger). */
  statement: number;
  /** Weekly report finance block, asked for the balance as at today. */
  weekly: number;
  /** Largest gap between any two engines, in dollars. */
  maxDelta: number;
  notes: string[];
};

export type LedgerCheckResult = {
  /** AWST date every engine was bounded to. */
  asAt: string;
  checkedAt: string;
  coachCount: number;
  ok: boolean;
  mismatches: LedgerCheckRow[];
  /**
   * Charge-bearing coach bookings whose customerEmail matches no coach `customers`
   * row. These are billed by nobody and invisible on every statement — the live
   * exposure meter for disagreement #2 (identity key). Measured 0 on prod 2026-08-21.
   */
  orphanCharges: { count: number; total: number; emails: string[] };
  caveats: string[];
};

const CAVEATS = [
  "Balances are compared, not the rows behind them: two offsetting errors of equal size would net to zero.",
];

// The STATEMENT engine, server-side. The arithmetic is trivial (booked + adjust −
// paid); what matters — and what this reproduces exactly — is the statement's DATA
// SELECTION, i.e. the three queries CoachStatementTable/statements.tsx actually call:
//   listBookingsByEmail      → bookings by EXACT `by_customerEmail` equality
//   listPaymentsByCoach      → payments by `by_coachId`
//   listStatementAdjustments → adjustments by `by_subject`
// The exact-equality booking lookup is the important one: the badge groups bookings
// by their LOWERCASED, TRIMMED stored email, so any stored address differing from the
// coach's `customers.email` in case or whitespace is counted by the badge and missed
// by the statement. That is disagreement #2 in its most likely live form.
async function statementBalance(
  ctx: any,
  coach: any,
  asAt: string
): Promise<{ balance: number; notes: string[] }> {
  const notes: string[] = [];
  const email = (coach.email ?? "").toLowerCase().trim();
  const cid = String(coach._id);

  let booked = 0;
  if (email) {
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_customerEmail", (q: any) => q.eq("customerEmail", email))
      .collect();
    for (const b of bookings as any[]) {
      if (!isCoachChargeBooking(b)) continue;
      if ((b.date ?? "") > asAt) continue;
      booked += coachBookingCost(b);
    }
  } else {
    notes.push("Coach has no email on file — their statement can load no bookings at all.");
  }

  let paid = 0;
  for (const p of (await ctx.db
    .query("payments")
    .withIndex("by_coachId", (q: any) => q.eq("coachId", cid))
    .collect()) as any[]) {
    if ((p.dateReceived ?? "") > asAt) continue;
    paid += Number(p.amount) || 0;
  }

  let adjust = 0;
  for (const a of (await ctx.db
    .query("statementAdjustments")
    .withIndex("by_subject", (q: any) =>
      q.eq("subjectType", "coach").eq("subjectId", coach._id)
    )
    .collect()) as any[]) {
    if ((a.date ?? "") > asAt) continue;
    adjust += Number(a.delta) || 0;
  }

  return { balance: booked + adjust - paid, notes };
}

async function computeLedgerCheck(ctx: any): Promise<LedgerCheckResult> {
  const asAt = awstTodayKey();

  // Engine A — the admin badge, via its own function.
  const { rows: badgeRows, chargedByEmail } = await computeCoachBadgeBalances(ctx, asAt);
  const badgeByCoach = new Map<string, number>(
    badgeRows.map((r) => [r.coachId, Number(r.balance) || 0])
  );

  // Engine B — the weekly report's finance block, asked for the balance AS AT TODAY.
  // Its closingBalance is bounded at weekEnd, so weekEnd = today makes it answer the
  // same question the badge does. (weekStart only affects where round2() lands, which
  // is why the tolerance is a cent rather than zero.)
  const { coachDocs, financeByEmail } = await computeCoachWeekFinance(
    ctx,
    mondayOfWeek(asAt),
    asAt
  );

  const mismatches: LedgerCheckRow[] = [];
  const coachEmails = new Set<string>();

  for (const c of coachDocs as any[]) {
    const coachId = String(c._id);
    const email = (c.email ?? "").toLowerCase().trim();
    if (email) coachEmails.add(email);

    // Every engine rounded to cents before comparing, so "agree" means agree on the
    // money — not on float residue left by whichever engine happened to round first.
    const badge = round2(badgeByCoach.get(coachId) ?? 0);
    const weekly = round2(financeByEmail.get(email)?.closingBalance ?? 0);
    // Engine C — the statement.
    const { balance: rawStatement, notes } = await statementBalance(ctx, c, asAt);
    const statement = round2(rawStatement);

    const maxDelta = Math.max(
      Math.abs(badge - statement),
      Math.abs(badge - weekly),
      Math.abs(statement - weekly)
    );
    if (maxDelta > TOLERANCE + EPS) {
      if (Math.abs(badge - statement) > TOLERANCE + EPS) {
        notes.push(
          badge > statement
            ? "The badge charges more than the statement — usually a booking whose stored email differs in case or spacing from the coach's account email."
            : "The statement charges more than the badge."
        );
      }
      if (Math.abs(badge - weekly) > TOLERANCE + EPS) {
        notes.push("The weekly report disagrees with the badge for the same as-at date.");
      }
      mismatches.push({
        coachId,
        name: c.name || email || coachId,
        email: c.email || "",
        badge,
        statement,
        weekly,
        maxDelta: round2(maxDelta),
        notes,
      });
    }
  }

  // Coach charges that belong to nobody.
  let orphanCount = 0;
  let orphanTotal = 0;
  const orphanEmails: string[] = [];
  for (const [email, total] of chargedByEmail) {
    if (coachEmails.has(email)) continue;
    orphanCount += 1;
    orphanTotal += total;
    if (orphanEmails.length < 10) orphanEmails.push(email);
  }

  mismatches.sort((a, b) => b.maxDelta - a.maxDelta);

  return {
    asAt,
    checkedAt: new Date().toISOString(),
    coachCount: (coachDocs as any[]).length,
    ok: mismatches.length === 0 && orphanCount === 0,
    mismatches,
    orphanCharges: {
      count: orphanCount,
      total: round2(orphanTotal),
      emails: orphanEmails,
    },
    caveats: CAVEATS,
  };
}

/** Admin-only. Drives the "Ledger check" line on the Coaches tab. */
export const reconcileCoachLedgers = query({
  args: {},
  handler: async (ctx): Promise<LedgerCheckResult> => {
    await requireAdmin(ctx);
    return await computeLedgerCheck(ctx);
  },
});

/** The same check for the daily cron (no admin identity is available there). */
export const reconcileCoachLedgersInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<LedgerCheckResult> => await computeLedgerCheck(ctx),
});

// Daily backstop. Silent when everything agrees — an alert that fires every day is
// an alert nobody reads (same convention as the hourly admin digest, which skips
// all-zero hours).
export const runDailyLedgerCheck = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; mismatches: number; orphans: number }> => {
    const result: LedgerCheckResult = await ctx.runQuery(
      internal.coachLedgerCheck.reconcileCoachLedgersInternal,
      {}
    );
    if (result.ok) {
      return { ok: true, mismatches: 0, orphans: 0 };
    }

    const parts: string[] = [];
    if (result.mismatches.length > 0) {
      const shown = Math.min(3, result.mismatches.length);
      const named = result.mismatches
        .slice(0, shown)
        .map((m) => `${m.name} ($${m.maxDelta.toFixed(2)})`)
        .join(", ");
      const more = result.mismatches.length - shown;
      parts.push(
        `${result.mismatches.length} coach${result.mismatches.length === 1 ? "" : "es"} disagree: ${named}${more > 0 ? ` +${more} more` : ""}.`
      );
    }
    if (result.orphanCharges.count > 0) {
      parts.push(
        `$${result.orphanCharges.total.toFixed(2)} of coach charges belong to no coach account.`
      );
    }

    await ctx.scheduler.runAfter(0, internal.push.sendAdminPush, {
      title: "⚠️ Coach ledger mismatch",
      body: parts.join(" "),
      url: "/rev-ops-7k2p",
      tag: "coach-ledger-check",
    });
    console.error(
      `[ledger-check] ${result.mismatches.length} mismatch(es), ${result.orphanCharges.count} orphan email(s) as at ${result.asAt}`
    );
    return {
      ok: false,
      mismatches: result.mismatches.length,
      orphans: result.orphanCharges.count,
    };
  },
});
