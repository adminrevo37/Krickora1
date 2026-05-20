/**
 * Door Access Code Generator
 * Generates unique 6-digit numeric codes for facility entry upon booking confirmation.
 * Codes are time-based and unique per booking to prevent reuse.
 */

// Store active codes to prevent duplicates within the same session
const activeCodes = new Set<string>()

/**
 * Generate a unique 6-digit door access code.
 * Uses crypto for randomness and checks for duplicates.
 */
export function generateAccessCode(): string {
  let code: string
  let attempts = 0
  do {
    // Generate a random 6-digit code (100000-999999)
    const array = new Uint32Array(1)
    crypto.getRandomValues(array)
    const num = 100000 + (array[0] % 900000)
    code = num.toString()
    attempts++
  } while (activeCodes.has(code) && attempts < 100)

  activeCodes.add(code)

  // Clean up old codes after 24 hours to prevent memory leak
  setTimeout(() => activeCodes.delete(code), 24 * 60 * 60 * 1000)

  return code
}

/**
 * Format access code for display with a dash in the middle (e.g., "482-193")
 */
export function formatAccessCode(code: string): string {
  if (code.length !== 6) return code
  return `${code.slice(0, 3)}-${code.slice(3)}`
}

/**
 * Invalidate an access code (e.g., when booking is cancelled)
 */
export function invalidateAccessCode(code: string): void {
  activeCodes.delete(code)
}
