import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mockApp, mockPlugin, resetMockVault, setMockFile } from "$/test-setup";
import {
  createMcpService,
  destroyMcpService,
  type McpService,
} from "./mcpServer";
import { staticTokenProvider } from "./tokenStore";
import type { RunningServer } from "./httpServer";

/**
 * ADR-0018 (OMC-016), Task 1. `resourceRegistry.test.ts` covers the
 * generic `ResourceRegistryClass` in isolation; this file drives the real
 * `ui://` declaration through `buildMcpServer` over the LEGACY transport —
 * the same idiom `eraRouter.test.ts` and `mcpServer.test.ts` use — so a
 * failure here is about the wired capability and handlers, not internal
 * structure. `modernEra.test.ts` covers the same two methods over the
 * modern path.
 */

const RESOURCE_URI = "ui://mcp-connector/search-results";
const MIME_TYPE = "text/html;profile=mcp-app";
const TOKEN = "t".repeat(32);
const VALID_ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

beforeEach(() => resetMockVault());

const active: McpService[] = [];
const runningServers: RunningServer[] = [];
afterEach(async () => {
  for (const s of active.splice(0)) await destroyMcpService(s);
  for (const s of runningServers.splice(0)) {
    (
      s.server as unknown as { closeAllConnections?: () => void }
    ).closeAllConnections?.();
    await new Promise<void>((r) => s.server.close(() => r()));
  }
});

/** A vault with markdown files whose paths must never leak onto the
 * resources surface (R-14) — the capability serves `ui://` application
 * views only, never vault content. */
function seedVaultFixture(): void {
  setMockFile(
    "Meeting Notes/2026-08-14 standup.md",
    "# Standup\nDiscussed the roadmap.",
  );
  setMockFile(
    "Projects/Vibrofer launch plan.md",
    "# Launch plan\nArticoli tecnici in gomma.",
  );
}

async function startService(): Promise<RunningServer> {
  const { startHttpServer } = await import("./httpServer");
  const svc = await createMcpService({
    app: mockApp(),
    plugin: mockPlugin(),
    pluginVersion: "0.4.0-alpha.1",
    serverName: "mcp-connector",
  });
  active.push(svc);
  const server = await startHttpServer({
    resolveTokens: staticTokenProvider(TOKEN),
    requestHandler: svc.handleRequest,
  });
  runningServers.push(server);
  return server;
}

async function postMcp(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("legacy path — resources/list and resources/read serve the ui:// application resource (R-02, R-03, R-14)", () => {
  test("resources/list returns only the search-results entry, mime type exact, and no vault path appears anywhere in the response", async () => {
    seedVaultFixture();
    const server = await startService();
    const res = await postMcp(server.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list",
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    const resources = (body.result?.resources ?? []) as Array<{
      uri: string;
      mimeType?: string;
    }>;
    // Only ui:// entries — R-14. Not "at least one" — the whole list.
    expect(resources.every((r) => r.uri.startsWith("ui://"))).toBe(true);
    const entry = resources.find((r) => r.uri === RESOURCE_URI);
    expect(entry).toBeDefined();
    expect(entry?.mimeType).toBe(MIME_TYPE);

    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("Meeting Notes");
    expect(bodyText).not.toContain("Vibrofer launch plan");
  });

  test("resources/read on the declared URI returns the generated HTML at exactly text/html;profile=mcp-app, matching the generated constant, no vault path present", async () => {
    seedVaultFixture();
    const server = await startService();
    // Dynamic import so a missing module fails only this assertion, not
    // every test in the file (the placeholder asset is Task 1 step 3).
    const { SEARCH_RESULTS_APP_HTML } =
      await import("$/features/mcp-apps/assets/searchResultsAppSource");
    const res = await postMcp(server.port, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: RESOURCE_URI },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    const content = body.result?.contents?.[0];
    expect(content?.uri).toBe(RESOURCE_URI);
    expect(content?.mimeType).toBe(MIME_TYPE);
    expect(content?.text).toBe(SEARCH_RESULTS_APP_HTML);

    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("Meeting Notes");
    expect(bodyText).not.toContain("Vibrofer launch plan");
  });

  test("resources/read on an unknown ui:// URI answers a protocol error naming it, not an empty result", async () => {
    const server = await startService();
    const unknownUri = "ui://mcp-connector/does-not-exist";
    const res = await postMcp(server.port, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: unknownUri },
    });
    const body = await res.json();
    expect(body.result).toBeUndefined();
    expect(body.error).toBeDefined();
    expect(String(body.error?.message ?? "")).toContain(unknownUri);
  });

  test("resources/templates/list answers an empty template list, not Method Not Found — SDK-owned once `resources` is declared", async () => {
    const server = await startService();
    const res = await postMcp(server.port, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/templates/list",
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result).toEqual({ resourceTemplates: [] });
  });
});

/**
 * Task 2 (R-04), composed level. `toolRegistry.test.ts` covers `setMeta`
 * on the bare class; this drives a real `tools/list` through the whole
 * composition root — `composeToolRegistry` → `wireSearchResultsApp` →
 * `buildMcpServer` — over BOTH eras, because D1/D2's whole point is that
 * one declaration reaches both. Iterates the entire list rather than
 * naming a third tool, per the plan's own instruction, so a stray `_meta`
 * on any other entry fails this test.
 */
describe("composed tools/list — the UI pointer names exactly two tools, both eras (R-04)", () => {
  const modernHeaders = (method: string) => ({
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  });

  function assertPointerOnlyOnSearchTools(
    tools: Array<{ name: string; _meta?: Record<string, unknown> }>,
  ): void {
    const withMeta = tools.filter(
      (t) => t._meta !== undefined && Object.keys(t._meta).length > 0,
    );
    expect(withMeta.map((t) => t.name).sort()).toEqual([
      "search_vault_simple",
      "search_vault_smart",
    ]);
    for (const tool of withMeta) {
      expect(tool._meta?.ui).toEqual({ resourceUri: RESOURCE_URI });
      expect(tool._meta?.["ui/resourceUri"]).toBe(RESOURCE_URI);
    }
  }

  test("legacy tools/list carries _meta.ui.resourceUri and _meta['ui/resourceUri'] on exactly the two search tools", async () => {
    const server = await startService();
    const res = await postMcp(server.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertPointerOnlyOnSearchTools(body.result?.tools ?? []);
  });

  test("modern tools/list carries the identical pointer on exactly the two search tools", async () => {
    const server = await startService();
    const res = await postMcp(
      server.port,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: VALID_ENVELOPE },
      },
      modernHeaders("tools/list"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    assertPointerOnlyOnSearchTools(body.result?.tools ?? []);
  });
});
