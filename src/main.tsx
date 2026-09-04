import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import './index.css'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConvexReactClient } from 'convex/react'
import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import { authClient } from '@/lib/auth-client'
import { initTracker } from '@/lib/tracker'

import { routeTree } from './routeTree.gen'

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}

// ---------------------------------------------------------------------------
// Singleton globals - stored on globalThis so HMR module re-execution reuses
// the same instances instead of creating new ones (which would remount the
// entire React tree and trigger the root-level error overlay).
// ---------------------------------------------------------------------------
type AppSingletons = {
  __KRICKORA_ROUTER__?: ReturnType<typeof createRouter>
  __KRICKORA_QUERY_CLIENT__?: QueryClient
  __KRICKORA_CONVEX__?: ConvexReactClient | null
  __KRICKORA_ROOT__?: ReactDOM.Root
  __KRICKORA_RENDERED__?: boolean
}
const g = globalThis as unknown as AppSingletons

// 2026-08-13 (PWA logout regression): ask the browser to mark our storage
// persistent — localStorage holds the bearer token (the WHOLE session on iOS
// PWA, where cross-site cookies are blocked), so storage eviction = logout.
// Best-effort; browsers may ignore it. Installed PWAs are usually granted.
try { void navigator.storage?.persist?.() } catch { /* unsupported */ }

function getRouter() {
  if (!g.__KRICKORA_ROUTER__) {
    g.__KRICKORA_ROUTER__ = createRouter({ routeTree })
  }
  return g.__KRICKORA_ROUTER__
}

function getQueryClient() {
  if (!g.__KRICKORA_QUERY_CLIENT__) {
    g.__KRICKORA_QUERY_CLIENT__ = new QueryClient()
  }
  return g.__KRICKORA_QUERY_CLIENT__
}

function getConvex(): ConvexReactClient | null {
  if (g.__KRICKORA_CONVEX__ === undefined) {
    const url = import.meta.env.VITE_CONVEX_URL
    g.__KRICKORA_CONVEX__ = url ? new ConvexReactClient(url) : null
  }
  return g.__KRICKORA_CONVEX__
}

function getRoot() {
  if (!g.__KRICKORA_ROOT__) {
    const el = document.getElementById('root') as HTMLElement
    g.__KRICKORA_ROOT__ = ReactDOM.createRoot(el)
  }
  return g.__KRICKORA_ROOT__
}

// Only perform the initial render once per page lifetime. HMR updates for
// components propagate through React Fast Refresh without re-rendering the
// provider tree from the module's top level.
if (!g.__KRICKORA_RENDERED__) {
  g.__KRICKORA_RENDERED__ = true

  const router = getRouter()
  const queryClient = getQueryClient()
  const convex = getConvex()

  // SPEC_ANALYTICS_BUILD_2026-06 — start the analytics pipeline (session_start +
  // first pageview + session_end listeners). Route-change pageviews + the signed-in
  // userId are wired in __root.tsx once auth + the router resolve.
  if (convex) initTracker(convex)

  const innerApp = (
    <QueryClientProvider client={queryClient}>
      {/* H3 (WEB review 2026-09-05) — this was defaultTheme="dark", and the app
          has NO theme toggle: `setTheme` is never called anywhere outside the
          provider, and nothing has ever written `vite-ui-theme` in this repo's
          history, so the default is simply what every visitor gets, forever.
          The dark variant here is class-based (`@custom-variant dark (&:is(.dark
          *))` in index.css), so that default was really shipping <html
          class="dark"> to everyone — while the app shell itself (__root.tsx:
          container, header, footer) and twelve of the sixteen routes carry ZERO
          dark styling. The result was a permanent white shell wrapped around
          dark-styled cards, plus dark-on-dark text (the "next week is now open"
          banner; and on the non-dismissable email-verification gate, the error
          message a customer needs in order to fix a mistyped address).
          Light is the mode this product is actually styled for: every `dark:`
          class in the tree is an ADDITION on a complete light base
          ("bg-white dark:bg-gray-900"), so light is fully specified everywhere
          and dark is the half-migrated one. Making it the default is one word;
          finishing dark mode means writing variants for the shell and twelve
          routes. The provider stays so a toggle can be added later. */}
      <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
        <RouterProvider router={router} />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  )

  getRoot().render(
    <StrictMode>
      {convex ? (
        <ConvexBetterAuthProvider client={convex} authClient={authClient}>
          {innerApp}
        </ConvexBetterAuthProvider>
      ) : (
        innerApp
      )}
    </StrictMode>,
  )
}

// Accept HMR self-updates so Vite does not trigger a full page reload.
// We intentionally do nothing in the callback — the singletons above are
// preserved on globalThis and React Fast Refresh handles component updates.
if (import.meta.hot) {
  import.meta.hot.accept()
}
