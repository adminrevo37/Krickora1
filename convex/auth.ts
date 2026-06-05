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
import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import authSchema from "./betterAuth/schema";
import authConfig from "./auth.config";
import { sendTemplateEmail } from "./lib/email";
import { checkRateLimit } from "./lib/rateLimit";
import { composeName, splitName } from "./lib/names";
import { validateLocationIfProvided, normalizePostcode, normalizeSuburb } from "./lib/locations";
import { normalizeAuMobile } from "./lib/phone";
import { requireAdmin, requireAdminUnlocked, getCallerContext, writeRoleAudit } from "./lib/adminGuard";

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

// Static trusted origins for CORS.
// SEC Phase 4 (2026-06-03): PINNED to the production frontend + localhost dev.
// Dropped the stale Shipper origin (krickora.shipper.now), the old Shipper Convex
// deployment (adventurous-chickadee-53), and the blanket *.vercel.app / *.shipper.now
// / *.w.modal.host wildcards that previously let ANY such deployment make
// credentialed auth calls. cricketrevolution.au is pre-listed for the future
// custom domain (harmless until it points at Vercel).
const staticOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:8081",
  "https://krickora-prod.vercel.app",
  "https://cricketrevolution.au",
  "https://www.cricketrevolution.au",
];

/**
 * Get trusted origins array for Better Auth CORS.
 * PINNED allowlist only — no dynamic per-request origin trust. SITE_URL (the
 * deployed frontend origin) is included so a domain change needs only an env var.
 */
