/**
 * Admin authorization guard for Convex mutations.
 */
import { authComponent } from "../auth";
import { ConvexError } from "convex/values";

/**
 * Returns the authenticated Better Auth user, or null if not authenticated.
 * Safe to call from any Convex function context (query, mutation, action).
 */
export async function getAuthUserSafe(ctx: any): Promise<any | null> {
  try {
    return await authComponent.getAuthUser(ctx) ?? null;
  } catch {
    return null;
  }
}

/**
 * Single source of truth for admin resolution (M-1/S-2). `customers.role` is
 * authoritative whenever the caller has a customers row; the Better-Auth
 * `user.role` is honoured ONLY as a bootstrap fallback when no customers row
 * exists yet (the first admin set via the Convex dashboard). Both `requireAdmin`
 * and `getCallerContext` route through this, so the two resolvers can never
 * disagree (the old drift: requireAdmin trusted user.role first, getCallerContext
 * read customers.role only).
 *
 * `knownAuthRole` lets a caller that already loaded the Better-Auth user skip a
 * second lookup; omit it and the resolver fetches the role itself only when it
 * actually needs the bootstrap fallback (no customers row) — so the common
 * logged-in-customer path adds zero extra reads.
 */
export async function resolveIsAdmin(
  ctx: any,
  email: string | null | undefined,
  knownAuthRole?: string
): Promise<boolean> {
  const e = email?.toLowerCase?.().trim?.() ?? "";
  if (e && ctx.db) {
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", e))
      .first();
    if (customer) return customer.role === "admin";
  }
  // No customers row → bootstrap fallback to the Better-Auth user role.
  if (knownAuthRole !== undefined) return knownAuthRole === "admin";
  const authUser = await getAuthUserSafe(ctx);
  return (authUser as any)?.role === "admin";
}

export async function requireAdmin(ctx: any): Promise<{
  _id: string;
  email: string;
  name?: string | null;
  role?: string;
}> {
  const user = await authComponent.getAuthUser(ctx);
  if (!user) {
    throw new ConvexError("Not authorized");
  }
  if (await resolveIsAdmin(ctx, (user as any).email, (user as any).role)) {
    return user as any;
  }
  throw new ConvexError("Not authorized");
}

/**
 * Admin guard for ACTIONS (no ctx.db access). Relies solely on the Better Auth
 * user role. Use in `action`/`"use node"` contexts where requireAdmin's
 * customers-table fallback (ctx.db) is unavailable.
 */
export async function requireAdminAction(ctx: any): Promise<{
  _id: string;
  email: string;
  role?: string;
}> {
  const user = await authComponent.getAuthUser(ctx);
  if (!user || (user as any).role !== "admin") {
    throw new ConvexError("Not authorized");
  }
  return user as any;
}

/**
 * Admin guard for sensitive WRITE mutations that ALSO enforces the second-factor
 * unlock (SPEC_SECURITY_HARDENING #2) when siteSettings.adminGateEnabled is on.
 * Drop-in replacement for requireAdmin: behaves identically while the gate is
 * off. Mutation context only (reads the clock).
 */
export async function requireAdminUnlocked(ctx: any): Promise<{
  _id: string;
  email: string;
  role?: string;
}> {
  const user = await requireAdmin(ctx);
  const settings = await ctx.db
    .query("siteSettings")
    .withIndex("by_key", (q: any) => q.eq("key", "global"))
    .first();
  if (!settings?.adminGateEnabled) return user as any;
  const email = (user as any).email?.toLowerCase?.().trim?.() ?? "";
  const unlock = email
    ? await ctx.db
        .query("adminUnlocks")
        .withIndex("by_email", (q: any) => q.eq("email", email))
        .first()
    : null;
  if (!unlock || unlock.expiresAt < Date.now()) {
    throw new ConvexError(
      "Admin session locked — re-enter your password in the admin panel to continue."
    );
  }
  return user as any;
}

/**
 * Resolve the caller's identity, normalised email and admin status in one shot.
 * Safe in any query/mutation context — never throws. Returns isAdmin=false and
 * email="" for unauthenticated callers.
 *
 * Used by field-scoping queries (SEC-1) so unauthenticated/other-user callers
 * get sanitised data instead of an error.
 */
export async function getCallerContext(ctx: any): Promise<{
  identity: any | null;
  email: string;
  isAdmin: boolean;
}> {
  let identity: any = null;
  try {
    identity = await ctx.auth.getUserIdentity();
  } catch {
    identity = null;
  }
  if (!identity) return { identity: null, email: "", isAdmin: false };
  const email = identity.email?.toLowerCase?.().trim?.() ?? "";
  // M-1/S-2: same resolver as requireAdmin — customers.role authoritative, with
  // the Better-Auth user.role as a bootstrap fallback only when no customers row.
  const isAdmin = await resolveIsAdmin(ctx, email);
  return { identity, email, isAdmin };
}

/**
 * Strip all customer PII from a booking record, leaving only scheduling fields
 * visible (SEC-1). Mirrors the sanitisation used by listBookings.
 */
export function stripBookingPII<T extends Record<string, any>>(booking: T): T {
  return {
    ...booking,
    customerName: "Booked",
    customerEmail: "",
    customerPhone: undefined,
    // never leak access codes, athlete names, the booker's home location, private
    // notes or their discount code to non-owners (H1: listBookings was leaking these)
    accessCode: undefined,
    athleteSlots: undefined,
    bookingPostcode: undefined,
    bookingSuburb: undefined,
    notes: undefined,
    discountCode: undefined,
  };
}

/**
 * Append a role/permission change to the audit log (SEC decision #3).
 * Best-effort: never throws (a logging failure must not block the change).
 */
export async function writeRoleAudit(
  ctx: any,
  entry: {
    targetEmail: string;
    field: string;
    oldValue?: string;
    newValue?: string;
    changedByEmail: string;
  }
): Promise<void> {
  try {
    await ctx.db.insert("roleAuditLog", {
      ...entry,
      changedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("writeRoleAudit failed:", e);
  }
}
