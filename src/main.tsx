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

  const innerApp = (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
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