function getTrustedOrigins(_request?: Request): string[] {
  const origins = [...staticOrigins];
  if (siteUrl) origins.push(siteUrl);
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
  // SEC Phase 4 (2026-06-03): a throw-if-unset guard on BETTER_AUTH_SECRET was
  // attempted but is INFEASIBLE — Better Auth instantiates auth (this options
  // factory) during Convex push ANALYSIS, where env vars are unavailable, so any
  // throw on the secret path fails every deploy. BETTER_AUTH_SECRET is therefore
  // a DEPLOY-TIME INVARIANT: it is confirmed set on prod (artful-boar-748) and
  // must never be unset (verify with `npx convex env get BETTER_AUTH_SECRET`).
  // The placeholder below is only ever used by local `bun dev`.
  const options: Record<string, any> = {
    secret: process.env.BETTER_AUTH_SECRET || "dev-secret-placeholder",
    baseURL: process.env.CONVEX_SITE_URL || "http://localhost:3210",
    basePath: "/api/auth",
    trustedOrigins: getTrustedOrigins,
    database: ctx ? authComponent.adapter(ctx) : (undefined as any),
    emailAndPassword: {
      enabled: true,
      // Sign-in is NOT blocked on verification (users can browse straight away);
      // the verified-email requirement is enforced only at the FIRST booking
      // (mutations.createBooking, SEC decision #4). The verification email itself
      // is configured under the top-level `emailVerification` key below — Better
      // Auth only sends on sign-up / honours the send-verification endpoint when
      // that block exists. Without it, NO verification email is ever sent and the
      // booking gate becomes unsatisfiable for real customers.
      requireEmailVerification: false,
      // SEC decision #7: NIST-aligned — length over forced complexity.
      minPasswordLength: 10,
      maxPasswordLength: 128,
      sendResetPassword: async ({ user, url }: { user: any; url: string }) => {
        // NI-5 / S-1: throttle reset emails per address (inbox-bomb protection).
        // Over-limit → silently skip the send (response to the caller is unchanged,
        // so this doesn't leak which addresses exist). Fails open on any error.
        try {
          const runMutation = (ctx as any)?.runMutation;
          if (runMutation) {
            const { internal } = await import("./_generated/api");
            const allowed = await runMutation(internal.auth.checkAuthRateLimitInternal, {
              action: "auth-reset",
              email: user.email,
              max: 3,
              windowMs: 15 * 60 * 1000,
            });
            if (!allowed) {
              console.warn("Password-reset throttled for", user.email);
              return;
            }
          }
        } catch (e) {
          console.error("Reset rate-limit check failed (allowing send):", e);
        }
        try {
          const result = await sendTemplateEmail("password-reset", user.email, {
            name: user.name || user.email.split("@")[0],
            appName: "Krickora",
            resetUrl: url,
          });
          if (!result.success) console.warn("Password reset email not sent:", result.reason);
        } catch (e) {
          console.error("Failed to send password reset email:", e);
        }
      },
    },
    // Enables the verification feature: auto-send on sign-up AND the
    // /api/auth/send-verification-email endpoint (resend). Previously
    // sendVerificationEmail lived under emailAndPassword, which Better Auth does
    // not treat as "verification enabled" — so sign-up sent nothing and the
    // resend endpoint returned VERIFICATION_EMAIL_NOT_ENABLED.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      // Token validity — 24h (better-auth defaults to 1h, which expires before
      // many users get to their inbox → the link then errors).
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }: { user: any; url: string }) => {
        try {
          const result = await sendTemplateEmail("email-verification", user.email, {
            name: user.name || user.email.split("@")[0],
            appName: "Krickora",
            verificationUrl: url,
          });
          if (!result.success) console.warn("Verification email not sent:", result.reason);
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
          // NI-5 / S-1: throttle sign-ups per email address. Over-limit → abort
          // (Better Auth surfaces the thrown message to the client, same as the
          // registration-lock below). Fails open on any limiter error.
          try {
            const runMutation = (ctx as any).runMutation;
            if (runMutation) {
              const { internal } = await import("./_generated/api");
              const allowed = await runMutation((internal as any).auth.checkAuthRateLimitInternal, {
                action: "auth-signup",
                email: user.email,
                max: 5,
                windowMs: 15 * 60 * 1000,
              });
              if (allowed === false) {
                throw new Error("Too many sign-up attempts. Please try again in a few minutes.");
              }
            }
          } catch (e: any) {
            if (e?.message?.includes("Too many sign-up attempts")) throw e;
            console.error("Sign-up rate-limit check failed (allowing):", e);
          }
          try {
            const runQuery = (ctx as any).runQuery;
            if (!runQuery) {
              console.warn("Registration lock check: ctx.runQuery unavailable");
              return;
            }
            let isLocked = false;
            try {
              const { internal } = await import("./_generated/api");
              const settings = await runQuery((internal as any).registrationLock?.isRegistrationLockedInternal).catch(() => null);
              if (typeof settings === "boolean") isLocked = settings;
            } catch {}
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
            // HTTP actions don't have ctx.db — must use ctx.runMutation instead
            const runMutation = (ctx as any).runMutation;
            if (!runMutation) {
              console.warn("Cannot create customer record: runMutation unavailable");
              return;
            }
            const normalizedEmail = (user.email || "").toLowerCase().trim();
            if (!normalizedEmail) return;
            const { internal } = await import("./_generated/api");
            await runMutation(internal.auth.ensureCustomerExistsInternal, {
              email: normalizedEmail,
              name: user.name || undefined,
            });
          } catch (e) {
            console.error("Failed to auto-create customer record:", e);
          }
        },
      },
    },
  };

  // ── SEC Phase 4: auth-path rate limiting (sign-in / sign-up / reset) ──
  // M4/M5: sign-in was completely unthrottled (online password brute force).
  // A single request `before` hook covers all three sensitive auth endpoints
  // with email AND IP buckets, reusing the live-proven fixed-window table
  // limiter (convex/lib/rateLimit.ts, fails open) via an internal mutation —
  // NO Better Auth schema / native-rateLimit change (avoids the 422-class risk).
  //
  // Bucket layout (windows = 15 min):
  //   /sign-in/email    email 5  + IP 30   (Strict, Inspector 2026-06-03)
  //   /sign-up/email    IP 10   (email bucket already enforced in databaseHook below)
  //   /forget-password  IP 10   (email bucket already enforced in sendResetPassword)
  // Over-limit → APIError 429 (the client already renders error.message). Fails
  // open on any limiter/hook error so a bug can never lock out legitimate auth.
  const convexCtx = ctx;
  (options as any).hooks = {
    before: createAuthMiddleware(async (mctx: any) => {
      try {
        const path: string = mctx?.path ?? "";
        let cfg:
          | { action: string; emailMax?: number; ipMax: number; message: string }
          | null = null;
        if (path === "/sign-in/email") {
          cfg = {
            action: "auth-signin",
            emailMax: 5,
            ipMax: 30,
            message: "Too many sign-in attempts. Please try again in a few minutes.",
          };
        } else if (path === "/sign-up/email") {
          cfg = {
            action: "auth-signup",
            ipMax: 10,
            message: "Too many sign-up attempts. Please try again in a few minutes.",
          };
        } else if (path === "/request-password-reset" || path === "/forget-password") {
          // Better Auth 1.5.x canonical reset path is /request-password-reset;
          // /forget-password is the legacy alias (404s here) — match both.
          cfg = {
            action: "auth-reset",
            ipMax: 10,
            message: "Too many password-reset requests. Please try again in a few minutes.",
          };
        }
        if (!cfg) return; // fast no-op for every other endpoint (get-session etc.)

        const runMutation = (convexCtx as any)?.runMutation;
        if (!runMutation) return; // no db context → fail open

        const email = cfg.emailMax ? String(mctx?.body?.email ?? "") : "";
        const fwd =
          mctx?.headers?.get?.("x-forwarded-for") ||
          mctx?.headers?.get?.("x-real-ip") ||
          "";
        const ip = String(fwd).split(",")[0].trim();

        const { internal } = await import("./_generated/api");
        const allowed = await runMutation(
          (internal as any).auth.checkAuthRateLimitInternal,
          {
            action: cfg.action,
            ...(cfg.emailMax && email ? { email, max: cfg.emailMax } : {}),
            ...(ip ? { ip, ipMax: cfg.ipMax } : {}),
            windowMs: 15 * 60 * 1000,
          }
        );
        if (allowed === false) {
          throw new APIError("TOO_MANY_REQUESTS", { message: cfg.message });
        }
      } catch (e: any) {
        if (e instanceof APIError) throw e; // the throttle rejection — propagate
        console.error("Auth throttle hook error (allowing):", e); // fail open
      }
    }),
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

      // SPEC_AUTH_LOADING_SMOOTHING §3c — return the caller's customers row nested
      // so the client gets identity + profile (postcode/role/phone/credit/...) in ONE
      // Convex query instead of the old getCurrentUser → getCustomerByEmail waterfall.
      // This stays reactive to customers edits (the query reads the customers table).
      // Guarded separately so a customers-lookup failure can never null out identity.
      let customer: any = null;
      try {
        const normalized = (user.email ?? "").toLowerCase().trim();
        if (normalized) {
          customer = await ctx.db
            .query("customers")
            .withIndex("by_email", (q: any) => q.eq("email", normalized))
            .first();
        }
      } catch {
        customer = null;
      }

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
        customer,
      };
    } catch {
      return null;
    }
  },
});

