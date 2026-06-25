// Stripe checkout integration via Convex backend
import type { ConvexReactClient } from "convex/react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { api } from "../../convex/_generated/api";

// SPEC_EMBEDDED_CHECKOUT — Stripe.js publishable-key loader (singleton). Embedded
// Checkout renders payment in-app instead of redirecting. If the publishable key
// is not configured, getStripePromise() is null and the checkout flow falls back
// to the hosted redirect (createCheckoutSession then returns a `url`, not a
// clientSecret). Publishable keys are not secrets — they ship in the client bundle.
const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
let _stripePromise: Promise<StripeJs | null> | null | undefined;
export function getStripePromise(): Promise<StripeJs | null> | null {
  if (_stripePromise === undefined) {
    _stripePromise = STRIPE_PUBLISHABLE_KEY ? loadStripe(STRIPE_PUBLISHABLE_KEY) : null;
  }
  return _stripePromise ?? null;
}
export function isEmbeddedCheckoutAvailable(): boolean {
  return !!STRIPE_PUBLISHABLE_KEY;
}

// IMPORTANT: use the app's SHARED, AUTHENTICATED ConvexReactClient (created in
// main.tsx and wrapped by ConvexBetterAuthProvider) — NOT a fresh
// ConvexHttpClient. The Stripe actions require an authenticated identity
// (createCheckoutSession asserts the caller owns the booking; createPaymentLink
// / listRecentPayments are admin-gated). A bare ConvexHttpClient carries no auth
// token, so every action threw "Please sign in to check out." while the booking
// had already been created → orphaned "booked but unpaid" slot. Reusing the
// authed client makes all Stripe flows work for the signed-in user.
function getConvex(): ConvexReactClient | null {
  const g = globalThis as unknown as { __KRICKORA_CONVEX__?: ConvexReactClient | null };
  return g.__KRICKORA_CONVEX__ ?? null;
}

export interface CheckoutSessionRequest {
  laneId: string
  laneName: string
  variantId?: string | null
  variantName?: string | null
  date: string
  startHour: number
  duration: number
  customerName: string
  customerEmail: string
  price: number
  additionalLanes?: string[]
  isCoachBooking?: boolean
  bookingId?: string
  // Admin top-up link (extended booking): tags the link so the webhook records the
  // extra payment vs re-confirming; emailToCustomer also emails the link.
  topUp?: boolean
  emailToCustomer?: boolean
}

export interface CheckoutSessionResponse {
  sessionId: string
  url: string
  // SPEC_EMBEDDED_CHECKOUT — present when an embedded session was created (mount
  // EmbeddedCheckoutModal with it). Empty string when the backend returned a
  // hosted redirect URL instead (fallback). Exactly one of url / clientSecret is set.
  clientSecret: string
}

export function formatBookingDescription(req: CheckoutSessionRequest): string {
  const formatHour = (h: number) => {
    const whole = Math.floor(h)
    const mins = (h - whole) * 60
    const period = whole >= 12 ? 'pm' : 'am'
    const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole
    return mins > 0 ? `${display}:${mins.toString().padStart(2, '0')}${period}` : `${display}${period}`
  }
  const endHour = req.startHour + req.duration / 60
  const variantLabel = req.variantName ? ` (${req.variantName})` : ''
  const additionalLabel = req.additionalLanes && req.additionalLanes.length > 0
    ? ` + ${req.additionalLanes.join(', ')}`
    : ''
  return `${req.laneName}${variantLabel}${additionalLabel} - ${req.date} ${formatHour(req.startHour)}-${formatHour(endHour)} (${req.duration === 60 ? '1hr' : req.duration === 90 ? '1.5hr' : `${req.duration}min`})`
}

// Create a checkout session via Convex backend
export async function createCheckoutSession(req: CheckoutSessionRequest): Promise<CheckoutSessionResponse> {
  const convex = getConvex()
  if (!convex) {
    throw new Error('Payment system not configured. Please contact support.')
  }

  // SPEC_EMBEDDED_CHECKOUT — request the in-app embedded session ONLY when a
  // publishable key is configured; otherwise the backend returns a hosted url and
  // the caller redirects (graceful fallback). The `embedded` arg is OMITTED (not
  // sent as false) when not wanted, so the request stays valid against a backend
  // that predates this arg — keeping the frontend safe to deploy in any order.
  // Embedded only turns on once both the Convex deploy AND the key are live.
  const result = await convex.action(api.stripe.createCheckoutSession, {
    laneName: req.laneName,
    variantName: req.variantName ?? undefined,
    date: req.date,
    startHour: req.startHour,
    duration: req.duration,
    customerName: req.customerName,
    customerEmail: req.customerEmail,
    priceInCents: Math.round(req.price * 100),
    additionalLanes: req.additionalLanes,
    isCoachBooking: req.isCoachBooking,
    bookingId: req.bookingId,
    ...(isEmbeddedCheckoutAvailable() ? { embedded: true } : {}),
  })

  return {
    sessionId: result.sessionId,
    url: result.url ?? '',
    clientSecret: (result as { clientSecret?: string | null }).clientSecret ?? '',
  }
}

// Verify a checkout session completed successfully
export async function verifyCheckoutSession(sessionId: string): Promise<boolean> {
  const convex = getConvex()
  if (!convex) return false
  try {
    const result = await convex.action(api.stripe.verifySession, { sessionId })
    return result.paid
  } catch {
    return false
  }
}

// Create a payment link for admin to send to customers
export async function createPaymentLink(req: CheckoutSessionRequest): Promise<{ url: string; description: string }> {
  const convex = getConvex()
  if (!convex) {
    throw new Error('Payment system not configured.')
  }

  const result = await convex.action(api.stripe.createPaymentLink, {
    laneName: req.laneName,
    variantName: req.variantName ?? undefined,
    date: req.date,
    startHour: req.startHour,
    duration: req.duration,
    customerName: req.customerName,
    customerEmail: req.customerEmail,
    priceInCents: Math.round(req.price * 100),
    bookingId: req.bookingId,
    topUp: req.topUp,
    emailToCustomer: req.emailToCustomer,
  })

  return result
}

// Create a top-up checkout session for booking duration amendments
// (when the new duration costs more than the original booking)
export async function createTopUpCheckoutSession(params: {
  bookingId: string
  laneId: string
  laneName: string
  date: string
  startHour: number
  newDuration: number
  customerName: string
  customerEmail: string
  topUpAmountCents: number
}): Promise<CheckoutSessionResponse> {
  return createCheckoutSession({
    laneId: params.laneId,
    laneName: params.laneName,
    date: params.date,
    startHour: params.startHour,
    duration: params.newDuration,
    customerName: params.customerName,
    customerEmail: params.customerEmail,
    price: params.topUpAmountCents / 100,
    bookingId: params.bookingId,
  })
}

// SPEC_CHECKOUT_ABANDONMENT — cancel an unpaid ("Awaiting payment") booking:
// expires its Stripe session so it can't be paid, then frees the slot. Used by
// the Awaiting-payment card's Cancel button and the /checkout/cancel route.
export async function cancelUnpaidCheckout(bookingId: string): Promise<boolean> {
  const convex = getConvex()
  if (!convex) return false
  const result = await convex.action(api.stripe.cancelUnpaidCheckout, { bookingId })
  return !!result?.released
}

// List recent Stripe payments
export async function listRecentStripePayments(limit?: number) {
  const convex = getConvex()
  if (!convex) return []
  try {
    return await convex.action(api.stripe.listRecentPayments, { limit })
  } catch {
    return []
  }
}
