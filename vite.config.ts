import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { shipperIdsPlugin } from "./plugins/vite-plugin-shipper-ids";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    shipperIdsPlugin(),
    react(),
    tailwindcss(),
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
