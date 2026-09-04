import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { shipperIdsPlugin } from "./plugins/vite-plugin-shipper-ids";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    shipperIdsPlugin(),
    react(),
    tailwindcss(),
    // SPEC_PWA_PUSH_NOTIFICATIONS — installable PWA + web push.
    VitePWA({
      // 'prompt' + PwaUpdater. SYNC-4 structural (2026-08-14): PwaUpdater no longer
      // waits for a human to tap Reload — it applies the waiting worker itself at
      // moments that cost the user nothing (cold start, and backgrounding), gated on
      // an app-busy signal so an open modal or a live Stripe checkout is never
      // interrupted. The toast remains for the visible, in-use case.
      //
      // NOTE: workbox `skipWaiting` stays OMITTED on purpose. It would activate the
      // new worker under a running page with no reload, swapping assets beneath live
      // code. Activation is driven explicitly by updateServiceWorker(true) instead.
      //
      // ⚠️ SYNC-4 (SPEC_FULL_AUDIT_IMPROVEMENTS_2026-08-13) — the comment that used
      // to sit here claimed "a cold start always serves the newest shell (SW
      // installs + NetworkFirst navigation)". That was WRONG and led to a false
      // sense of safety: `navigateFallback` below serves the PRECACHED index.html
      // for navigations and there is no NetworkFirst navigation route anywhere in
      // this config (the navigateFallbackDenylist exists precisely because
      // navigations do NOT hit the network). That used to mean an install whose user
      // never tapped Reload held a stale bundle INDEFINITELY; the SYNC-4 auto-apply
      // above now closes that in practice, but it cannot guarantee every client has
      // updated. Consequences: (1) Convex deploy discipline is STILL permanent —
      // deploy backend first, keep args additive, never remove/rename a function or
      // tighten a validator a shipped client might still call, keep legacy response
      // shapes; (2) a stale shell requests chunk names that no longer exist, which
      // PwaUpdater now recovers from (SYNC-3).
      // We register the SW ourselves via PwaUpdater, so injectRegister:null.
      registerType: "prompt",
      injectRegister: null,
      includeAssets: [
        "favicon.svg",
        "favicon-32x32.png",
        "apple-touch-icon.png",
        "robots.txt",
        "push-sw.js",
      ],
      manifest: {
        name: "Cricket Revolution",
        short_name: "Revolution",
        description:
          "Book indoor cricket training nets at Cricket Revolution, Stirling WA.",
        start_url: "/?source=pwa",
        scope: "/",
        display: "standalone",
        background_color: "#dc2626",
        theme_color: "#dc2626",
        orientation: "portrait",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/pwa-maskable-192x192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Pull in the push + notificationclick handlers (plain static SW script,
        // no bundling) so the generated Workbox SW can receive web push.
        importScripts: ["/push-sw.js"],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        // skipWaiting omitted BY DESIGN (see the SYNC-4 note above): the waiting SW
        // is activated explicitly by PwaUpdater via updateServiceWorker(true), which
        // reloads in the same step, so assets are never swapped under a live page.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
        // E7: keep admin-only code OUT of the customer PWA install precache (still
        // fetched on demand at runtime when an admin opens the dashboard). The
        // recharts+d3 "charts" chunk is the big, predictable admin-only payload; the
        // lazy admin-analytics route/tab chunks (incl. leaflet via MapTab) are fetched
        // on demand anyway.
        // C2 (SPEC_CODE_REVIEW_IMPROVEMENTS_2026-08): admin-only chunks (~500 KB —
        // analytics *Tab-*, MapTab/leaflet, rev-ops-7k2p*, AdminBookingCalendar) are
        // lazy-loaded at runtime; keep them OUT of every customer's PWA precache.
        globIgnores: ["**/charts-*.js", "**/pdflib-*.js", "**/*Tab-*.js", "**/MapTab-*.css", "**/rev-ops-7k2p*.js", "**/AdminBookingCalendar-*.js", "**/facility-instructions/**", "**/access/**", "**/58f7d9/**", "**/d058cb/**", "**/3fff00/**"],
        // STALE-BUNDLE FIX (2026-09-02, Inspector: "fix the stale bundle problem").
        // `navigateFallback` is GONE. It registered a NavigationRoute that served the
        // PRECACHED index.html for every navigation, ahead of any runtime route — so
        // a normal refresh could never show a new deploy; freshness depended entirely
        // on the service-worker auto-apply below, which (a) needs the new worker to
        // finish precaching ~1 MB first and (b) had a per-tab budget a long-lived
        // phone PWA exhausts after two deploys. Measured symptom: a client was still
        // writing the retired waitlist sentinel the day the replacement shipped.
        //
        // Navigations are now NETWORK-FIRST (3 s timeout) via the runtime route below:
        // any refresh or cold start with a network gets the CURRENT index.html and
        // its current hashed chunks straight from Vercel, whatever worker is active.
        // Offline / timeout falls back to the cached navigation, then the precached
        // shell (precacheFallback). The waiting-worker auto-apply still runs, but it
        // is now the mechanism for updating the OFFLINE shell, not the only way to
        // see a deploy. /api/* and the hosted static guides are excluded: they were
        // network-only before and stay that way.
        navigateFallback: null,
        // ⚠️ Without this, the precached index.html ALSO answers `/` (workbox's
        // default directoryIndex), and precache routes are registered ahead of
        // runtime routes — so the home navigation still came from the precache
        // (verified on prod 2026-09-02: app-shell cache created but EMPTY,
        // transferSize 0). null = only explicit /index.html hits the precache.
        directoryIndex: null,
        // CRITICAL: do NOT intercept Convex realtime/HTTP or Better Auth traffic.
        // Those are cross-origin (*.convex.cloud/.site) so the same-origin routes
        // below never match them — the SW leaves them entirely alone (realtime +
        // cross-site auth cookies keep working). We only runtime-cache our own
        // static assets; everything else (incl. cross-origin) bypasses the SW.
        runtimeCaching: [
          {
            // App-shell navigations: network first, short timeout, offline fallback
            // to the precached shell. See the STALE-BUNDLE FIX note above.
            urlPattern: ({ request, url, sameOrigin }: { request: Request; url: URL; sameOrigin: boolean }) =>
              sameOrigin &&
              request.mode === "navigate" &&
              !/^\/(?:api\/|facility-instructions|access|58f7d9|d058cb|3fff00)/.test(url.pathname),
            handler: "NetworkFirst",
            options: {
              cacheName: "app-shell",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 20, maxAgeSeconds: 7 * 24 * 60 * 60 },
              precacheFallback: { fallbackURL: "/index.html" },
            },
          },
          {
            urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
              sameOrigin && /\.(?:png|svg|ico|woff2?|jpg|jpeg|webp)$/.test(url.pathname),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "static-assets" },
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Split the big, rarely-changing vendor libs into their own long-cached
        // chunks so an app code change no longer busts the whole vendor bundle,
        // and the initial entry chunk shrinks. Route components are already
        // code-split by tanstackRouter({ autoCodeSplitting: true }); recharts +
        // its d3 deps are pulled into a "charts" chunk so they stay a single
        // separately-cacheable unit (still only fetched by the lazy
        // admin.analytics route). Path-matching (function) form is used rather
        // than the object form because the object form leaves react-dom /
        // framer-motion in the entry chunk under React 19's jsx-runtime imports.
        // react + react-dom + scheduler MUST share one chunk to keep a single
        // React instance (see resolve.dedupe below).
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return "react";
          // H4 (WEB review 2026-09-05) — prop-types matched NO rule below, so
          // Rollup default-chunked it in with its biggest consumer, recharts, i.e.
          // into "charts" (407 KB). But prop-types has a second consumer that IS on
          // the customer critical path: @stripe/react-stripe-js, used by
          // EmbeddedCheckoutModal. That put a STATIC `import{P}from"./charts-*.js"`
          // in the shared chunk which both the home/booking route and My Bookings
          // import — so every customer downloaded and parsed the whole recharts +
          // d3 bundle before the booking grid could render, purely to get
          // PropTypes. Charts is used only by lazily-loaded admin analytics tabs.
          // The coupling is invisible in the source, so if this is ever touched,
          // re-check with:
          //   grep -o 'from"\./charts-[^"]*"' dist/assets/*.js
          // and confirm only the admin analytics chunks appear.
          // prop-types' own nested react-is copy lives under
          // node_modules/prop-types/node_modules/, which this pattern also matches;
          // object-assign and loose-envify are its other two deps and must travel
          // with it or the same edge re-forms through them.
          if (
            /[\\/]node_modules[\\/](prop-types|object-assign|loose-envify)[\\/]/.test(
              id,
            )
          )
            return "react";
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return "router";
          if (
            /[\\/]node_modules[\\/](convex|better-auth|@convex-dev)[\\/]/.test(id)
          )
            return "convex";
          if (
            /[\\/]node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(
              id,
            )
          )
            return "motion";
          if (
            /[\\/]node_modules[\\/](recharts|recharts-scale|d3-[^\\/]+|victory-vendor|internmap)[\\/]/.test(
              id,
            )
          )
            return "charts";
          // SPEC_CLUB_TEAM_BOOKINGS: pdf-lib powers the admin-only club PDF export
          // (dynamically imported). Keep it a separate, precache-excluded chunk so
          // customers never download it in the PWA install.
          if (/[\\/]node_modules[\\/](pdf-lib|@pdf-lib[\\/]|pako)[\\/]/.test(id))
            return "pdflib";
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    // Force a fresh pre-bundle on every dev server start so stale chunk
    // hashes never co-exist with new ones in the browser (root cause of the
    // "Cannot read properties of null (reading 'useRef')" error in better-auth).
    force: true,

    include: [
      "react",
      "react-dom",
      "react-dom/client",
      // better-auth: include the full dep tree so none of its internals
      // are bundled inline (which can create a circular React reference)
      "better-auth/react",
      "better-auth/client",
      "@convex-dev/better-auth/react",
      // nanostores — used by better-auth/react internally; must be
      // pre-bundled separately so it shares the same React instance
      "nanostores",
      "@tanstack/react-store",
      "@radix-ui/react-select",
      "@radix-ui/react-slot",
      "@radix-ui/react-alert-dialog",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
    ],
  },
  server: {
    host: "0.0.0.0",
    strictPort: false,
    allowedHosts: [".modal.host", "shipper.now", "localhost", ".localhost"],
    headers: {
      // COEP lowered to unsafe-none — require-corp blocks tracker.js and auth callbacks
      "Cross-Origin-Embedder-Policy": "unsafe-none",
      // Allow OAuth popups (Google sign-in)
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      // Allow cross-origin resources to load
      "Cross-Origin-Resource-Policy": "cross-origin",
      // Credentials-aware: specific origin set by Convex, not wildcard here
    },
  },
});
