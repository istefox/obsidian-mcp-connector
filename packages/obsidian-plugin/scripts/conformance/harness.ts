#!/usr/bin/env bun
/*
 * Headless harness for the MCP conformance suite.
 *
 * Boots the real MCP service (`createMcpService` + `startHttpServer`, the
 * same pair mcpServer.test.ts drives end to end) on a fixed loopback port
 * with a fixed bearer token, then puts an auth-injecting reverse proxy in
 * front of it and blocks. No Obsidian and no vault: the Obsidian runtime
 * comes from the package's own test mocks (src/test-setup.ts), which is
 * why this file imports them before anything that touches "obsidian".
 *
 * Why a proxy at all: `conformance server --url <url>` has no flag for
 * request headers, and every request to this connector must carry a
 * bearer token. Weakening auth for the run would measure a server nobody
 * ships, so the token is added in front instead and everything else is
 * forwarded verbatim — method, path, query, headers and body — with the
 * response streamed back untouched so SSE frames arrive as they are
 * produced.
 *
 * Lives under scripts/, never under src/: the community-plugin review
 * lints src/** only and non-plugin code belongs outside it (CLAUDE.md,
 * ADR-0013).
 *
 * Driven by scripts/conformance/run.sh. To run it by hand:
 *
 *   cd packages/obsidian-plugin
 *   bun scripts/conformance/harness.ts
 */

// Order matters and the two static imports below carry it. test-preload.js
// aliases `window` onto the global object, and test-setup.ts registers the
// synthetic "obsidian" module; both must have run before any transport
// module is loaded, which is why those are pulled in dynamically further
// down rather than imported at the top of the file.
import "../../test-preload.js";
import { mockApp, mockPlugin } from "../../src/test-setup";

/** Port the plugin's own HTTP server binds. Not what the suite talks to. */
const UPSTREAM_PORT = Number(process.env.CONFORMANCE_UPSTREAM_PORT ?? 27310);
/** Port the auth-injecting proxy binds. This is the suite's `--url`. */
const PROXY_PORT = Number(process.env.CONFORMANCE_PROXY_PORT ?? 27300);
/**
 * Fixed 32-char token. The middleware requires 32 characters; the value is
 * inert — this process serves mock data on loopback and dies with the run.
 */
const TOKEN = "c".repeat(32);

const { createMcpService } =
  await import("../../src/features/mcp-transport/services/mcpServer");
const { startHttpServer } =
  await import("../../src/features/mcp-transport/services/httpServer");
const { staticTokenProvider } =
  await import("../../src/features/mcp-transport/services/tokenStore");

const service = await createMcpService({
  app: mockApp(),
  plugin: mockPlugin(),
  pluginVersion: "1.0.1",
  serverName: "mcp-connector",
});

const upstream = await startHttpServer({
  resolveTokens: staticTokenProvider(TOKEN),
  requestHandler: service.handleRequest,
  ports: [UPSTREAM_PORT],
});

const proxy = Bun.serve({
  port: PROXY_PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const incoming = new URL(request.url);
    // Path and query are preserved rather than pinned to /mcp, so a
    // scenario probing an unknown path still measures the server's own
    // answer instead of the proxy's.
    const target = `http://127.0.0.1:${upstream.port}${incoming.pathname}${incoming.search}`;

    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${TOKEN}`);

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();

    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
});

// Exit on the signal rather than closing the two servers first. A
// conformance run leaves `subscriptions/listen` SSE streams open, and
// awaiting a graceful close on those never returns — the process then
// ignores SIGTERM, outlives run.sh's trap and holds the port against the
// next run. There is nothing here to flush: the vault is a mock and the
// process is disposable.
const exit = () => process.exit(0);
process.on("SIGINT", exit);
process.on("SIGTERM", exit);

// run.sh polls the proxy port; this line is for a human reading the log.
console.log(
  `[conformance-harness] http://127.0.0.1:${proxy.port}/mcp -> http://127.0.0.1:${upstream.port}/mcp`,
);
