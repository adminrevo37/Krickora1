/**
 * Better Auth Setup for Convex (Component / Local Install)
 * Uses local schema for admin plugin support
 * ALL auth logic consolidated in Convex — Railway fully decommissioned.
 * @see https://convex-better-auth.netlify.app/features/local-install
 */
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { admin } from "better-auth/plugins";
import { components } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import authSchema from "./betterAuth/schema";
import authConfig from "./auth.config";
import { requireAdmin } from "./lib/adminGuard";

const siteUrl = process.env.SITE_URL || "";

// Create the Better Auth component client with LOCAL schema
export const authComponent = createClient<DataModel, typeof authSchema>(
  components.betterAuth,
  {
    local: {
      schema: authSchema,
    },
  }
);

// Static trusted origins for CORS
const staticOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:8081",
  "https://adventurous-chickadee-53.convex.site",
  "https://adventurous-chickadee-53.convex.cloud",
  "https://krickora.shipper.now",
];

/**
 * Get trusted origins array for Better Auth CORS
 */
function getTrustedOrigins(request?: Request): string[] {
  const origins = [...staticOrigins];
  if (siteUrl) origins.push(siteUrl);

  const addDynamicOrigin = (url: string | null) => {
    if (!url) return;
    const isDynamicUrl =
      url.includes(".w.modal.host") || url.includes(".shipper.now") || url.includes(".convex.site");
    if (!isDynamicUrl) return;
    try {
      const parsed = new URL(url);
      origins.push(parsed.origin);
    } catch {
      if (url.startsWith("http")) {
        origins.push(url.split("/").slice(0, 3).join("/"));
      }
    }
  };

  addDynamicOrigin(request?.headers.get("origin") ?? null);
  addDynamicOrigin(request?.headers.get("referer") ?? null);

  try {
    if (request?.url) {
      const url = new URL(request.url);
      addDynamicOrigin(url.searchParams.get("callbackURL"));
      addDynamicOrigin(url.searchParams.get("callback"));
      addDynamicOrigin(url.searchParams.get("redirectTo"));
    }
  } catch {}

  return [...new Set(origins)];
}

/**
 * Build the convex() plugin safely.
 * The convex plugin internally creates jwt, oidcProvider, and bearer plugins.
 */
function buildConvexPlugin() {
  return convex({
    authConfig,
  });
}

/**
 * Shared auth options factory — used by both createAuth (runtime) and adapter (schema gen).
 *
 * CRITICAL COOKIE SETTINGS (applied at both levels):
 * - sameSite: "none" + secure: true → MANDATORY for cross-domain auth
 *   (.convex.site ↔ .shipper.now ↔ .w.modal.host)
 * - Without this, the browser blocks auth cookies on cross-origin requests.
 *
 * generateJWTSessionToken: true → Better Auth generates JWT session tokens
 * which the convex() plugin needs to authenticate Convex queries.
 */
