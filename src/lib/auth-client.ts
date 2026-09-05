import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

const convexSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL;

// L5 (SECURITY review 2026-09-05b): there is NO fallback deployment. This file
// used to default to the retired Shipper-era `adventurous-chickadee-53.convex.site`
// when the env var was missing, so a mis-built bundle would silently POST
// credentials (sign-in, password reset) to a deployment we no longer run. A
// missing VITE_CONVEX_SITE_URL is now a build/config error that fails loudly on
// the first auth call instead of a quiet redirect of secrets.
function requireConvexSiteUrl(): string {
  if (!convexSiteUrl) {
    throw new Error(
      "VITE_CONVEX_SITE_URL is not set — refusing to send credentials anywhere. Set it in .env.local / Vercel env to the Convex site URL (https://<deployment>.convex.site)."
    );
  }
  return convexSiteUrl;
}

if (!convexSiteUrl && typeof window !== "undefined") {
  console.error(
    "VITE_CONVEX_SITE_URL is not set. Auth will not work — every auth call will throw. " +
    "Set it in .env.local to your Convex site URL (e.g. https://xxx.convex.site)"
  );
}

// ============================================================================
// BEARER TOKEN AUTH (cookie-free)
// ----------------------------------------------------------------------------
// We store the Better Auth session token in localStorage and send it as
// `Authorization: Bearer <token>` on every auth request. This works even when
// the browser blocks third-party cookies (mobile Safari ITP, in-app browsers,
// Instagram/Facebook webviews, incognito mode, etc.).
//
// Better Auth automatically returns the session token in the `set-auth-token`
// response header after sign-in/sign-up. We capture it and persist it.
// ============================================================================

const TOKEN_KEY = "krickora.auth.token";

function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setStoredToken(token: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

// SPEC_AUTH_SESSION_PERSISTENCE_2026-08 F3 — stale-token hygiene. Called by
// useAuth when the server CLEANLY reports no session (token expired/revoked)
// so a dead bearer token doesn't linger in localStorage forever. Must ONLY be
// called on the authenticated→logged-out TRANSITION — never while a sign-in
// is in flight (the just-captured token would be destroyed before the session
// atom refetches, breaking login on cookie-less iOS).
// 2026-08-13 logout-regression telemetry: lets the definitive-logout event
// distinguish "token present but server-rejected/expired" (session lifetime)
// from "token missing" (iOS storage eviction / never stored).
export function hasStoredToken(): boolean {
  return getStoredToken() != null;
}

export function clearStoredToken() {
  setStoredToken(null);
}

// ============================================================================
// SESSION HINT (SPEC_AUTH_LOADING_SMOOTHING §3b)
// ----------------------------------------------------------------------------
// A tiny localStorage flag that records "this browser had an authenticated
// session last time". useAuth initialises its wasAuthenticatedRef from it so a
// hard refresh shows the loading spinner (not the signed-out header) while the
// Better Auth token + Convex identity re-validate. Cleared on definitive
// sign-out / no-session so a genuinely logged-out visitor never sees a spinner.
// ============================================================================

const HAD_SESSION_KEY = "krickora.hadSession";

export function readHadSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HAD_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeHadSession(had: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (had) window.localStorage.setItem(HAD_SESSION_KEY, "1");
    else window.localStorage.removeItem(HAD_SESSION_KEY);
  } catch {}
}

// ============================================================================
// USER CACHE (SPEC_AUTH_LOADING_SMOOTHING §3e — optimistic auth hydration)
// ----------------------------------------------------------------------------
// A small NON-SECRET snapshot of the signed-in user, persisted so a cold PWA
// launch can paint the logged-in app INSTANTLY from cache instead of showing a
// multi-second spinner while the Better Auth get-session HTTP + Convex WS auth
// round-trips resolve. useAuth seeds a provisional `user` from this when the
// `hadSession` hint is set and the authoritative getCurrentUser hasn't landed
// yet, then reconciles the moment it does.
//
// SECURITY: this is cosmetic only. The bearer token (above) is the sole secret
// and already lives in localStorage. The cached `role` cannot escalate anything
// — every privileged query/mutation is server-enforced (requireAdmin /
// getUserIdentity), and the postcode/email-verify GATES wait for the
// authoritative customers record, never this cache. A tampered cache yields at
// most a few seconds of empty cosmetic chrome that returns no data. Cleared on
// sign-out + definitive no-session. Never written while impersonating.
// ============================================================================

