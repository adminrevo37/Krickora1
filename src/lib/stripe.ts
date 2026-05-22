// Stripe checkout integration via Convex backend
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const convex = convexUrl ? new ConvexHttpClient(convexUrl) : null;

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
}

export interface CheckoutSessionResponse {
  sessionId: string
  url: string
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
  if (!convex) {
    throw new Error('Payment system not configured. Please contact support.')
  }

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
  })

  return {
    sessionId: result.sessionId,
    url: result.url ?? '',
  }
}

// Verify a checkout session completed successfully
export async function verifyCheckoutSession(sessionId: string): Promise<boolean> {
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
  })

  return result
}

// List recent Stripe payments
export async function listRecentStripePayments(limit?: number) {
  if (!convex) return []
  try {
    return await convex.action(api.stripe.listRecentPayments, { limit })
  } catch {
    return []
  }
}
