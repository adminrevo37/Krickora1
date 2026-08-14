// SYNC-4 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13) — "is it safe to reload right now?"
//
// The service-worker auto-apply in PwaUpdater must never interrupt something the
// user would lose: a Stripe checkout mid-entry, a booking being confirmed, an
// athlete allocation being edited. This is the single signal it consults.
//
// Reference-counted, because these sections nest (BookingModal open, then
// EmbeddedCheckoutModal on top of it). Busy is "count > 0".
//
// The main producer is ModalShell — since SPEC_UI_IMPROVEMENTS_2026-08 U8 every
// modal surface in the app goes through it, including the embedded checkout, so
// "any modal open" is covered automatically with no per-caller wiring. Anything
// else that must not be interrupted (a long admin write, say) can call beginBusy()
// directly.

let count = 0
const listeners = new Set<(busy: boolean) => void>()

function notify() {
  const busy = count > 0
  for (const fn of listeners) {
    try { fn(busy) } catch { /* a listener must never break a caller's unmount */ }
  }
}

/**
 * Mark a critical section. Returns an idempotent release function — calling it
 * twice (React 18 StrictMode double-invokes effects in dev) cannot drive the
 * count negative or release someone else's section.
 */
export function beginBusy(): () => void {
  count++
  notify()
  let released = false
  return () => {
    if (released) return
    released = true
    count = Math.max(0, count - 1)
    notify()
  }
}

export function isAppBusy(): boolean {
  return count > 0
}

export function onAppBusyChange(fn: (busy: boolean) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