export function createAuthOptions(ctx?: GenericCtx<DataModel>): BetterAuthOptions {
  const options: Record<string, any> = {
    secret: process.env.BETTER_AUTH_SECRET || "dev-secret-placeholder",
    baseURL: process.env.CONVEX_SITE_URL || "http://localhost:3210",
    basePath: "/api/auth",
    trustedOrigins: getTrustedOrigins,
    database: ctx ? authComponent.adapter(ctx) : (undefined as any),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }: { user: any; url: string }) => {
        try {
          const emailUrl = process.env.SHIPPER_EMAIL_URL;
          const emailToken = process.env.SHIPPER_EMAIL_TOKEN;
          if (!emailUrl || !emailToken) {
            console.error("Email not configured: SHIPPER_EMAIL_URL and SHIPPER_EMAIL_TOKEN must be set");
            return;
          }
          const response = await fetch(emailUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shipper-Token": emailToken,
            },
            body: JSON.stringify({
              to: user.email,
              templateSlug: "password-reset",
              templateData: {
                name: user.name || user.email.split("@")[0],
                appName: "Krickora",
                resetUrl: url,
              },
            }),
          });
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            console.error("Password reset email failed:", err?.error?.message || response.status);
          } else {
            const data = await response.json();
            if (data.skipped) console.warn("Password reset email skipped:", data.reason);
          }
        } catch (e) {
          console.error("Failed to send password reset email:", e);
        }
      },
      sendVerificationEmail: async ({ user, url }: { user: any; url: string }) => {
        try {
          const emailUrl = process.env.SHIPPER_EMAIL_URL;
          const emailToken = process.env.SHIPPER_EMAIL_TOKEN;
          if (!emailUrl || !emailToken) {
            console.error("Email not configured: SHIPPER_EMAIL_URL and SHIPPER_EMAIL_TOKEN must be set");
            return;
          }
          const response = await fetch(emailUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shipper-Token": emailToken,
            },
            body: JSON.stringify({
              to: user.email,
              templateSlug: "email-verification",
              templateData: {
                name: user.name || user.email.split("@")[0],
                appName: "Krickora",
                verificationUrl: url,
              },
            }),
          });
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            console.error("Verification email failed:", err?.error?.message || response.status);
          } else {
            const data = await response.json();
            if (data.skipped) console.warn("Verification email skipped:", data.reason);
          }
        } catch (e) {
          console.error("Failed to send verification email:", e);
        }
      },
    },
    advanced: {
      generateJWTSessionToken: true,
      cookiePrefix: "better-auth",
      crossSubDomainCookies: {
        enabled: true,
      },
      // ── Cross-domain cookie attributes (MANDATORY) ─────────────────
      // Applied at the options level so BOTH createAuth and adapter paths get them.
      defaultCookieAttributes: {
        sameSite: "none" as const,
        secure: true,
        path: "/",
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5 minutes
      },
    },
    user: {
      additionalFields: {
        name: {
          type: "string" as const,
          required: false,
        },
        role: {
          type: "string" as const,
          required: false,
          defaultValue: "user",
        },
        banned: {
          type: "boolean" as const,
          required: false,
          defaultValue: false,
        },
        banReason: {
          type: "string" as const,
          required: false,
        },
        banExpires: {
          type: "number" as const,
          required: false,
        },
      },
    },
    plugins: [
      buildConvexPlugin(),
      admin({
        adminRoles: ["admin"],
      }),
    ],
  };

  return options as BetterAuthOptions;
}

/**
 * Create Better Auth instance (called per-request in http actions).
 *
 * Adds databaseHooks to auto-create a customer record on signup.
 * Cookie options are already set in createAuthOptions.advanced.defaultCookieAttributes.
 */
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const options = createAuthOptions(ctx);

  // ── Database hooks: auto-create customer on signup ───────────────────
  // This prevents the "No customer found" error after a fresh signup.
  // The hook fires AFTER the Better Auth user record is created in Convex.
  (options as any).databaseHooks = {
    user: {
      create: {
        before: async (user: any) => {
          try {
            const runQuery = (ctx as any).runQuery;
            if (!runQuery) {
              console.warn("Registration lock check: ctx.runQuery unavailable");
              return;
            }
            const locked = await runQuery(components.betterAuth.adapter.findOne, {
              model: "siteSettings",
              where: [{ field: "key", value: "global" }],
            }).catch(() => null);
            // Fallback: query siteSettings directly via internal API
            let isLocked = false;
            try {
              const { internal } = await import("./_generated/api");
              const settings = await runQuery((internal as any).registrationLock?.isRegistrationLockedInternal).catch(() => null);
              if (typeof settings === "boolean") isLocked = settings;
            } catch {}
            if (!isLocked && locked && (locked as any).registrationLocked) {
              isLocked = true;
            }
            if (isLocked) {
              const normalizedEmail = (user.email || "").toLowerCase().trim();
              let existingCustomer = null;
              if (normalizedEmail) {
                try {
                  const { internal } = await import("./_generated/api");
                  existingCustomer = await runQuery((internal as any).registrationLock?.findCustomerByEmailInternal, { email: normalizedEmail }).catch(() => null);
                } catch {}
              }
              if (!existingCustomer) {
                throw new Error("Registration is currently disabled. Please contact the administrator to create an account.");
              }
            }
          } catch (e: any) {
            if (e?.message?.includes("Registration is currently disabled")) throw e;
            console.error("Registration lock check failed:", e);
          }
        },
        after: async (user: any) => {
          try {
            const db = (ctx as any).db;
            if (!db) return;
            const normalizedEmail = (user.email || "").toLowerCase().trim();
            if (!normalizedEmail) return;
            const existing = await db
              .query("customers")
              .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
              .first();
            if (!existing) {
              await db.insert("customers", {
                name: user.name || normalizedEmail.split("@")[0] || "New User",
                email: normalizedEmail,
                role: "customer",
                creditBalance: 0,
                createdAt: new Date().toISOString(),
              });
            }
          } catch (e) {
            console.error("Failed to auto-create customer record:", e);
          }
        },
      },
    },
  };

  // ── FORCE cookie options at the betterAuth() call level ────────────
  // This is the FINAL override — ensures sameSite:none + secure:true
  // regardless of what defaultCookieAttributes does internally.
  (options as any).advanced = {
    ...(options as any).advanced,
    cookiePrefix: "better-auth",
    crossSubDomainCookies: { enabled: true },
    defaultCookieAttributes: {
      sameSite: "none" as const,
      secure: true,
      path: "/",
    },
  };

  return betterAuth(options);
};

