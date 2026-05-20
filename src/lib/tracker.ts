/**
 * Convex-native analytics tracker — ALL analytics stored in Convex.
 * Railway fully decommissioned. No external dependencies.
 */
import { ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";

let convexClient: ConvexReactClient | null = null;
let sessionId: string | null = null;
let currentUserId: string | null = null;

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
  track("session_start");
  trackPageView();
}

export function setTrackerUserId(userId: string | null) {
  currentUserId = userId;
}

export function trackPageView() {
  track("pageview");
}

export function trackEvent(name: string, metadata?: Record<string, unknown>) {
  track("event", name, metadata);
}