const USER_CACHE_KEY = "krickora.userCache";

export type CachedUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  postcode?: string;
  suburb?: string;
  emailVerified: boolean;
};

export function readUserCache(): CachedUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (u && typeof u.id === "string" && typeof u.email === "string" && typeof u.name === "string") {
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: typeof u.role === "string" ? u.role : "customer",
        postcode: typeof u.postcode === "string" ? u.postcode : undefined,
        suburb: typeof u.suburb === "string" ? u.suburb : undefined,
        emailVerified: u.emailVerified === true,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeUserCache(u: CachedUser) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USER_CACHE_KEY, JSON.stringify(u));
  } catch {}
}

export function clearUserCache() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(USER_CACHE_KEY);
  } catch {}
}

const credentialFetch: typeof globalThis.fetch = async (input, init) => {
  const existingHeaders = (init?.headers as Record<string, string>) || {};
  const token = getStoredToken();

  const mergedHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...existingHeaders,
  };
  if (token && !mergedHeaders["Authorization"] && !mergedHeaders["authorization"]) {
    mergedHeaders["Authorization"] = `Bearer ${token}`;
  }

  const mergedInit: RequestInit = {
    ...init,
    credentials: "include",
    mode: "cors" as RequestMode,
    headers: mergedHeaders,
  };

  const response = await globalThis.fetch(input, mergedInit);

  // Capture Better Auth session token from response header
  try {
    const newToken = response.headers.get("set-auth-token");
    if (newToken) {
      setStoredToken(newToken);
    }
  } catch {}

  return response;
};

export const authClient = createAuthClient({
  // L5: no fallback deployment — a missing env var throws here at module load
  // (white screen) rather than pointing sign-in at a retired deployment.
  baseURL: requireConvexSiteUrl(),
  basePath: "/api/auth",
  plugins: [convexClient()],
  fetchOptions: {
    credentials: "include" as RequestCredentials,
    customFetchImpl: credentialFetch,
    auth: {
      type: "Bearer",
      token: () => getStoredToken() ?? "",
    },
  },
});

export const AUTH_CONFIG = {
  emailEnabled: true,
  // Google sign-in is DISABLED until set up properly (SPEC_SECURITY_HARDENING #8):
  // requires a Google Cloud OAuth client, a published privacy-policy URL on the
  // consent screen, GOOGLE_CLIENT_ID/SECRET env vars, socialProviders.google in
  // auth.ts, and Better Auth account-linking. Was half-wired/broken before. Do
  // NOT re-enable until the backend provider + account-linking are deployed.
  googleEnabled: false,
  anonymousEnabled: false,
};

export const useSession = authClient.useSession;

const fetchOpts = () => ({
  credentials: "include" as RequestCredentials,
  customFetchImpl: credentialFetch,
  auth: {
    type: "Bearer" as const,
    token: () => getStoredToken() ?? "",
  },
});

export async function signInWithEmail(email: string, password: string) {
  try {
    const result = await authClient.signIn.email({
      email,
      password,
      fetchOptions: fetchOpts(),
    });
    if (result.error) {
      return { success: false, error: result.error, data: null };
    }
    // Extra safety: some Better Auth versions return the token in the body
    const token = (result.data as any)?.token;
    if (token) setStoredToken(token);
    return { success: true, data: result.data };
  } catch (error: any) {
    return { success: false, error: { message: error.message || "Sign in failed" }, data: null };
  }
}

export async function signUpWithEmail(email: string, password: string, name?: string) {
  try {
    // Absolute frontend callbackURL so the email-verification link redirects back
    // to the app after verifying (a bare "/" resolves to the convex.site backend
    // root, which has no page → the user lands on a "not found" screen).
    const callbackURL = typeof window !== "undefined" ? `${window.location.origin}/` : undefined;
    const result = await authClient.signUp.email({
      email,
      password,
      name: name || email.split("@")[0],
      callbackURL,
      fetchOptions: fetchOpts(),
    });
    if (result.error) {
      return { success: false, error: result.error, data: null };
    }
    const token = (result.data as any)?.token;
    if (token) setStoredToken(token);
    return { success: true, data: result.data };
  } catch (error: any) {
    return { success: false, error: { message: error.message || "Sign up failed" }, data: null };
  }
}

