/* Cricket Revolution — web push handlers (SPEC_PWA_PUSH_NOTIFICATIONS §5.4,
 * extended by SPEC_PUSH_NOTIFICATIONS_V2 §8 for action buttons + app badge).
 *
 * This plain script is importScripts()'d into the Workbox-generated service
 * worker (configured in vite.config.ts). It adds the `push` + `notificationclick`
 * listeners — no imports, no bundling, runs in the SW global scope.
 *
 * Payload shape (sent from convex/push.ts):
 *   { title, body, icon, badge, tag, url, actions?: [{ action, title, url }] }
 */
/* global self, clients */

// SPEC_ANALYTICS_BUILD_2026-06 C2.4 — coarse platform from this device's push
// subscription endpoint, matching the server's send-side bucketing so delivered/
// clicked attribute to the same platform as 'sent'.
function platformFromEndpoint(endpoint) {
  const e = (endpoint || '').toLowerCase()
  if (e.includes('push.apple.com')) return 'ios'
  if (e.includes('fcm.googleapis.com') || e.includes('android')) return 'fcm'
  if (e.includes('mozilla.com')) return 'firefox'
  if (e.includes('windows.com') || e.includes('microsoft')) return 'windows'
  return 'other'
}

// Fire-and-forget beacon to the Convex /push/beacon HTTP action. `data.b` carries
// the absolute beacon URL (set by the server from CONVEX_SITE_URL); `data.c` the
// category. Never throws — analytics must not affect notification delivery.
async function beacon(type, data) {
  try {
    const url = data && data.b
    if (!url) return
    let pf = 'other'
    try {
      const sub = await self.registration.pushManager.getSubscription()
      if (sub && sub.endpoint) pf = platformFromEndpoint(sub.endpoint)
    } catch (_e) { /* ignore */ }
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, c: data.c, tag: data.tag, pf }),
      keepalive: true,
      credentials: 'omit',
    })
  } catch (_e) {
    /* ignore beacon failures */
  }
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_e) {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Cricket Revolution'
  // §8 — action buttons. Each action carries its own deep-link in data.actionUrls
  // so notificationclick can route the tapped button. Android/desktop render the
  // buttons; iOS Safari/PWA ignores `actions` (the body tap is the fallback).
  const actions = Array.isArray(data.actions)
    ? data.actions.map((a) => ({ action: a.action, title: a.title }))
    : undefined
  const actionUrls = {}
  if (Array.isArray(data.actions)) {
    for (const a of data.actions) if (a.url) actionUrls[a.action] = a.url
  }
  const options = {
    body: data.body || '',
    icon: data.icon || '/pwa-192x192.png',
    badge: data.badge || '/pwa-192x192.png',
    tag: data.tag || undefined,
    // Collapse repeated updates to the same booking rather than stacking.
    renotify: data.tag ? true : undefined,
    actions,
    // Carry the beacon URL (b), category (c) and tag through to notificationclick
    // so the click event can also report back (C2.4).
    data: { url: data.url || '/', actionUrls, b: data.b, c: data.c, tag: data.tag },
  }
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options)
      await beacon('delivered', data)
      // §8 app badge — best-effort presence badge on the installed-app icon.
      // Feature-detected; unsupported platforms (incl. iOS) simply skip it.
      try {
        if (self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge()
      } catch (_e) {
        /* badge unsupported — ignore */
      }
    })()
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const d = event.notification.data || {}
  // §8 — if a specific action button was tapped, prefer its deep-link; otherwise
  // use the default body-tap url.
  let targetUrl = d.url || '/'
  if (event.action && d.actionUrls && d.actionUrls[event.action]) {
    targetUrl = d.actionUrls[event.action]
  }
  event.waitUntil(
    (async () => {
      await beacon('clicked', d)
      // Clear the app badge — the user is engaging with the notification.
      try {
        if (self.navigator && self.navigator.clearAppBadge) await self.navigator.clearAppBadge()
      } catch (_e) {
        /* ignore */
      }
      const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true })
      // Focus an existing app window (and navigate it to the deep link) if one is open.
      for (const win of wins) {
        if ('focus' in win) {
          try {
            await win.focus()
            if ('navigate' in win) await win.navigate(targetUrl)
          } catch (_e) {
            /* fall through to openWindow */
          }
          return
        }
      }
      if (clients.openWindow) await clients.openWindow(targetUrl)
    })()
  )
})
