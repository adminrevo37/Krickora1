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
  if ((user as any).role === "admin") {
    return user as any;
  }
  // Fallback: check customers table by email
  const email = (user as any).email?.toLowerCase?.().trim?.();
  if (email) {
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (customer && customer.role === "admin") {
      return user as any;
    }
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
  let isAdmin = false;
  if (email && ctx.db) {
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    isAdmin = customer?.role === "admin";
  }
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
    // never leak access codes or athlete names to non-owners
    accessCode: undefined,
    athleteSlots: undefined,
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
