#!/usr/bin/env bun
/**
 * Sandbox Control Server - v2026-01-22-v1
 * Auto-generated - do not edit manually
 */

const CONTROL_PORT = 8000;
const DEV_PORT = 5173;
const startedAt = new Date().toISOString();
let lastHealthCheck = null;
let devServerReady = false;

// Check if dev server is responding
async function checkDevServer() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${DEV_PORT}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    devServerReady = res.ok || res.status === 304 || res.status === 404 || res.status === 405;
    return devServerReady;
  } catch {
    devServerReady = false;
    return false;
  }
}

// Periodic dev server check (every 2 seconds until ready, then every 10 seconds)
let checkInterval = 2000;
async function startHealthChecks() {
  while (true) {
    await checkDevServer();
    lastHealthCheck = new Date().toISOString();
    if (devServerReady && checkInterval === 2000) {
      checkInterval = 10000; // Slow down once ready
    }
    await new Promise(r => setTimeout(r, checkInterval));
  }
}

// Start health checks in background
startHealthChecks();

// CORS headers for all responses
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = Bun.serve({
  port: CONTROL_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // GET /health - Basic health check
    if (path === "/health" && req.method === "GET") {
      return Response.json(
        { status: "ok", version: "2026-01-22-v1" },
        { headers: corsHeaders }
      );
    }

    // GET /ready - Readiness check (is dev server responding)
    if (path === "/ready" && req.method === "GET") {
      // Do a fresh check
      const isReady = await checkDevServer();
      return Response.json(
        { ready: isReady, devServerPort: DEV_PORT },
        { status: isReady ? 200 : 503, headers: corsHeaders }
      );
    }

    // GET /status - Detailed status
    if (path === "/status" && req.method === "GET") {
      const uptime = Date.now() - new Date(startedAt).getTime();
      return Response.json(
        {
          version: "2026-01-22-v1",
          ready: devServerReady,
          devServerRunning: devServerReady,
          devServerUrl: devServerReady ? `http://localhost:${DEV_PORT}` : null,
          uptime,
          startedAt,
          lastHealthCheck,
        },
        { headers: corsHeaders }
      );
    }

    // POST /write-file - Write a file
    if (path === "/write-file" && req.method === "POST") {
      try {
        const body = await req.json();
        const { path: filePath, content } = body;
        
        if (!filePath || content === undefined) {
          return Response.json(
            { success: false, error: "Missing path or content" },
            { status: 400, headers: corsHeaders }
          );
        }

        // Ensure path is within /workspace
        const fullPath = filePath.startsWith("/workspace/")
          ? filePath
          : `/workspace/${filePath.replace(/^\//, "")}`;

        // Ensure directory exists
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        await Bun.$`mkdir -p ${dir}`.quiet();

        // Write file
        await Bun.write(fullPath, content);

        return Response.json(
          { success: true, path: fullPath },
          { headers: corsHeaders }
        );
      } catch (error) {
        return Response.json(
          { success: false, error: String(error) },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // POST /restart - Restart dev server
    if (path === "/restart" && req.method === "POST") {
      try {
        // Kill existing vite processes
        await Bun.$`pkill -f "vite" || true`.quiet();
        devServerReady = false;
        checkInterval = 2000; // Speed up checks

        // Start dev server in background
        Bun.spawn(["bun", "vite", "--host", "0.0.0.0", "--port", String(DEV_PORT)], {
          cwd: "/workspace",
          stdout: "ignore",
          stderr: "ignore",
        });

        return Response.json(
          { success: true, message: "Dev server restarting" },
          { headers: corsHeaders }
        );
      } catch (error) {
        return Response.json(
          { success: false, error: String(error) },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // 404 for unknown routes
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders }
    );
  },
});

console.log(`[Control Server] Running on port ${CONTROL_PORT}`);
console.log(`[Control Server] Monitoring dev server on port ${DEV_PORT}`);
