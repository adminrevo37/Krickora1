/**
 * Convex-native analytics tracker — ALL analytics stored in Convex.
 * Railway fully decommissioned. No external dependencies.
 *
 * SPEC_ANALYTICS_BUILD_2026-06 — extended with: session_end (duration) on
 * tab-hide, a booking-flow funnel (shared flowId across steps + the Stripe
 * round-trip), and door-code access tracking (lead time before a booking).
 */
import { ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";

let convexClient: ConvexReactClient | null = null;
let sessionId: string | null = null;
let currentUserId: string | null = null;
let sessionStartedAt = 0;
let listenersBound = false;

function getSessionId(): string {
  if (!sessionId) {
    sessionId = crypto.randomUUID();
  }
  return sessionId;
}

function track(
  type: string,
  name?: string,
  metadata?: Record<string, unknown>
) {
  if (!convexClient) return;
  try {
    void convexClient.mutation(api.analytics.trackEvent, {
      type,
      name,
      url: window.location.href,
      referrer: document.referrer || undefined,
      sessionId: getSessionId(),
      userId: currentUserId || undefined,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
    });
  } catch {
    // Silent fail — analytics should never break the app
  }
}

export function initTracker(client: ConvexReactClient) {
  convexClient = client;
  sessionStartedAt = Date.now();
  track("session_start");
  trackPageView();
  bindSessionEnd();
}

// SPEC_ANALYTICS_BUILD_2026-06 — emit session_end with a duration when the tab is
// hidden / closed. visibilitychange→hidden is the reliable mobile signal; pagehide
// covers desktop tab-close. Deduped per hidden cycle (re-armed when visible again).
let sessionEndSent = false;
function bindSessionEnd() {
  if (listenersBound || typeof document === "undefined") return;
  listenersBound = true;
  const fire = () => {
    if (sessionEndSent) return;
    sessionEndSent = true;
    track("session_end", undefined, { durationMs: Date.now() - sessionStartedAt });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") fire();
    else sessionEndSent = false; // re-arm for the next hide
  });
  window.addEventListener("pagehide", fire);
}

export function setTrackerUserId(userId: string | null) {
  currentUserId = userId;
}

// INF-6 (audit 2026-06): dedupe CONSECUTIVE identical pathnames. initTracker
// fires a pageview AND the root effect re-fires on mount (React StrictMode
// double-mounts in dev), so first load logged the same path 2× — pure write
// amplification on the unbounded analytics table. A→B→A still logs the second A
// (only an immediate repeat is suppressed). Query string changes are ignored on
// purpose (the funnel uses dedicated event steps, not pageviews).
let lastPageviewPath: string | null = null;
export function trackPageView() {
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  if (path === lastPageviewPath) return;
  lastPageviewPath = path;
  track("pageview");
}

export function trackEvent(name: string, metadata?: Record<string, unknown>) {
  track("event", name, metadata);
}

// ── Booking-flow funnel (C2.5) ────────────────────────────────────────────────
// A flowId ties the steps of one booking attempt together — including across the
// Stripe redirect, by persisting it in sessionStorage. Reconstructed server-side
// per flow to compute step conversion + time-in-step.
const FLOW_KEY = "kr_flow";

export function getFlowId(): string {
  try {
    let id = sessionStorage.getItem(FLOW_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(FLOW_KEY, id);
    }
    return id;
  } catch {
    return getSessionId();
  }
}

/** Begin a fresh booking attempt (called when the booking modal opens). */
export function startBookingFlow(): string {
  try {
    const id = crypto.randomUUID();
    sessionStorage.setItem(FLOW_KEY, id);
    return id;
  } catch {
    return getSessionId();
  }
}

export function clearBookingFlow() {
  try { sessionStorage.removeItem(FLOW_KEY); } catch { /* ignore */ }
}

/** Emit a booking-flow step event tagged with the current flowId. */
export function trackFunnelStep(step: string, extra?: Record<string, unknown>) {
  track("event", step, { flowId: getFlowId(), ...extra });
}

// ── Door-code access lead time (C2.8) ─────────────────────────────────────────
// Fired when a user views their booking's door access code. leadMinutes = minutes
// from now until the booking starts (negative = already started/past).
export function trackCodeView(bookingId: string, bookingStartMs: number) {
  const leadMinutes = Math.round((bookingStartMs - Date.now()) / 60000);
  track("event", "code_view", { bookingId, leadMinutes });
}
