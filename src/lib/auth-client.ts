import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

const convexSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL;

if (!convexSiteUrl && typeof window !== "undefined") {
  console.warn(
    "VITE_CONVEX_SITE_URL is not set. Auth will not work. " +
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
  baseURL: convexSiteUrl || "https://adventurous-chickadee-53.convex.site",
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
    const result = await authClient.signUp.email({
      email,
      password,
      name: name || email.split("@")[0],
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
    const baseURL = convexSiteUrl || "https://adventurous-chickadee-53.convex.site";
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

export async function signOutUser() {
  try {
    await authClient.signOut({
      fetchOptions: fetchOpts(),
    });
    setStoredToken(null);
    return { success: true };
  } catch (error: any) {
    // Even if signOut fails server-side, clear the local token so the user is effectively logged out
    setStoredToken(null);
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