/**
 * Get user by email address — admin only (prevents account enumeration,
 * SEC decision #5). Returns null for non-admins.
 */
export const getUserByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    try {
      const caller = await getCallerContext(ctx);
      if (!caller.isAdmin) return null;
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
    // Admin gate: return empty for non-admins (queries must not throw).
    // LOW (SEC audit 2026-06-03): use the SSOT admin resolver (getCallerContext
    // → customers.role authoritative) instead of the raw Better-Auth user.role,
    // which can drift from the customers table (M-1/S-2).
    try {
      const caller = await getCallerContext(ctx);
      if (!caller.isAdmin) return [];
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
    const adminUser = await requireAdminUnlocked(ctx);
    try {
      // 1) Update the Better Auth user record
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "user",
          where: [{ field: "_id", value: userId }],
          update: { role } as any,
        },
      });

      // 2) SEC #7 dual-role sync: the app reads customers.role, which can drift
      // from the Better Auth user.role. Keep both in sync. Resolve the email
      // from the auth user, then patch the matching customers record.
      const authUser: any = await ctx.runQuery(
        components.betterAuth.adapter.findOne,
        { model: "user", where: [{ field: "_id", value: userId }] }
      );
      const targetEmail = authUser?.email?.toLowerCase?.().trim?.() ?? "";
      if (targetEmail) {
        const customer = await ctx.db
          .query("customers")
          .withIndex("by_email", (q: any) => q.eq("email", targetEmail))
          .first();
        const oldRole = customer?.role;
        if (customer && customer.role !== role) {
          await ctx.db.patch(customer._id, { role });
        }
        await writeRoleAudit(ctx, {
          targetEmail,
          field: "role",
          oldValue: oldRole,
          newValue: role,
          changedByEmail: (adminUser as any).email ?? "",
        });
      }
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
// Shared creation logic (no auth — callers must enforce their own guard).
async function ensureCustomerImpl(
  ctx: any,
  args: { email: string; name?: string; firstName?: string; lastName?: string; postcode?: string; suburb?: string; phone?: string; referralSource?: string; referralSourceOther?: string }
): Promise<any | null> {
  const normalizedEmail = args.email.toLowerCase().trim();
  if (!normalizedEmail) return null;

  // SPEC_SIGNUP_UPDATES_2026-06 G5 — "How did you hear about us?" arrives on the
  // signup follow-up call (the databaseHook path has none). Stored when supplied;
  // the free-text only when the chosen option is "Other".
  const givenReferral = (args.referralSource ?? "").trim();
  const givenReferralOther = (args.referralSourceOther ?? "").trim();
  const hasReferral = Boolean(givenReferral);

  // SPEC_NAME_SPLIT — explicit first/last passed by the signup follow-up call.
  const givenFirst = (args.firstName ?? "").trim();
  const givenLast = (args.lastName ?? "").trim();
  const hasExplicitName = Boolean(givenFirst || givenLast);

  // SPEC_PROFILE_POSTCODE_SUBURB — postcode/suburb arrive on the signup follow-up call
  // (the databaseHook path has none). Validate only when supplied (throws ConvexError
  // on an invalid WA pair); the login hard-block gate backstops any account left blank.
  validateLocationIfProvided(args.postcode, args.suburb);
  const givenPostcode = normalizePostcode(args.postcode);
  const givenSuburb = normalizeSuburb(args.suburb);
  const hasLocation = Boolean(givenPostcode && givenSuburb);

  // Mobile: normalise to E.164 (+614xxxxxxxx) for storage. Stored when valid;
  // an invalid/blank value is simply not written (the signup form is the gate).
  const givenPhone = normalizeAuMobile(args.phone);
  const hasPhone = Boolean(givenPhone);

  const existing = await ctx.db
    .query("customers")
    .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
    .first();

  if (existing) {
    // The databaseHook creates the row first (name only, best-effort split). The
    // frontend then re-calls with the PRECISE two fields — patch them in so a
    // multi-word surname is captured exactly (last writer wins for own record).
    if (hasExplicitName || hasLocation || hasPhone || hasReferral) {
      await ctx.db.patch(existing._id, {
        ...(hasExplicitName
          ? {
              firstName: givenFirst,
              lastName: givenLast,
              name: composeName(givenFirst, givenLast) || existing.name,
            }
          : {}),
        ...(hasLocation ? { postcode: givenPostcode, suburb: givenSuburb } : {}),
        ...(hasPhone ? { phone: givenPhone } : {}),
        ...(hasReferral
          ? {
              referralSource: givenReferral,
              referralSourceOther:
                givenReferral === "Other" ? givenReferralOther || undefined : undefined,
            }
          : {}),
      });
    }
    return existing._id;
  }

  const now = new Date().toISOString();
  // Derive first/last: prefer the explicit fields, else best-effort split of the
  // composed name (the databaseHook path only has `name`).
  const fallbackName = args.name || normalizedEmail.split("@")[0] || "New User";
  const split = hasExplicitName
    ? { firstName: givenFirst, lastName: givenLast }
    : splitName(fallbackName);
  const displayName = composeName(split.firstName, split.lastName) || fallbackName;
  const customerId = await ctx.db.insert("customers", {
    name: displayName,
    firstName: split.firstName,
    lastName: split.lastName,
    ...(hasLocation ? { postcode: givenPostcode, suburb: givenSuburb } : {}),
    ...(hasPhone ? { phone: givenPhone } : {}),
    ...(hasReferral
      ? {
          referralSource: givenReferral,
          referralSourceOther:
            givenReferral === "Other" ? givenReferralOther || undefined : undefined,
        }
      : {}),
    email: normalizedEmail,
    role: "customer",
    creditBalance: 0,
    // SPEC_PUSH_NOTIFICATIONS_V2 §3.4 — the 22-min session-reminder PUSH replaces
    // the reminder email, so new accounts start with the reminder email OFF.
    emailPrefs: [{ slug: "booking-reminder", enabled: false }],
    createdAt: now,
  });

  // SPEC_PARENT_ATHLETE_MODEL: new accounts get a self-athlete (the account
  // holder training themselves) so the model is uniform for adults. It stays
  // invisible to coaches unless a coach is assigned.
  await ctx.db.insert("athletes", {
    accountCustomerId: customerId,
    name: displayName,
    assignedCoachIds: [],
    isSelf: true,
    createdAt: now,
  });

  // Consume any pending athlete-invite (a coach invited this parent before they
  // had an account): create the named child athlete + assign the inviting coach.
  try {
    const invite = await ctx.db
      .query("coachInvites")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (invite && !invite.used && invite.kind === "athlete" && invite.childName) {
      await ctx.db.insert("athletes", {
        accountCustomerId: customerId,
        name: invite.childName,
        assignedCoachIds: invite.coachId ? [invite.coachId] : [],
        isSelf: false,
        createdAt: now,
      });
      await ctx.db.patch(invite._id, { used: true, usedAt: now });
    }
  } catch (e) {
    console.error("Failed to consume athlete invite on registration:", e);
  }

  return customerId;
}

