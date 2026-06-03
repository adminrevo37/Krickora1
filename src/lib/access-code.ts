/**
 * Door Access Code Generator
 * Generates unique 4-digit numeric codes for facility entry upon booking confirmation.
 * Codes are time-based and unique per booking to prevent reuse.
 * Note: legacy 6-digit codes from before 2026-05-30 are still valid on existing bookings.
 */

// Store active codes to prevent duplicates within the same session
const activeCodes = new Set<string>()

/**
 * Generate a unique 4-digit door access code.
 * Uses crypto for randomness and checks for duplicates.
 */
export function generateAccessCode(): string {
  let code: string
  let attempts = 0
  do {
    // Generate a random 4-digit code (1000-9999)
    const array = new Uint32Array(1)
    crypto.getRandomValues(array)
    const num = 1000 + (array[0] % 9000)
    code = num.toString()
    attempts++
  } while (activeCodes.has(code) && attempts < 100)

  activeCodes.add(code)

  // Clean up old codes after 24 hours to prevent memory leak
  setTimeout(() => activeCodes.delete(code), 24 * 60 * 60 * 1000)

  return code
}

/**
 * Format access code for display. Codes are shown as clean digits with NO dash
 * (e.g. "7041") — matching exactly what the customer types at the door keypad and
 * what is written to the Google Calendar event.
 */
export function formatAccessCode(code: string): string {
  return code
}

/**
 * Invalidate an access code (e.g., when booking is cancelled)
 */
export function invalidateAccessCode(code: string): void {
  activeCodes.delete(code)
}
