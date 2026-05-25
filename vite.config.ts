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
    entries: ["index.html", "src/**/*.{ts,tsx,js,jsx}"],

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
