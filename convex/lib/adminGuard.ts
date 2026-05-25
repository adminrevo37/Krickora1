/**
 * Admin authorization guard for Convex mutations.
 */
import { authComponent } from "../auth";

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
    throw new Error("Not authorized");
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
  throw new Error("Not authorized");
}
