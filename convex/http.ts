import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { stripeWebhook } from "./stripeWebhook";

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
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4173",
  "https://krickora.shipper.now",
  "https://adventurous-chickadee-53.convex.site",
  "https://adventurous-chickadee-53.convex.cloud",
];

/**
 * Resolve the correct Access-Control-Allow-Origin for a request.
 * Must be a specific origin (not *) when credentials: true.
 */
function resolveOrigin(request?: Request): string {
  const origin = request?.headers.get("origin") || "";
  // Allow any .shipper.now, .modal.host, .convex.site, .convex.cloud domain
  if (
    ALLOWED_ORIGINS.includes(origin) ||
    origin.endsWith(".shipper.now") ||
    origin.endsWith(".w.modal.host") ||
    origin.endsWith(".convex.site") ||
    origin.endsWith(".convex.cloud")
  ) {
    return origin;
  }
  return ALLOWED_ORIGINS[0];
}

// ── Register Better Auth routes with credentials-aware CORS ────────────
authComponent.registerRoutes(http, createAuth, {
  cors: {
    allowedOrigins: [
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:4173",
      "https://krickora.shipper.now",
      "https://adventurous-chickadee-53.convex.site",
      "https://adventurous-chickadee-53.convex.cloud",
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

export default http;
