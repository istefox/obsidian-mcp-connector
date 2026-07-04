import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mockApp, mockPlugin, resetMockVault } from "$/test-setup";
import {
  createMcpService,
  destroyMcpService,
  type McpService,
} from "./mcpServer";

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
    });
    active.push(svc);

    const server = await startHttpServer({
      bearerToken: "t".repeat(32),
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
    });
    active.push(svc);

    const server = await startHttpServer({
      bearerToken: "t".repeat(32),
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
      expect(names).toHaveLength(49);

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
    });
    active.push(svc);

    const server = await startHttpServer({
      bearerToken: "t".repeat(32),
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
    });
    active.push(svc);

    const server = await startHttpServer({
      bearerToken: "t".repeat(32),
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
});
