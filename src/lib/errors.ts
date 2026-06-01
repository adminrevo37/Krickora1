// Extract a user-facing message from a thrown Convex error.
//
// WHY: Convex REDACTS plain `throw new Error(msg)` to a generic "Server Error" on
// the client in PRODUCTION (the message only survives in dev). The supported way
// to send a readable message to the client is `throw new ConvexError(msg)`, whose
// payload arrives in `error.data`. Our user-facing backend throws use ConvexError;
// this helper reads `error.data`, falls back to stripping Convex's wrapper out of
// `error.message`, and returns `undefined` for opaque/redacted errors so the
// caller's own fallback string is shown instead of "[CONVEX ...] Server Error".
export function getErrorMessage(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const data = (err as any).data
    if (typeof data === 'string' && data.trim()) return data.trim()
    if (data && typeof data === 'object' && typeof (data as any).message === 'string') {
      return (data as any).message
    }
    const raw = (err as any).message
    if (typeof raw === 'string') {
      // ConvexError surfaced via message: "... Uncaught ConvexError: <msg>"
      const m = raw.match(/Uncaught (?:Convex)?Error:\s*([\s\S]+?)(?:\s*\[Request|\n|$)/)
      if (m && m[1].trim()) return m[1].trim()
      // Opaque/redacted server error → let the caller's fallback show.
      if (/Server Error|\[CONVEX|\[Request ID/i.test(raw)) return undefined
      if (raw.trim()) return raw.trim()
    }
  }
  return undefined
}
