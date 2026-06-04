/* Cricket Revolution — web push handlers (SPEC_PWA_PUSH_NOTIFICATIONS §5.4).
 *
 * This plain script is importScripts()'d into the Workbox-generated service
 * worker (configured in vite.config.ts). It adds the `push` + `notificationclick`
 * listeners — no imports, no bundling, runs in the SW global scope.
 *
 * Payload shape (sent from convex/push.ts):
 *   { title, body, icon, badge, tag, url }
 */
/* global self, clients */

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_e) {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Cricket Revolution'
  const options = {
    body: data.body || '',
    icon: data.icon || '/pwa-192x192.png',
    badge: data.badge || '/pwa-192x192.png',
    tag: data.tag || undefined,
    // Collapse repeated updates to the same booking rather than stacking.
    renotify: data.tag ? true : undefined,
    data: { url: data.url || '/' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    (async () => {
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
