// SPEC_PROFILE_POSTCODE_SUBURB — server-side postcode/suburb validation.
// Wraps the auto-generated dataset (waPostcodes.ts) so the generated file stays code-free.
// User-facing failures use ConvexError (Convex redacts plain Error to "Server Error" in
// prod — established gotcha; ConvexError rides the message in error.data).
import { ConvexError } from "convex/values";
import { isValidWaPostcode, isValidPair } from "./waPostcodes";

export function normalizePostcode(pc?: string): string {
  return (pc ?? "").trim();
}
export function normalizeSuburb(s?: string): string {
  return (s ?? "").trim();
}

/** Throws ConvexError if the postcode/suburb pair is missing or invalid (WA only). */
export function assertValidLocation(postcode?: string, suburb?: string): void {
  const pc = normalizePostcode(postcode);
  const sub = normalizeSuburb(suburb);
  if (!pc || !sub) {
    throw new ConvexError("Please enter your postcode and select your suburb.");
  }
  if (!isValidWaPostcode(pc)) {
    throw new ConvexError("Enter a valid WA postcode (4 digits, starting with 6).");
  }
  if (!isValidPair(pc, sub)) {
    throw new ConvexError("Please select a suburb that matches your postcode.");
  }
}

/**
 * Validate only when at least one field is supplied. Used by partial-update paths
 * (profile edit, admin edit, signup follow-up) where omitting BOTH fields means
 * "not changing location" and must not throw.
 */
export function validateLocationIfProvided(postcode?: string, suburb?: string): void {
  const pc = normalizePostcode(postcode);
  const sub = normalizeSuburb(suburb);
  if (!pc && !sub) return;
  assertValidLocation(pc, sub);
}
