import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mockApp, mockPlugin, resetMockVault } from "$/test-setup";
import { createMcpService, destroyMcpService, type McpService } from "./mcpServer";

beforeEach(() => resetMockVault());

const active: McpService[] = [];
afterEach(async () => {
  for (const s of active.splice(0)) await destroyMcpService(s);
});

describe("createMcpService", () => {
  test("exposes a request handler compatible with StreamableHTTPServerTransport", async () => {
    const svc = await createMcpService({ app: mockApp(), plugin: mockPlugin(), pluginVersion: "0.4.0-alpha.1" });
    active.push(svc);
    expect(typeof svc.handleRequest).toBe("function");
  });
});

describe("end-to-end: HTTP → McpServer", () => {
  test("tools/list responds with get_server_info registered", async () => {
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({ app: mockApp(), plugin: mockPlugin(), pluginVersion: "0.4.0-alpha.1" });
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
    const svc = await createMcpService({ app: mockApp(), plugin: mockPlugin(), pluginVersion: "0.4.0-alpha.1" });
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
      const names = (tools as Array<{ name: string }>).map((t) => t.name).sort();
      expect(names).toEqual([
        "append_to_active_file",
        "append_to_vault_file",
        "create_vault_directory",
        "create_vault_file",
        "delete_active_file",
        "delete_vault_directory",
        "delete_vault_file",
        "execute_obsidian_command",
        "execute_template",
        "fetch",
        "get_active_file",
        "get_backlinks",
        "get_files_by_tag",
        "get_outgoing_links",
        "get_recent_files",
        "get_server_info",
        "get_vault_file",
        "get_vault_file_partial",
        "list_obsidian_commands",
        "list_tags",
        "list_vault_files",
        "patch_active_file",
        "patch_vault_file",
        "rename_vault_file",
        "search_vault",
        "search_vault_simple",
        "search_vault_smart",
        "show_file_in_obsidian",
        "update_active_file",
      ]);
      expect(names).toHaveLength(29);
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("tools/call get_server_info returns health payload", async () => {
    const { startHttpServer } = await import("./httpServer");
    const svc = await createMcpService({ app: mockApp(), plugin: mockPlugin(), pluginVersion: "0.4.0-alpha.1" });
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
});
