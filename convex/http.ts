import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { stripeWebhook } from "./stripeWebhook";
import { internal } from "./_generated/api";
import { verifyUnsubscribeToken } from "./lib/unsubscribe";

const http = httpRouter();

// ── CORS + security headers for ALL responses ──────────────────────────
const SECURITY_HEADERS: Record<string, string> = {
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Cross-Origin-Embedder-Policy": "unsafe-none",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD",
  "Access-Control-Allow-Headers":
    "Content-Type, content-type, CONTENT-TYPE, " +
    "Authorization, authorization, " +
    "Accept, accept, " +
    "Origin, origin, " +
    "Referer, referer, " +
    "User-Agent, user-agent, " +
    "X-Requested-With, X-Better-Auth-Token, X-Convex-Client, " +
    "Cookie, Set-Cookie, " +
    "Cache-Control, Pragma, " +
    "baggage, sentry-trace, traceparent, tracestate, " +
    "*",
  "Access-Control-Expose-Headers":
    "Set-Cookie, Content-Type, Content-Length, X-Request-Id",
  "Access-Control-Max-Age": "86400",
};

// ── Allowed origins for CORS with credentials ─────────────────────────
// SITE_URL is the deployed frontend origin (e.g. https://krickora-prod.vercel.app
// or, later, https://cricketrevolution.au). Including it here keeps the preflight CORS in
// step with Better Auth's own trustedOrigins (which already honours SITE_URL).
// SEC Phase 4 (2026-06-03): PINNED credentialed-CORS allowlist. Dropped the
// stale Shipper origin, the old Shipper Convex deployment, and the
// *.shipper.now / *.w.modal.host / *.convex.* / *.vercel.app wildcards that
// previously let ANY such origin make credentialed requests. cricketrevolution.au
// is pre-listed for the future custom domain (harmless until it goes live).
const SITE_URL = process.env.SITE_URL || "";
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4173",
  "https://krickora-prod.vercel.app",
  "https://cricketrevolution.au",
  "https://www.cricketrevolution.au",
  ...(SITE_URL ? [SITE_URL] : []),
];

/**
 * Resolve the correct Access-Control-Allow-Origin for a request.
 * Must be a specific origin (not *) when credentials: true. Only echoes back an
 * origin on the pinned allowlist; otherwise falls back to the deployed frontend.
 */
function resolveOrigin(request?: Request): string {
  const origin = request?.headers.get("origin") || "";
  if (ALLOWED_ORIGINS.includes(origin) || (SITE_URL && origin === SITE_URL)) {
    return origin;
  }
  // Default to the real deployed frontend origin, NOT localhost.
  return SITE_URL || "https://krickora-prod.vercel.app";
}

// ── Register Better Auth routes with credentials-aware CORS ────────────
authComponent.registerRoutes(http, createAuth, {
  cors: {
    // SEC Phase 4: pinned to prod + localhost (was Shipper + old Convex deploy).
    allowedOrigins: [
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:4173",
      "https://krickora-prod.vercel.app",
      "https://cricketrevolution.au",
      "https://www.cricketrevolution.au",
      ...(SITE_URL ? [SITE_URL] : []),
    ],
    allowedHeaders: [
      "Content-Type", "content-type", "CONTENT-TYPE",
      "Authorization", "authorization",
      "Accept", "accept",
      "Origin", "origin",
      "Referer", "referer",
      "Cookie", "Set-Cookie",
      "X-Requested-With", "X-Better-Auth-Token", "X-Convex-Client",
      "Cache-Control", "Pragma",
      "baggage", "sentry-trace", "traceparent", "tracestate",
    ],
    exposedHeaders: ["Set-Cookie", "Content-Type", "Content-Length"],
  },
});

// ── Helper: build headers with dynamic origin ─────────────────────────
function corsHeaders(request?: Request): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    "Access-Control-Allow-Origin": resolveOrigin(request),
  };
}

