// Server-side customer pricing — SPEC_MODIFY_BOOKING_UPGRADE.
//
// modifyBooking must compute the new price server-side (never trust the client),
// so it can charge/credit the correct difference. This mirrors the client helper
// getCustomerPrice() in src/lib/booking-data.ts: a per-hour rate from settings,
// with the Truman variant on its own rate. The variant→rate mapping is the
// explicit one in ./lanes (SPEC_RECONFIGURABLE_LANES — replaces the old /truman/
// substring hack; still matches legacy "bm3-truman" ids via normalizeVariant).

import { variantRatePerHour, normalizeVariant, VARIANT_TRUMAN } from "./lanes";
import { PRICE_DEFAULTS } from "./priceDefaults";

export interface PricingSettings {
  customerPricePerHour?: number | null;
  trumanPricePerHour?: number | null;
  // SPEC_30MIN_GAP_FILL — explicit per-variant 30-minute gap-fill price (dollars).
  thirtyMinPrice?: number | null;
  trumanThirtyMinPrice?: number | null;
}

/**
 * SPEC_30MIN_GAP_FILL — flat 30-minute gap-fill price in whole cents. Explicit
 * (NOT pro-rata of the hourly): Truman uses `trumanThirtyMinPrice` (default $25),
 * everything else uses `thirtyMinPrice` (default $20). Used only for the unavoidable
 * 30-min gap a full hour can't fill (validated in createBooking).
 */
export function thirtyMinPriceCents(
  settings: PricingSettings | null | undefined,
  variantId: string | null | undefined
): number {
  const isTruman = normalizeVariant(variantId) === VARIANT_TRUMAN;
  const dollars = isTruman
    ? settings?.trumanThirtyMinPrice ?? PRICE_DEFAULTS.trumanThirtyMin
    : settings?.thirtyMinPrice ?? PRICE_DEFAULTS.thirtyMin;
  return Math.round(dollars * 100);
}

/** Customer lane price for a duration, in whole cents. */
export function computeCustomerPriceCents(
  settings: PricingSettings | null | undefined,
  variantId: string | null | undefined,
  durationMinutes: number
): number {
  // SPEC_30MIN_GAP_FILL — a 30-min booking is a flat gap-fill price, not pro-rata.
  if (durationMinutes === 30) return thirtyMinPriceCents(settings, variantId);
  const hours = durationMinutes / 60;
  const perHour = variantRatePerHour(variantId, settings);
  return Math.round(perHour * hours * 100);
}

/**
 * Credit (in whole cents) to issue when a customer SHORTENS/downgrades a booking.
 *
 * Policy (Inspector 2026-06-02): credit ONLY what was actually PAID, pro-rata to
 * the value removed — NOT the gross list-price difference. `paidValueCents` is the
 * stored post-discount price (`bookings.priceInCents` = card + any redeemed credit;
 * the discounted-away portion is already excluded). We pro-rate that paid value by
 * the fraction of GROSS removed, so a 50%-off booking shortened by half returns half
 * of what was paid, and a $0 (100%-off / comp) booking returns nothing — no minting.
 *
 * MIRROR: an identical pure function lives in src/lib/booking-data.ts so the
 * ModifyBookingModal preview matches this charge exactly. Keep the two in sync.
 */
export function decreaseCreditCents(
  paidValueCents: number,
  oldGrossCents: number,
  newGrossCents: number
): number {
  if (!(paidValueCents > 0) || oldGrossCents <= 0) return 0;
  const removedCents = Math.max(0, oldGrossCents - newGrossCents);
  if (removedCents <= 0) return 0;
  const fraction = Math.min(1, removedCents / oldGrossCents);
  return Math.min(paidValueCents, Math.round(paidValueCents * fraction));
}