export async function signInWithGoogle() {
  try {
    await authClient.signIn.social({
      provider: "google",
      fetchOptions: fetchOpts(),
    });
    return { success: true };
  } catch (error: any) {
    return { success: false, error: { message: error.message || "Google sign-in failed" } };
  }
}

export async function signInAnonymously() {
  return { success: false, error: { message: "Anonymous sign-in is not enabled" } };
}

/**
 * Send a password reset email.
 */
export async function sendPasswordReset(email: string) {
  try {
    const redirectTo = typeof window !== "undefined"
      ? `${window.location.origin}/reset-password`
      : "/reset-password";
    const baseURL = requireConvexSiteUrl();
    // Better Auth 1.5.x exposes the reset-request endpoint at /request-password-reset.
    // The legacy /forget-password alias is NOT registered (404) — using it silently
    // broke customer "forgot password". (Pre-existing bug found during SEC Phase 4.)
    const response = await credentialFetch(`${baseURL}/api/auth/request-password-reset`, {
      method: "POST",
      body: JSON.stringify({ email, redirectTo }),
    });
    if (!response.ok) {
      let msg = "Failed to send reset email";
      try { const err = await response.json(); msg = err?.message || err?.error?.message || msg; } catch {}
      return { success: false, error: { message: msg } };
    }
    return { success: true };
  } catch (error: any) {
    return { success: false, error: { message: error?.message || "Failed to send reset email" } };
  }
}

/**
 * Complete a password reset — exchange the emailed token for a new password.
 * Better Auth 1.5.x: POST /api/auth/reset-password with { newPassword, token }.
 */
export async function resetPassword(token: string, newPassword: string) {
  try {
    const baseURL = requireConvexSiteUrl();
    const response = await credentialFetch(`${baseURL}/api/auth/reset-password`, {
      method: "POST",
      body: JSON.stringify({ newPassword, token }),
    });
    if (!response.ok) {
      let msg = "Failed to reset password";
      try { const err = await response.json(); msg = err?.message || err?.error?.message || msg; } catch {}
      return { success: false, error: { message: msg } };
    }
    return { success: true };
  } catch (error: any) {
    return { success: false, error: { message: error?.message || "Failed to reset password" } };
  }
}

export async function refreshSession() {
  try {
    const session = await authClient.getSession({
      fetchOptions: fetchOpts(),
    });
    if (typeof window !== "undefined") {
      console.log("[auth-client] refreshSession result:", session?.data ? "session found" : "no session");
    }
    return { success: true, data: session?.data };
  } catch (err) {
    console.warn("[auth-client] refreshSession failed:", err);
    return { success: false };
  }
}

/**
 * SYNC-1 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13) — explicit-sign-out marker.
 *
 * `signOutUser` clears the bearer BEFORE the session atom nulls, so by the time
 * useAuth's logged-out transition runs, hasStoredToken() is already false and the
 * `auth_definitive_logout` telemetry would record every deliberate sign-out as
 * {hadToken:false} — i.e. as a storage EVICTION, the exact class the flag exists
 * to isolate. A user tapping Sign out is not a logout class worth measuring, so we
 * mark it here and suppress the event once.
 */
let _explicitSignOut = false;
export function markExplicitSignOut() {
  _explicitSignOut = true;
}
/** Reads AND clears the marker (one sign-out suppresses exactly one event). */
export function consumeExplicitSignOut(): boolean {
  const was = _explicitSignOut;
  _explicitSignOut = false;
  return was;
}

export async function signOutUser() {
  markExplicitSignOut();
  try {
    await authClient.signOut({
      fetchOptions: fetchOpts(),
    });
    setStoredToken(null);
    writeHadSession(false);
    clearUserCache();
    return { success: true };
  } catch (error: any) {
    // Even if signOut fails server-side, clear the local token so the user is effectively logged out
    setStoredToken(null);
    writeHadSession(false);
    clearUserCache();
    return { success: false, error: { message: error.message || "Sign out failed" } };
  }
}

// Sync sign-out across tabs
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === TOKEN_KEY && !e.newValue) {
      // Token was cleared in another tab — reload to update session state
      window.location.reload();
    }
  });
}