// ============================================================================
// USER TYPE
// ============================================================================

interface BetterAuthUser {
  _id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  emailVerified?: boolean;
  createdAt: number;
  updatedAt: number;
  role?: string;
  banned?: boolean;
  banReason?: string;
  banExpires?: number;
}

// ============================================================================
// USER QUERIES
// ============================================================================

/**
 * Get the current authenticated user.
 * Returns null if not authenticated — NEVER throws.
 */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    try {
      const user = (await authComponent.getAuthUser(
        ctx
      )) as BetterAuthUser | null;
      if (!user) return null;

      return {
        id: user._id,
        _id: user._id,
        email: user.email,
        name: user.name ?? null,
        image: user.image ?? null,
        emailVerified: user.emailVerified ?? false,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        role: (user as any).role ?? "user",
      };
    } catch {
      return null;
    }
  },
});

/**
 * Get user by email address
 */
export const getUserByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    try {
      const user = (await ctx.runQuery(
        components.betterAuth.adapter.findOne,
        {
          model: "user",
          where: [{ field: "email", value: email }],
        }
      )) as BetterAuthUser | null;
      if (!user) return null;

      return {
        id: user._id,
        email: user.email,
        name: user.name ?? null,
        image: user.image ?? null,
        createdAt: user.createdAt,
      };
    } catch {
      return null;
    }
  },
});

/**
 * List all users (for admin dashboard)
 */
export const listAllUsers = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 100 }) => {
    // Admin gate: return empty for non-admins (queries must not throw)
    try {
      const caller = await authComponent.getAuthUser(ctx);
      if (!caller || (caller as any).role !== "admin") return [];
    } catch { return []; }
    try {
      const result = await ctx.runQuery(
        components.betterAuth.adapter.findMany,
        {
          model: "user",
          sortBy: {
            field: "createdAt",
            direction: "desc",
          },
          paginationOpts: { numItems: limit, cursor: null },
        }
      );

      return result.page.map((user: any) => ({
        id: user._id,
        email: user.email,
        name: user.name ?? null,
        image: user.image ?? null,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        role: user.role ?? "user",
        banned: user.banned ?? false,
      }));
    } catch {
      return [];
    }
  },
});

// ============================================================================
// ADMIN MUTATIONS
// ============================================================================

/**
 * Set user role (admin, coach, user)
 */
export const setUserRole = mutation({
  args: { userId: v.string(), role: v.string() },
  handler: async (ctx, { userId, role }) => {
    await requireAdmin(ctx);
    try {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "user",
          where: [{ field: "_id", value: userId }],
          update: { role } as any,
        },
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message ?? "Failed to update role" };
    }
  },
});

/**
 * Delete a user and all their associated data
 */
export const deleteUser = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    await requireAdmin(ctx);
    const sessions = await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: "session",
        where: [{ field: "userId", value: userId }],
        paginationOpts: { numItems: 100, cursor: null },
      }
    );

    for (const session of sessions.page) {
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: {
          model: "session",
          where: [{ field: "_id", value: session._id }],
        },
      });
    }

    const accounts = await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: "account",
        where: [{ field: "userId", value: userId }],
        paginationOpts: { numItems: 100, cursor: null },
      }
    );

    for (const account of accounts.page) {
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: {
          model: "account",
          where: [{ field: "_id", value: account._id }],
        },
      });
    }

    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: {
        model: "user",
        where: [{ field: "_id", value: userId }],
      },
    });

    return { success: true };
  },
});

// ============================================================================
// ENSURE CUSTOMER EXISTS — safety net mutation
// ============================================================================

/**
 * Ensures a customer record exists for the given email.
 * Called from the frontend after sign-in/sign-up as a safety net
 * in case the databaseHook didn't fire (e.g. race condition, error).
 * This prevents the "No customer found" crash.
 */
export const ensureCustomerExists = mutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.toLowerCase().trim();
    if (!normalizedEmail) return null;

    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();

    if (existing) return existing._id;

    const id = await ctx.db.insert("customers", {
      name: args.name || normalizedEmail.split("@")[0] || "New User",
      email: normalizedEmail,
      role: "customer",
      creditBalance: 0,
      createdAt: new Date().toISOString(),
    });
    return id;
  },
});
