// SPEC_UI_IMPROVEMENTS_2026-08 U8 — one modal shell for every dialog surface.
//
// Before this, AnnouncementHost was the ONLY modal in the app with dialog
// semantics: every other one (booking, modify, waitlist, extend, embedded
// checkout, the My Bookings sheets) was a plain <div> overlay with no role,
// no aria-modal, no focus management, no Escape, and no body scroll lock — so a
// screen reader never announced a dialog had opened, keyboard users could tab
// straight out into the page behind, Escape did nothing, and the background
// rubber-banded under the sheet on iOS.
//
// This wraps the overlay + panel only; each caller keeps its own panel markup
// and classes, so adopting it is a drop-in swap of the two wrapper divs.
import { useEffect, useRef, type ReactNode } from 'react'

// Body scroll lock is REFERENCE-COUNTED: modals nest here (BookingModal opens
// EmbeddedCheckoutModal on top of itself), and a naive lock would be released by
// the inner modal unmounting while the outer one is still open.
let lockCount = 0
let savedOverflow = ''
let savedOverscroll = ''
function pushScrollLock() {
  if (typeof document === 'undefined') return
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow
    savedOverscroll = document.body.style.overscrollBehavior
    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'contain'
  }
  lockCount++
}
function popScrollLock() {
  if (typeof document === 'undefined') return
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) {
    document.body.style.overflow = savedOverflow
    document.body.style.overscrollBehavior = savedOverscroll
  }
}

// `iframe` MUST be in this list. Without it the Stripe Embedded Checkout iframe is
// invisible to the Tab cycle, so the trap below would bounce focus off the ✕ and
// back to the top of the dialog — making it impossible to tab into the card fields
// and pay by keyboard. (Once focus IS inside the cross-origin iframe its keydowns
// never reach our window listener, so the trap correctly stops applying there.)
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'

export interface ModalShellProps {
  /** Dismiss handler. Omit for a modal that must be dismissed by its own controls. */
  onClose?: () => void
  /** Backdrop taps dismiss. Default true when onClose is given. Set false where
   *  closing is destructive (e.g. mid-payment — U2). */
  closeOnBackdrop?: boolean
  /** Escape dismisses. Default true when onClose is given. */
  closeOnEscape?: boolean
  /** id of the element naming the dialog. Prefer this over `label`. */
  labelledBy?: string
  /** Fallback accessible name when there's no visible title element. */
  label?: string
  /** Classes for the PANEL (the caller's existing panel classes). */
  panelClassName?: string
  /** Classes for the outer positioning layer (z-index, padding, alignment). */
  overlayClassName?: string
  /** Classes for the dimmed backdrop itself. */
  backdropClassName?: string
  children: ReactNode
}

export default function ModalShell({
  onClose,
  closeOnBackdrop,
  closeOnEscape,
  labelledBy,
  label,
  panelClassName = '',
  overlayClassName = 'fixed inset-0 z-50 flex items-center justify-center p-4',
  backdropClassName = 'absolute inset-0 bg-black/50 backdrop-blur-sm',
  children,
}: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<Element | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const escEnabled = closeOnEscape ?? !!onClose
  const backdropEnabled = closeOnBackdrop ?? !!onClose

  // MOUNT/UNMOUNT ONLY. This deliberately does NOT depend on escEnabled: several
  // callers derive that from their step ('processing' disables Escape), so a
  // combined effect re-ran on every step change — releasing and re-taking the
  // scroll lock and, worse, yanking focus back to the ✕ mid-flow while the user
  // was filling the form.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement
    pushScrollLock()
    // Move focus into the dialog so a screen reader lands inside it and Tab
    // starts from here rather than the top of the page behind.
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panelRef.current)?.focus()
    return () => {
      popScrollLock()
      const prev = restoreFocusRef.current as HTMLElement | null
      if (prev && typeof prev.focus === 'function') prev.focus()
    }
  }, [])

  // Key handling re-binds freely — it holds no resources.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escEnabled) {
        e.stopPropagation()
        onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      // Simple focus trap — cycle within the panel.
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        .filter(n => n.offsetParent !== null || n === document.activeElement)
      if (nodes.length === 0) return
      const firstNode = nodes[0]
      const lastNode = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === firstNode) {
        e.preventDefault(); lastNode.focus()
      } else if (!e.shiftKey && document.activeElement === lastNode) {
        e.preventDefault(); firstNode.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [escEnabled])

  return (
    <div className={overlayClassName}>
      <div
        className={backdropClassName}
        onClick={backdropEnabled ? () => onCloseRef.current?.() : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        className={panelClassName}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
