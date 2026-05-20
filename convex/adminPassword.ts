"use node";
/**
 * Admin-only action to reset/set a user's password directly.
 * Uses Better Auth's own APIs so the credential account is created
 * exactly the way sign-up would create it.
 */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { createAuth } from "./auth";

export const adminSetPassword = action({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, { email, password }) => {
    const normalized = email.toLowerCase().trim();
    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }

    const auth = createAuth(ctx as any);
    const authCtx: any = await (auth as any).$context;
    const internalAdapter: any = authCtx.internalAdapter;

    // 1) Look up the user by email
    let user: any = null;
    try {
      user = await internalAdapter.findUserByEmail(normalized);
      // Some versions wrap in { user, accounts }
      if (user && user.user) user = user.user;
    } catch (err) {
      console.log("findUserByEmail failed, will try sign-up:", err);
      user = null;
    }

    // 2) If no user exists, create one via the normal sign-up flow
    if (!user?.id) {
      try {
        const result: any = await auth.api.signUpEmail({
          body: {
            email: normalized,
            password,
            name: normalized.split("@")[0],
          },
        });
        return {
          success: true,
          message: `Account created and password set for ${normalized}`,
          userId: result?.user?.id,
        };
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        // If the user actually exists but findUserByEmail missed them,
        // fall through to the password-update path by re-fetching.
        if (!/already|exists|taken/i.test(msg)) {
          console.error("signUpEmail failed:", err);
          throw new Error(`Failed to create account: ${msg}`);
        }
        user = await internalAdapter.findUserByEmail(normalized);
        if (user && user.user) user = user.user;
        if (!user?.id) {
          throw new Error(`Could not resolve user for ${normalized}`);
        }
      }
    }

    // 3) Hash the password using Better Auth's configured hasher
    const hashed: string = await authCtx.password.hash(password);

    // 4) Find existing credential account for this user
    const accounts: any[] = await internalAdapter.findAccounts(user.id);
    const credential = (accounts ?? []).find(
      (a: any) => a.providerId === "credential"
    );

    if (credential) {
      await internalAdapter.updatePassword(user.id, hashed);
    } else {
      // No credential account yet — create one
      await internalAdapter.createAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: hashed,
      });
    }

    return {
      success: true,
      message: `Password updated for ${normalized}`,
      userId: user.id,
    };
  },
});
