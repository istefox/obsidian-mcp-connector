import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import {
  InMemoryTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import { mockApp, mockPlugin, resetMockVault } from "$/test-setup";
import {
  createMcpService,
  destroyMcpService,
  type McpService,
} from "./mcpServer";
import { resolveServerName } from "./setup";
import { staticTokenProvider } from "./tokenStore";
import { ToolLoadingManager } from "$/features/adaptive-tool-loading";

beforeEach(() => resetMockVault());

const active: McpService[] = [];
afterEach(async () => {
  for (const s of active.splice(0)) await destroyMcpService(s);
});

describe("createMcpService", () => {
  test("exposes a request handler compatible with StreamableHTTPServerTransport", async () => {
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);
    expect(typeof svc.handleRequest).toBe("function");
  });
});

describe("end-to-end: HTTP → McpServer", () => {
  test("tools/list responds with get_server_info registered", async () => {
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const tools = body?.result?.tools ?? [];
      const names = tools.map((t: { name: string }) => t.name);
      expect(names).toContain("get_server_info");
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("chunked body over the cap answers 413, not a JSON parse error", async () => {
    const { startHttpServer } = await import("./httpServer");
    const { request } = await import("node:http");
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      // No Content-Length: chunked transfer bypasses httpServer.ts's
      // declared-length gate, so the cap must be enforced by
      // readBodyWithCap + the 413 short-circuit in mcpServer.ts.
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: "/mcp",
            method: "POST",
            headers: {
              authorization: `Bearer ${"t".repeat(32)}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "transfer-encoding": "chunked",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        // The server destroys the socket after responding; a late
        // write error must not fail the test once we have the status.
        let settled = false;
        req.on("response", () => {
          settled = true;
        });
        req.on("error", (err) => {
          if (!settled) reject(err);
        });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        for (let sent = 0; sent <= 1_048_576; sent += chunk.length) {
          req.write(chunk);
        }
        req.end();
      });
      expect(status).toBe(413);
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("tools/list exposes the full registry (regression-guards every tool name)", async () => {
    // Lock in the exact set of registered tools. Catches the silent-regression
    // class where a refactor in mcp-tools/index.ts drops a registry.register()
    // call: the affected tool's own unit tests keep passing in isolation, but
    // the tool stops being exposed via MCP. A failure here means either the
    // registry shrunk (missing tool) or grew (new tool needs the list updated).
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const tools = body?.result?.tools ?? [];
      const names = (tools as Array<{ name: string }>)
        .map((t) => t.name)
        .sort();
      expect(names).toEqual([
        "activate_tool",
        "activate_tools",
        "add_canvas_node",
        "append_to_active_file",
        "append_to_periodic_note",
        "append_to_vault_file",
        "connect_canvas_nodes",
        "create_vault_binary_file",
        "create_vault_directory",
        "create_vault_file",
        "delete_active_file",
        "delete_note_property",
        "delete_vault_directory",
        "delete_vault_file",
        "execute_dataview_query",
        "execute_obsidian_command",
        "execute_template",
        "fetch",
        "find_broken_links",
        "find_orphaned_notes",
        "get_active_file",
        "get_backlinks",
        "get_canvas",
        "get_files_by_tag",
        "get_note_outline",
        "get_note_property",
        "get_or_create_daily_note",
        "get_or_create_periodic_note",
        "get_outgoing_links",
        "get_recent_files",
        "get_server_info",
        "get_vault_file",
        "get_vault_file_partial",
        "get_vault_files",
        "get_vault_overview",
        "list_bookmarks",
        "list_obsidian_commands",
        "list_property_values",
        "list_tags",
        "list_vault_files",
        "patch_active_file",
        "patch_vault_file",
        "rename_heading",
        "rename_vault_file",
        "search_and_replace",
        "search_vault",
        "search_vault_simple",
        "search_vault_smart",
        "set_note_property",
        "show_file_in_obsidian",
        "tool_catalog",
        "update_active_file",
      ]);
      expect(names).toHaveLength(52);

      // Annotations completeness: every exposed tool must carry MCP
      // annotations with an explicit readOnlyHint and openWorldHint.
      // A failure here means a new tool was registered without an
      // entry in mcp-tools/toolAnnotations.ts.
      const missingAnnotations = (
        tools as Array<{
          name: string;
          annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
        }>
      )
        .filter(
          (t) =>
            typeof t.annotations?.readOnlyHint !== "boolean" ||
            typeof t.annotations?.openWorldHint !== "boolean",
        )
        .map((t) => t.name);
      expect(missingAnnotations).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("tools/call get_server_info returns health payload", async () => {
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: {
            name: "get_server_info",
            arguments: {},
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const text = body?.result?.content?.[0]?.text as string;
      const parsed = JSON.parse(text);
      expect(parsed.status).toBe("ok");
      expect(parsed.version).toBe("0.4.0-alpha.1");
      expect(parsed.transport).toBe("streamable-http");
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("tools/call result carries structuredContent in the wire response", async () => {
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "get_server_info", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // content[].text is present (backward-compat path)
      const text = body?.result?.content?.[0]?.text as string;
      expect(typeof text).toBe("string");
      const parsed = JSON.parse(text);
      expect(parsed.status).toBe("ok");

      // structuredContent must be present and be the same object
      const sc = body?.result?.structuredContent as Record<string, unknown>;
      expect(sc).toBeDefined();
      expect(typeof sc).toBe("object");
      expect(sc.status).toBe("ok");
      // structuredContent object matches the parsed text blob
      expect(sc).toEqual(parsed);
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("initialize reports the configured serverInfo.name", async () => {
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "Obsidian - Test Vault",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body?.result?.serverInfo?.name).toBe("Obsidian - Test Vault");
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("initialize reports a custom serverInfo.name override", async () => {
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "My Custom Name",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body?.result?.serverInfo?.name).toBe("My Custom Name");
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});

/** In-memory-backed plugin so recordCall counters can be read back after
 * a call — the default `mockPlugin()` discards `saveData`. */
function makeCountingPlugin() {
  let store: Record<string, unknown> = {};
  return mockPlugin({
    loadData: async () => ({ ...store }),
    saveData: async (d: unknown) => {
      store = { ...(d as Record<string, unknown>) };
    },
  });
}

describe("recordCall gating — self-healing inactive tool error (issue #354)", () => {
  test("adaptive-inactive call does not increment the counter", async () => {
    const { startHttpServer } = await import("./httpServer");
    const plugin = makeCountingPlugin();
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);
    svc.registry.setAdaptiveDisabled("get_server_info", true);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_server_info", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const text = body?.result?.content?.[0]?.text as string;
      expect(text).toContain("Tool 'get_server_info' exists but is inactive");

      await svc.flushPendingCalls();
      const state = await new ToolLoadingManager().loadState(plugin);
      expect(state.counters.get_server_info).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("baseline / regression guard: an enabled call still increments the counter", async () => {
    const { startHttpServer } = await import("./httpServer");
    const plugin = makeCountingPlugin();
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_server_info", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);

      await svc.flushPendingCalls();
      const state = await new ToolLoadingManager().loadState(plugin);
      expect(state.counters.get_server_info).toBe(1);
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("meta-tools are still excluded (unchanged behavior, touched line)", async () => {
    const { startHttpServer } = await import("./httpServer");
    const plugin = makeCountingPlugin();
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "tool_catalog", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);

      await svc.flushPendingCalls();
      const state = await new ToolLoadingManager().loadState(plugin);
      expect(state.counters.tool_catalog).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});

describe("createMcpService — multi-token resolveTokens call-sites (issue #348, ADR-0014)", () => {
  test("two tokens on one server route to different handler invocations with different tokenId", async () => {
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const tokenA = { id: "a", label: "A", token: "a".repeat(32), createdAt: 0 };
    const tokenB = { id: "b", label: "B", token: "b".repeat(32), createdAt: 0 };
    const server = await startHttpServer({
      resolveTokens: async () => [tokenA, tokenB],
      requestHandler: svc.handleRequest,
    });

    try {
      const resA = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      const resB = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenB.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });
      // Both requests must authenticate and be handled — the point under
      // test is that `resolveTokens` is queried per request and each
      // request's own bearer resolves to ITS OWN tokenId, not a single
      // cached one. handleRequest itself does not yet echo tokenId back
      // on the wire, so success (200, not 401) is the observable proxy
      // for "each request reached the handler with a distinct tokenId
      // resolved from resolveTokens" until Task 5 threads scope through.
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("a failing resolveTokens 401s the request rather than authenticating anyone", async () => {
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({
      app: mockApp(),
      plugin: mockPlugin(),
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: async () => {
        throw new Error("synthetic loadData() failure");
      },
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(32)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});

describe("Task 5 — per-token scope threading (ADR-0014 §3)", () => {
  const TOKEN_ALL = {
    id: "tok-all",
    label: "All",
    token: "a".repeat(32),
    createdAt: 1,
  };
  const TOKEN_CORE = {
    id: "tok-core",
    label: "Core",
    token: "c".repeat(32),
    createdAt: 2,
  };

  /** Plugin pre-seeded with two tokens, `all` and `core`, and their policies. */
  function makeScopedPlugin() {
    let store: Record<string, unknown> = {
      mcpTransport: {
        bearerToken: TOKEN_ALL.token,
        tokens: [TOKEN_ALL, TOKEN_CORE],
      },
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          [TOKEN_ALL.id]: { profile: "all", promoted: [], allowed: null },
          [TOKEN_CORE.id]: { profile: "core", promoted: [], allowed: null },
        },
      },
    };
    return mockPlugin({
      loadData: async () => ({ ...store }),
      saveData: async (d: unknown) => {
        store = { ...(d as Record<string, unknown>) };
      },
    });
  }

  test("two tokens (all vs core) on one server return different tools/list sets, each containing the three meta-tools (R-01, R-03)", async () => {
    const { startHttpServer } = await import("./httpServer");
    const plugin = makeScopedPlugin();
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: async () => [TOKEN_ALL, TOKEN_CORE],
      requestHandler: svc.handleRequest,
    });

    const listFor = async (token: string): Promise<string[]> => {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      return ((body?.result?.tools ?? []) as Array<{ name: string }>).map(
        (t) => t.name,
      );
    };

    try {
      const allNames = await listFor(TOKEN_ALL.token);
      const coreNames = await listFor(TOKEN_CORE.token);

      const metaTools = ["tool_catalog", "activate_tool", "activate_tools"];
      for (const m of metaTools) {
        expect(allNames).toContain(m);
        expect(coreNames).toContain(m);
      }

      // The two tokens' sets genuinely differ, and the core token's is the
      // narrower one, restricted to CORE_SET (+ meta-tools).
      expect(coreNames.length).toBeLessThan(allNames.length);
      expect(coreNames).toContain("get_active_file"); // CORE_SET member
      expect(coreNames).not.toContain("find_broken_links"); // not core, not promoted
      expect(allNames).toContain("find_broken_links");
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("tools/call for a tool outside the calling token's active set returns the recoverable error and does not increment its counter (R-04, ADR-0011 gate preserved)", async () => {
    const { startHttpServer } = await import("./httpServer");
    const plugin = makeScopedPlugin();
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const server = await startHttpServer({
      resolveTokens: async () => [TOKEN_CORE],
      requestHandler: svc.handleRequest,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN_CORE.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          // find_broken_links is outside the `core` profile's active set
          // (not in CORE_SET, not promoted) — a genuinely different
          // caller than the recordCall-gating describe block above, which
          // uses the global adaptive flag rather than a token scope.
          params: { name: "find_broken_links", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const text = body?.result?.content?.[0]?.text as string;
      expect(body?.result?.isError).toBe(true);
      expect(text).toContain("find_broken_links");
      expect(text.toLowerCase()).not.toContain("unknown tool");

      await svc.flushPendingCalls();
      const state = await new ToolLoadingManager().loadState(plugin);
      expect(state.counters.find_broken_links).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});

describe("OMC-008 Task 3 — buildMcpServer is the single per-request factory, called directly (R-09)", () => {
  // TDD RED phase (plan Task 3 sub-step 1, `docs/superpowers/plans/2026-08-08-omc-008-adopt-mcp-spec-2026-07-28.md`).
  // `buildMcpServer` does not exist yet: `createMcpService` still builds its
  // `McpServer` inline inside `handleRequest`, unreachable from a test. This
  // block pins the surface the extraction (plan Task 3 sub-step 2) must
  // expose: a `buildMcpServer(tokenId)` field on the returned `McpService`,
  // synchronous, returning an `McpServer` wired exactly like today's inline
  // one. Both the compiler (no such property on `McpService`) and the
  // runtime (`svc.buildMcpServer is not a function`) reject this file until
  // that field exists — the missing export IS the RED.
  const TOKEN_A = {
    id: "tok-a",
    label: "A",
    token: "a".repeat(32),
    createdAt: 1,
  };
  const TOKEN_B = {
    id: "tok-b",
    label: "B",
    token: "b".repeat(32),
    createdAt: 2,
  };

  /** Two tokens, `all` vs `core`, matching the fixture ADR-0014's own tests
   * use (`Task 5 — per-token scope threading` above) — reused here rather
   * than imported so this file stays a self-contained anchor for R-09's
   * direct-call guarantee. */
  function makeTwoTokenPlugin() {
    let store: Record<string, unknown> = {
      mcpTransport: {
        bearerToken: TOKEN_A.token,
        tokens: [TOKEN_A, TOKEN_B],
      },
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          [TOKEN_A.id]: { profile: "all", promoted: [], allowed: null },
          [TOKEN_B.id]: { profile: "core", promoted: [], allowed: null },
        },
      },
    };
    return mockPlugin({
      loadData: async () => ({ ...store }),
      saveData: async (d: unknown) => {
        store = { ...(d as Record<string, unknown>) };
      },
    });
  }

  /**
   * Drives `tools/list` straight against an `McpServer` instance with no
   * HTTP server and no `fetch` — `InMemoryTransport.createLinkedPair()` is
   * the SDK's own exported test seam for exactly this ("one should be
   * passed to a Client and one to a Server", `@modelcontextprotocol/server`
   * `dist/src-CX2iR2pK.mjs`). One end is handed to the server under test;
   * the other is driven by hand, since this project depends on `server` and
   * `node` only — no `@modelcontextprotocol/client` package is installed.
   */
  async function listToolsDirect(server: McpServer): Promise<string[]> {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const response = new Promise<{
      result?: { tools?: Array<{ name: string }> };
    }>((resolve) => {
      clientTransport.onmessage = (message) =>
        resolve(message as { result?: { tools?: Array<{ name: string }> } });
    });
    await server.connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const body = await response;
    return (body.result?.tools ?? []).map((t) => t.name);
  }

  test("buildMcpServer(tokenA) and buildMcpServer(tokenB) produce tools/list sets matching each token's own policy", async () => {
    const plugin = makeTwoTokenPlugin();
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);

    const serverA = svc.buildMcpServer(TOKEN_A.id);
    const serverB = svc.buildMcpServer(TOKEN_B.id);

    const namesA = await listToolsDirect(serverA);
    const namesB = await listToolsDirect(serverB);

    // Both tokens see the meta-tools, but the core token's set is the
    // narrower one (same CORE_SET / promotion semantics the HTTP-level
    // "Task 5" tests above already pin) — the point under test here is that
    // this holds when `buildMcpServer` is called directly, no HTTP involved.
    expect(namesB.length).toBeLessThan(namesA.length);
    expect(namesB).toContain("get_active_file");
    expect(namesB).not.toContain("find_broken_links");
    expect(namesA).toContain("find_broken_links");
  });
});

describe("resolveServerName", () => {
  test('falls back to "Obsidian - <vault name>" when unset, empty, or whitespace-only', () => {
    const app = mockApp();
    expect(resolveServerName(app, undefined)).toBe("Obsidian - Test Vault");
    expect(resolveServerName(app, "")).toBe("Obsidian - Test Vault");
    expect(resolveServerName(app, "   ")).toBe("Obsidian - Test Vault");
  });

  test("uses the configured name, trimmed", () => {
    const app = mockApp();
    expect(resolveServerName(app, "  Foo  ")).toBe("Foo");
  });
});
