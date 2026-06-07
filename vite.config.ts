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
      // 'prompt' + a reload toast (PwaUpdater): when a new deploy is detected the
      // user gets a non-blocking "New version — Reload" toast instead of a
      // surprise mid-session reload. Never strands on a stale build — a cold
      // start always serves the newest shell (SW installs + NetworkFirst
      // navigation), and the toast lets an open session update on demand.
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
        // skipWaiting omitted: in 'prompt' mode the waiting SW holds until the
        // user taps Reload (PwaUpdater calls updateServiceWorker(true)).
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
        // E7: keep admin-only code OUT of the customer PWA install precache (still
        // fetched on demand at runtime when an admin opens the dashboard). The
        // recharts+d3 "charts" chunk is the big, predictable admin-only payload; the
        // lazy admin-analytics route/tab chunks (incl. leaflet via MapTab) are fetched
        // on demand anyway.
        globIgnores: ["**/charts-*.js"],
        // App-shell navigations → NetworkFirst (a new deploy is picked up; falls
        // back to the cached shell offline). NEVER fall back for /api/*.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        // CRITICAL: do NOT intercept Convex realtime/HTTP or Better Auth traffic.
        // Those are cross-origin (*.convex.cloud/.site) so the same-origin routes
        // below never match them — the SW leaves them entirely alone (realtime +
        // cross-site auth cookies keep working). We only runtime-cache our own
        // static assets; everything else (incl. cross-origin) bypasses the SW.
        runtimeCaching: [
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
