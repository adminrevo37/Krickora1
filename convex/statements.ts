// SPEC_STATEMENTS_EDITING — manual statement adjustment lines (coach + customer).
//
// An adjustment is an admin-entered ledger line: delta is signed dollars
// (+ = charge/owed, − = credit/discount, 0 = a pure note). Coach statements fold
// these into the running balance; customer statements (transaction-history only)
// show them as informational entries. All mutations are admin-gated; createdBy is
// derived server-side from the authenticated admin (never trusted from the client).
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireAdmin, getCallerContext } from "./lib/adminGuard";

const SUBJECT_TYPES = ["coach", "customer"];

function adminLabel(user: any): string {
  return (
    user?.email?.toLowerCase?.().trim?.() ??
    user?._id?.toString?.() ??
    user?.id ??
    "admin"
  );
}

// List the adjustment lines for one subject (coach or customer).
// Admin sees any; a coach/customer sees only their OWN lines. [] otherwise.
export const listStatementAdjustments = query({
  args: {
    subjectType: v.string(),
    subjectId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    if (!caller.isAdmin) {
      // Non-admins may only read adjustments on their own customers row.
      const me = caller.email
        ? await ctx.db
            .query("customers")
            .withIndex("by_email", (q: any) => q.eq("email", caller.email))
            .first()
        : null;
      if (!me || me._id !== args.subjectId) return [];
    }
    return await ctx.db
      .query("statementAdjustments")
      .withIndex("by_subject", (q: any) =>
        q.eq("subjectType", args.subjectType).eq("subjectId", args.subjectId)
      )
      .collect();
  },
});

export const addStatementAdjustment = mutation({
  args: {
    subjectType: v.string(),
    subjectId: v.id("customers"),
    delta: v.number(),
    label: v.string(),
    note: v.optional(v.string()),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    if (!SUBJECT_TYPES.includes(args.subjectType)) {
      throw new ConvexError("Invalid subject type");
    }
    if (!args.label.trim()) {
      throw new ConvexError("A label is required");
    }
    const subject = await ctx.db.get(args.subjectId);
    if (!subject) throw new ConvexError("Subject not found");
    return await ctx.db.insert("statementAdjustments", {
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      delta: args.delta,
      label: args.label.trim(),
      note: args.note?.trim() || undefined,
      date: args.date,
      createdBy: adminLabel(admin),
      createdAt: new Date().toISOString(),
    });
  },
});

export const updateStatementAdjustment = mutation({
  args: {
    id: v.id("statementAdjustments"),
    delta: v.optional(v.number()),
    label: v.optional(v.string()),
    note: v.optional(v.string()),
    date: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("Adjustment not found");
    const patch: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (args.delta !== undefined) patch.delta = args.delta;
    if (args.label !== undefined) {
      if (!args.label.trim()) throw new ConvexError("A label is required");
      patch.label = args.label.trim();
    }
    if (args.note !== undefined) patch.note = args.note.trim() || undefined;
    if (args.date !== undefined) patch.date = args.date;
    await ctx.db.patch(args.id, patch);
    return args.id;
  },
});

export const deleteStatementAdjustment = mutation({
  args: { id: v.id("statementAdjustments") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("Adjustment not found");
    await ctx.db.delete(args.id);
    return args.id;
  },
});
