import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation } from 'convex/react'
import { useEffect, useRef } from 'react'
import { api } from '../../convex/_generated/api'
import { useAuth } from '../hooks/useAuth'

// NOTIFICATIONS INBOX (Inspector, 2026-09-03) — every push, re-readable in full.
// ?n=<id> (a push tap) marks that one read and scrolls to it.
export const Route = createFileRoute('/notifications')({
  validateSearch: (s: Record<string, unknown>): { n?: string } => ({ n: typeof s.n === 'string' ? s.n : undefined }),
  component: NotificationsPage,
})

const CATEGORY_ICON: Record<string, string> = {
  'booking-confirmation': '✅', 'session-reminders': '⏰', 'facility-access': '🔑', 'booking-changes': '✏️',
  'waitlist-offers': '🎟️', 'extend-offer': '➕', 'mate-alerts': '🤝', 'child-coaching': '🧒',
  'coach-allocation': '🎓', 'account-credit': '💳', 'coach-roster': '📋',
}
const fmtWhen = (ms: number) => {
  const d = new Date(ms)
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay
    ? d.toLocaleTimeString('en-AU', { timeZone: 'Australia/Perth', hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-AU', { timeZone: 'Australia/Perth', weekday: 'short', day: 'numeric', month: 'short' }) +
      ' ' + d.toLocaleTimeString('en-AU', { timeZone: 'Australia/Perth', hour: 'numeric', minute: '2-digit' })
}

function NotificationsPage() {
  const { user, isAuthenticated } = useAuth()
  const { n } = Route.useSearch()
  const navigate = useNavigate()
  const items = useQuery(api.notifications.listMine, user ? {} : 'skip')
  const markRead = useMutation(api.notifications.markRead)
  const markAllRead = useMutation(api.notifications.markAllRead)
  const marked = useRef<string | null>(null)

  useEffect(() => {
    if (!n || !user || marked.current === n) return
    marked.current = n
    markRead({ id: n }).catch(() => {})
    setTimeout(() => document.getElementById(`n-${n}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150)
  }, [n, user, markRead])

  if (!isAuthenticated) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center text-gray-500">
        <div className="text-5xl mb-4">🔔</div>
        <p>Sign in to see your notifications.</p>
      </div>
    )
  }

  const unread = (items ?? []).filter((i) => !i.readAt).length
  const go = (url: string) => {
    if (/^https?:/i.test(url)) { window.location.href = url; return }
    // Root deep links (?book=, ?offer=, ?wlDay=) are handled by the calendar on load.
    if (url.startsWith('/?')) { window.location.href = url; return }
    navigate({ to: url as any })
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Notifications</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Everything we've sent you in the last 7 days.{unread ? ` ${unread} unread.` : ''}</p>
        </div>
        {unread > 0 && (
          <button onClick={() => markAllRead().catch(() => {})} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200">
            Mark all read
          </button>
        )}
      </div>

      {items === undefined ? (
        <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-800 p-10 text-center">
          <div className="text-4xl mb-3">🔔</div>
          <p className="text-gray-600 dark:text-gray-300 font-medium">Nothing yet</p>
          <p className="text-sm text-gray-400 mt-1">Booking confirmations, reminders and waitlist offers will show here.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => {
            const isNew = !it.readAt
            const focus = it.id === n
            const buttons = it.actions.length > 0 ? it.actions.filter((a) => a.url) : it.url ? [{ title: 'Open', url: it.url }] : []
            return (
              <li
                key={it.id}
                id={`n-${it.id}`}
                onClick={() => { if (isNew) markRead({ id: it.id }).catch(() => {}) }}
                className={`rounded-2xl border p-4 transition-colors ${focus ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-900/20' : isNew ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900' : 'border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40'}`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-xl leading-none mt-0.5">{CATEGORY_ICON[it.category] ?? '🔔'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className={`text-sm ${isNew ? 'font-bold text-gray-900 dark:text-white' : 'font-semibold text-gray-700 dark:text-gray-300'}`}>{it.title}</p>
                      <span className="shrink-0 text-[11px] text-gray-400">{fmtWhen(it.sentAt)}</span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 whitespace-pre-line">{it.body}</p>
                    {buttons.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-3">
                        {buttons.map((b, i) => (
                          <button
                            key={i}
                            onClick={(e) => { e.stopPropagation(); markRead({ id: it.id }).catch(() => {}); go(b.url!) }}
                            className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${i === 0 ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200'}`}
                          >
                            {b.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {isNew && <span className="mt-2 w-2 h-2 rounded-full bg-emerald-500 shrink-0" aria-label="unread" />}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-[11px] text-gray-400 mt-6 text-center">
        Manage what you're notified about in <Link to="/profile" className="underline">My Profile</Link>.
      </p>
    </div>
  )
}