// ── Health check ───────────────────────────────────────────────────────
http.route({
  path: "/.well-known/health",
  method: "GET",
  handler: httpAction(async (_, request) => {
    return new Response(JSON.stringify({ status: "ok", railway: "decommissioned" }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }),
});

// ── Catch-all OPTIONS preflight ────────────────────────────────────────
http.route({
  path: "/.well-known/cors",
  method: "OPTIONS",
  handler: httpAction(async (_, request) => {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }),
});

// ── Explicit OPTIONS handlers for auth endpoints ───────────────────────
const AUTH_PREFLIGHT_PATHS = [
  "/api/auth/get-session",
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "/api/auth/sign-out",
  // NOTE: /sign-in/social + /callback/google preflight routes removed — Google
  // sign-in is disabled (no provider configured). Restore these when Google is
  // set up (SPEC_SECURITY_HARDENING #8).
  "/api/auth/session",
  "/api/auth/csrf",
];

for (const path of AUTH_PREFLIGHT_PATHS) {
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async (_, request) => {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }),
  });
}

// ── Marketing unsubscribe (SPEC_ADMIN_BROADCAST §8, no auth) ─────────
// One-click unsubscribe link carried in promotional emails. Verifies the HMAC
// token (issued for that exact email) then sets receiveMarketing=false. Returns
// a small HTML confirmation page. Idempotent + safe to re-click.
http.route({
  path: "/unsubscribe",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const email = (url.searchParams.get("e") || "").toLowerCase().trim();
    const token = url.searchParams.get("t") || "";
    const ok = email && token && (await verifyUnsubscribeToken(email, token));
    let message: string;
    if (ok) {
      await ctx.runMutation(internal.pushNotifications.setReceiveMarketingByEmailInternal, {
        email,
        enabled: false,
      });
      message =
        "You've been unsubscribed from Cricket Revolution promotional emails. You'll still receive booking and account emails.";
    } else {
      message =
        "This unsubscribe link is invalid or has expired. You can manage email preferences in your profile.";
    }
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe — Cricket Revolution</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9;">
<div style="max-width:480px;margin:64px auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;text-align:center;">
<div style="font-size:22px;font-weight:800;color:#dc2626;margin-bottom:16px;">Cricket Revolution</div>
<p style="color:#1a1a1a;font-size:15px;line-height:1.6;">${message}</p>
</div></body></html>`;
    return new Response(html, {
      status: ok ? 200 : 400,
      headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders(request) },
    });
  }),
});

// ── SPEC_ANALYTICS_BUILD_2026-06 C2.4 — push delivery/click beacon (no auth) ──
// The service worker POSTs a tiny JSON body on the `push` (delivered) and
// `notificationclick` (clicked) events: { type, c?: category, tag?, pf?: platform }.
// Unauthenticated by design (the SW has no session); size-capped + only the coarse
// category/platform/tag are recorded — never PII. Mirrors trackEvent's hardening.
http.route({
  path: "/push/beacon",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const raw = await request.text();
      if (raw.length <= 2048) {
        const data = JSON.parse(raw || "{}");
        const type = String(data.type ?? "");
        if (type === "delivered" || type === "clicked") {
          await ctx.runMutation(internal.pushNotifications.recordPushBeaconInternal, {
            type,
            category: typeof data.c === "string" ? data.c.slice(0, 64) : undefined,
            platform: typeof data.pf === "string" ? data.pf.slice(0, 32) : undefined,
            tag: typeof data.tag === "string" ? data.tag.slice(0, 128) : undefined,
          });
        }
      }
    } catch {
      /* never error a beacon — analytics must not affect the SW */
    }
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }),
});

http.route({
  path: "/push/beacon",
  method: "OPTIONS",
  handler: httpAction(async (_, request) => {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }),
});

// ── Stripe webhook (raw body required, no auth) ──────────────────────
// Required env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Register in Stripe Dashboard → Developers → Webhooks:
//   URL: https://<deployment>.convex.site/stripe/webhook
//   Events: checkout.session.completed, payment_intent.payment_failed
http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: stripeWebhook,
});

// ── Resend email webhook (Svix-signed, no auth) ──────────────────────
// Records email lifecycle events (sent/delivered/opened/clicked/bounced/…) into
// the emailEvents table for the admin Activity feed. ZERO send-site changes.
// Configure in Resend → Webhooks:
//   URL: https://<deployment>.convex.site/resend/webhook  (Convex CONVEX_SITE_URL)
//   then set env RESEND_WEBHOOK_SECRET = the "whsec_…" signing secret.
// Inert (returns 200, inserts nothing) until that secret is set, so Resend's
// "send test" succeeds even before go-live.
async function verifySvix(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
  sigHeader: string
): Promise<boolean> {
  try {
    const b64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const keyBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const data = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    // svix-signature header = space-separated "v1,<base64sig>" tokens.
    return sigHeader.split(" ").some((tok) => {
      const comma = tok.indexOf(",");
      return comma > 0 && tok.slice(comma + 1) === expected;
    });
  } catch {
    return false;
  }
}

http.route({
  path: "/resend/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET || "";
    const body = await request.text();
    // Not configured yet — accept silently (Resend's test ping should 200).
    if (!secret) {
      return new Response(null, { status: 200, headers: corsHeaders(request) });
    }
    const id = request.headers.get("svix-id") || "";
    const ts = request.headers.get("svix-timestamp") || "";
    const sig = request.headers.get("svix-signature") || "";
    if (!id || !ts || !sig || !(await verifySvix(secret, id, ts, body, sig))) {
      return new Response("invalid signature", { status: 401, headers: corsHeaders(request) });
    }
    try {
      const evt = JSON.parse(body || "{}");
      const rawType = String(evt?.type ?? ""); // e.g. "email.delivered"
      const type = rawType.startsWith("email.") ? rawType.slice(6) : rawType;
      const data = evt?.data ?? {};
      const to = Array.isArray(data.to)
        ? data.to[0]
        : typeof data.to === "string"
          ? data.to
          : undefined;
      const created = evt?.created_at ? Date.parse(evt.created_at) : NaN;
      if (type) {
        await ctx.runMutation(internal.serverActivity.logEmailEventInternal, {
          at: Number.isFinite(created) ? created : Date.now(),
          type,
          to: typeof to === "string" ? to : undefined,
          subject: typeof data.subject === "string" ? data.subject : undefined,
          emailId: typeof data.email_id === "string" ? data.email_id : undefined,
        });
      }
    } catch {
      /* never error a webhook on a parse hiccup */
    }
    return new Response(null, { status: 200, headers: corsHeaders(request) });
  }),
});

// ── Door-keypad entry-event webhook (HMAC-signed, no auth) ──────────
// HA's /config/entry_webhook.py POSTs a signed entry event from the facility keypad
// (SPEC_DOOR_ENTRY_LOG_WEBHOOK). Body is compact JSON {ts, bay, code_hash, result,
// source}; the door code is a keyed HMAC hash (code_hash) — the RAW code never
// leaves the HA box. Header:  X-HA-Signature: sha256=<hex HMAC_SHA256(ENTRY_SIGN_KEY,
// rawBody)>  — the HMAC key is the ENTRY_SIGN_KEY *string* bytes (matching the HA
// script's `sign_key.encode()`), NOT hex-decoded. Constant-time compare; 401 on
// mismatch or until ENTRY_SIGN_KEY is set. Same shape as the Resend webhook above.
function entryBytesToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return s;
}
async function entrySignatureHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return entryBytesToHex(sig);
}
function entryConstantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

http.route({
  path: "/ha/entry",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signKey = process.env.ENTRY_SIGN_KEY || "";
    const body = await request.text();
    if (!signKey) {
      return new Response("not configured", { status: 401, headers: corsHeaders(request) });
    }
    const header = request.headers.get("x-ha-signature") || "";
    let expected: string;
    try {
      expected = "sha256=" + (await entrySignatureHex(signKey, body));
    } catch {
      return new Response("verify error", { status: 401, headers: corsHeaders(request) });
    }
    if (!header || !entryConstantTimeEqual(header, expected)) {
      return new Response("invalid signature", { status: 401, headers: corsHeaders(request) });
    }
    try {
      const d = JSON.parse(body || "{}");
      await ctx.runMutation(internal.serverActivity.logEntryEventInternal, {
        at: Date.now(),
        ts: typeof d.ts === "number" ? d.ts : 0,
        bay: typeof d.bay === "string" ? d.bay : "",
        codeHash: typeof d.code_hash === "string" ? d.code_hash : "",
        result: typeof d.result === "string" ? d.result : "unknown",
        source: typeof d.source === "string" ? d.source : "keypad",
      });
    } catch {
      /* signature already verified; never error on a parse hiccup */
    }
    return new Response(null, { status: 200, headers: corsHeaders(request) });
  }),
});

export default http;
