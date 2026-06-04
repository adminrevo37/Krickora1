// SPEC_INAPP_BANNERS — display host. Mounted once in __root.tsx. Fetches the
// active banners/pop-ups for the current viewer and renders:
//   • banners  → a dismissable strip stacked under the header (cap 2 visible)
//   • modal    → ONE centered pop-up (highest priority), shown once per load
//
// Mounts only AFTER auth resolves (profileReady for logged-in, or a definitively
// logged-out viewer) to avoid the refresh flash called out in
// SPEC_AUTH_LOADING_SMOOTHING. The server query never reads the clock, so the
// startAt/endAt active-window check is done here; logged-out dismissals fall back
// to localStorage (logged-in dismissals are server-side, consistent across devices).
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useAuth } from '../hooks/useAuth'

type Item = {
  _id: string
  title: string
  body: string
  ctaLabel?: string
  ctaTarget?: string
  displayType: string // 'banner' | 'modal'
  style: string // 'info' | 'notice' | 'promo'
  dismissible: boolean
  priority: number
  startAt?: number
  endAt?: number
}

const LS_KEY = 'krickora.annDismissed'

function readLsDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}
function writeLsDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(Array.from(ids)))
  } catch {
    /* ignore quota / private-mode errors */
  }
}

const STYLE_MAP: Record<string, { wrap: string; icon: string; cta: string }> = {
  // info uses the Cricket Revolution brand red; notice = amber; promo = emerald.
  info: { wrap: 'bg-red-50 border-red-200 text-red-800', icon: 'ℹ️', cta: 'bg-red-600 hover:bg-red-700' },
  notice: { wrap: 'bg-amber-50 border-amber-200 text-amber-900', icon: '⚠️', cta: 'bg-amber-600 hover:bg-amber-700' },
  promo: { wrap: 'bg-emerald-50 border-emerald-200 text-emerald-800', icon: '🎉', cta: 'bg-emerald-600 hover:bg-emerald-700' },
}
const styleOf = (s: string) => STYLE_MAP[s] ?? STYLE_MAP.info

export default function AnnouncementHost() {
  const { isLoading, isAuthenticated, profileReady } = useAuth()
  const navigate = useNavigate()

  // Render only once auth has settled. Logged-in: wait for profileReady so the
  // viewer's role/bookings are known. Logged-out: a definitive !isAuthenticated.
  const ready = !isLoading && (profileReady || !isAuthenticated)
  const loggedIn = isAuthenticated

  const items = useQuery(
    api.announcements.listActiveAnnouncementsForViewer,
    ready ? {} : 'skip'
  ) as Item[] | undefined
  const dismissAnnouncement = useMutation(api.announcements.dismissAnnouncement)

  // Instant local hide (optimistic), plus the logged-out localStorage set.
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [lsDismissed, setLsDismissed] = useState<Set<string>>(() => readLsDismissed())
  // Modal closed for THIS session (e.g. CTA taken / Esc on a non-dismissible modal)
  // without recording a permanent dismissal.
  const [modalClosed, setModalClosed] = useState<Set<string>>(new Set())

  const dismiss = (a: Item) => {
    setHidden((prev) => new Set(prev).add(a._id))
    if (!a.dismissible) return // session-only close; reappears next load
    if (loggedIn) {
      dismissAnnouncement({ announcementId: a._id as any }).catch(() => {})
    } else {
      const next = new Set(lsDismissed).add(a._id)
      setLsDismissed(next)
      writeLsDismissed(next)
    }
  }

  const followCta = (a: Item) => {
    const t = (a.ctaTarget || '').trim()
    if (!t) return
    if (/^https?:\/\//i.test(t)) {
      window.open(t, '_blank', 'noopener,noreferrer')
    } else {
      navigate({ to: t as any }).catch(() => {
        window.location.href = t
      })
    }
  }

  const now = Date.now()
  const visible = (items ?? []).filter((a) => {
    if (hidden.has(a._id)) return false
    if (!loggedIn && lsDismissed.has(a._id)) return false
    if (a.startAt != null && now < a.startAt) return false
    if (a.endAt != null && now > a.endAt) return false
    return true
  })

  const banners = visible.filter((a) => a.displayType === 'banner').slice(0, 2)
  const modal = visible.find((a) => a.displayType === 'modal' && !modalClosed.has(a._id))

  if (!ready) return null
  if (banners.length === 0 && !modal) return null

  return (
    <>
      {/* ── Banner strip (under header) ── */}
      {banners.length > 0 && (
        <div className="w-full">
          {banners.map((a) => {
            const st = styleOf(a.style)
            return (
              <div key={a._id} className={`border-b ${st.wrap} motion-safe:animate-in motion-safe:fade-in`}>
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-start gap-3">
                  <span className="text-base leading-5 shrink-0 mt-0.5">{st.icon}</span>
                  <div className="flex-1 min-w-0 text-sm">
                    <span className="font-semibold">{a.title}</span>
                    {a.body && <span className="ml-2 opacity-90 whitespace-pre-wrap">{a.body}</span>}
                  </div>
                  {a.ctaLabel && a.ctaTarget && (
                    <button
                      onClick={() => followCta(a)}
                      className="shrink-0 text-xs font-semibold underline underline-offset-2 hover:opacity-80"
                    >
                      {a.ctaLabel}
                    </button>
                  )}
                  {a.dismissible && (
                    <button
                      onClick={() => dismiss(a)}
                      aria-label="Dismiss"
                      className="shrink-0 -mr-1 p-1 rounded hover:bg-black/5 leading-none"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Pop-up modal (one at a time) ── */}
      {modal && (
        <AnnouncementModal
          item={modal}
          onCta={() => {
            followCta(modal)
            setModalClosed((prev) => new Set(prev).add(modal._id))
          }}
          onClose={() => {
            if (modal.dismissible) dismiss(modal)
            else setModalClosed((prev) => new Set(prev).add(modal._id))
          }}
        />
      )}
    </>
  )
}

function AnnouncementModal({
  item,
  onCta,
  onClose,
}: {
  item: Item
  onCta: () => void
  onClose: () => void
}) {
  const st = styleOf(item.style)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 motion-safe:animate-in motion-safe:fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="announcement-title"
        className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden motion-safe:animate-in motion-safe:zoom-in-95"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`px-5 py-3 border-b flex items-center gap-2 ${st.wrap}`}>
          <span className="text-lg leading-none">{st.icon}</span>
          <h3 id="announcement-title" className="font-bold">
            {item.title}
          </h3>
        </div>
        <div className="p-5">
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{item.body}</p>
          <div className="flex justify-end gap-2 mt-5">
            <button
              ref={closeRef}
              onClick={onClose}
              className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200"
            >
              {item.dismissible ? 'Got it' : 'Close'}
            </button>
            {item.ctaLabel && item.ctaTarget && (
              <button
                onClick={onCta}
                className={`px-4 py-2 rounded-lg text-white text-sm font-semibold ${st.cta}`}
              >
                {item.ctaLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
