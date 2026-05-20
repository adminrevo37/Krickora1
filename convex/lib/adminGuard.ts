/**
 * Admin authorization guard for Convex mutations.
 */
import { authComponent } from "../auth";

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