/**
 * Trusted server-side variant — called from the signup databaseHook (no user
 * identity available at that point). NOT client-callable.
 */
export const ensureCustomerExistsInternal = internalMutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    postcode: v.optional(v.string()),
    suburb: v.optional(v.string()),
    phone: v.optional(v.string()),
    referralSource: v.optional(v.string()),
    referralSourceOther: v.optional(v.string()),
  },
  handler: async (ctx, args) => ensureCustomerImpl(ctx, args),
});

/**
 * NI-5 / S-1 — auth-path rate limiting (email-keyed). The Better Auth callbacks
 * (databaseHooks.user.create.before, sendResetPassword) run in an HTTP-action
 * context with NO ctx.db, so they call THIS internal mutation (which has db) via
 * ctx.runMutation. Reuses the existing fixed-window table limiter (fails open on
 * error, so it can never hard-break sign-up / reset). NO Better Auth schema change.
 * Returns true if the request is allowed (and consumes a slot), false if throttled.
 */
export const checkAuthRateLimitInternal = internalMutation({
  args: {
    action: v.string(),          // "auth-signup" | "auth-reset" | "auth-signin"
    email: v.optional(v.string()),
    max: v.optional(v.number()),  // email-bucket limit
    ip: v.optional(v.string()),
    ipMax: v.optional(v.number()), // IP-bucket limit (SEC Phase 4 / M5)
    windowMs: v.number(),
  },
  handler: async (ctx, args) => {
    let allowed = true;

    // Email bucket — key `${action}:${email}` (backward-compatible with the
    // existing sign-up / reset callers that pass only email + max).
    const email = (args.email || "").toLowerCase().trim();
    if (email && args.max) {
      const ok = await checkRateLimit(ctx, {
        action: args.action,
        identifier: email,
        max: args.max,
        windowMs: args.windowMs,
      });
      if (!ok) allowed = false;
    }

    // IP bucket — separate key namespace `${action}-ip:${ip}` so it never
    // collides with the email bucket. Closes the email-rotation bypass (M5).
    const ip = (args.ip || "").trim();
    if (ip && args.ipMax) {
      const ok = await checkRateLimit(ctx, {
        action: `${args.action}-ip`,
        identifier: ip,
        max: args.ipMax,
        windowMs: args.windowMs,
      });
      if (!ok) allowed = false;
    }

    return allowed;
  },
});

/**
 * Public safety-net called by the frontend after sign-in/sign-up.
 * SEC: must be authenticated, and may only ensure the caller's OWN record
 * (or admin for any). Prevents arbitrary record creation / enumeration.
 */
export const ensureCustomerExists = mutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    postcode: v.optional(v.string()),
    suburb: v.optional(v.string()),
    phone: v.optional(v.string()),
    referralSource: v.optional(v.string()),
    referralSourceOther: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) throw new Error("Not authorized");
    const normalizedEmail = args.email.toLowerCase().trim();
    if (!caller.isAdmin && caller.email !== normalizedEmail) {
      throw new Error("Not authorized");
    }
    return ensureCustomerImpl(ctx, args);
  },
});
