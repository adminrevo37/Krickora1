"use node";
/**
 * Admin second-factor verify (SPEC_SECURITY_HARDENING #2).
 * The admin re-enters their OWN account password; on success we record an
 * `adminUnlocks` row with a TTL. Node action because it uses Better Auth's
 * password hasher to verify against the stored credential hash.
 */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { createAuth } from "./auth";
import { requireAdminAction } from "./lib/adminGuard";

export const verifyAdminPassword = action({
  args: { password: v.string() },
  handler: async (
    ctx,
    { password }
  ): Promise<{ success: boolean; expiresAt?: number; error?: string }> => {
    const user = await requireAdminAction(ctx);
    const email = (user.email ?? "").toLowerCase().trim();
    if (!email) return { success: false, error: "No email on this account." };

    try {
      const auth = createAuth(ctx as any);
      const authCtx: any = await (auth as any).$context;
      const internalAdapter: any = authCtx.internalAdapter;

      let bUser: any = await internalAdapter.findUserByEmail(email);
      if (bUser && bUser.user) bUser = bUser.user;
      if (!bUser?.id) return { success: false, error: "Account not found." };

      const accounts: any[] = await internalAdapter.findAccounts(bUser.id);
      const credential = (accounts ?? []).find(
        (a: any) => a.providerId === "credential"
      );
      if (!credential?.password) {
        return { success: false, error: "No password is set on this account." };
      }

      const ok: boolean = await authCtx.password.verify({
        password,
        hash: credential.password,
      });
      if (!ok) return { success: false, error: "Incorrect password." };

      const config = await ctx.runQuery(
        internal.adminGate.getAdminGateConfigInternal,
        {}
      );
      const minutes = config?.adminUnlockMinutes ?? 45;
      const expiresAt = Date.now() + minutes * 60_000;
      await ctx.runMutation(internal.adminGate.recordAdminUnlockInternal, {
        email,
        expiresAt,
      });
      return { success: true, expiresAt };
    } catch (e: any) {
      console.error("verifyAdminPassword failed:", e);
      return { success: false, error: "Verification failed. Please try again." };
    }
  },
});
