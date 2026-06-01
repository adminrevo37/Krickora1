// Server-side customer pricing — SPEC_MODIFY_BOOKING_UPGRADE.
//
// modifyBooking must compute the new price server-side (never trust the client),
// so it can charge/credit the correct difference. This mirrors the client helper
// getCustomerPrice() in src/lib/booking-data.ts: a per-hour rate from settings,
// with the Truman variant on its own rate. Truman is detected from the variantId
// string (variant ids contain "truman"), matching the client check.

import { PRICE_DEFAULTS } from "./priceDefaults";

export interface PricingSettings {
  customerPricePerHour?: number | null;
  trumanPricePerHour?: number | null;
}

/** Customer lane price for a duration, in whole cents. */
export function computeCustomerPriceCents(
  settings: PricingSettings | null | undefined,
  variantId: string | null | undefined,
  durationMinutes: number
): number {
  const hours = durationMinutes / 60;
  let perHour = settings?.customerPricePerHour ?? PRICE_DEFAULTS.customerPerHour;
  if (variantId && /truman/i.test(variantId)) {
    perHour = settings?.trumanPricePerHour ?? perHour;
  }
  return Math.round(perHour * hours * 100);
}
