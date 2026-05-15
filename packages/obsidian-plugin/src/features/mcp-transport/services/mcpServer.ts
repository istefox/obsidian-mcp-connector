import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "obsidian";
import type McpToolsPlugin from "$/main";
import { ToolRegistryClass } from "./toolRegistry";
import type { ToolRegistry } from "./toolRegistry";
import { registerTools } from "$/features/mcp-tools";
import { applyDisabledToolsFilter } from "$/features/tool-toggle";

export type McpServiceConfig = {
  app: App;
  plugin: McpToolsPlugin;
  pluginVersion: string;
};

export type McpService = {
  registry: ToolRegistry;
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

/**
 * Create an MCP service whose handler builds a fresh McpServer +
 * StreamableHTTPServerTransport per HTTP request.
 *
 * Why per-request instead of singleton: the SDK's
 * StreamableHTTPServerTransport in stateless mode
 * (`sessionIdGenerator: undefined`) explicitly forbids reuse —
 * see node_modules/@modelcontextprotocol/sdk webStandardStreamableHttp.js
 * line ~140: "Stateless transport cannot be reused across requests.
 * Create a new transport per request." Reusing one means the second
 * call throws and the HTTP server returns 500. We hit this in the
 * 0.4.0-alpha.2 vault TEST smoke (issue surfaced 2026-04-26).
 *
 * The cost of creating a fresh server+transport per request is on
 * the order of milliseconds and is dominated by the JSON parse;
 * acceptable for a single-user local server.
 *
 * The `ToolRegistry` (with all 29 tool registrations) is created
 * once at setup and shared across requests — registration is idempotent
 * but doing it per request would multiply the per-request cost
 * significantly with no benefit.
 */
export async function createMcpService(
  config: McpServiceConfig,
): Promise<McpService> {
  const registry = new ToolRegistryClass();
  await registerTools(registry, {
    app: config.app,
    plugin: config.plugin,
    pluginVersion: config.pluginVersion,
  });

  // Apply the user's `toolToggle.disabled` filter (Phase 4 T12.c).
  // Disabled tools stay registered but are flipped off the registry's
  // enabled set, so they no longer appear in `tools/list` and any
  // `tools/call` against them returns MethodNotFound. Idempotent.
  await applyDisabledToolsFilter(registry, config.plugin);

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const server = new McpServer(
      {
        name: "mcp-connector",
        version: config.pluginVersion,
      },
      {
        capabilities: {
          // Declare tools capability so the SDK allows tools/list and
          // tools/call request handler registration. Without this the
          // SDK throws "Server does not support tools" at
          // setRequestHandler time.
          tools: {},
        },
      },
    );

    // Wire the ArkType-based registry against the underlying SDK
    // Server so tools/list and tools/call go through our boolean
    // coercion + error formatting + disableByName support.
    server.server.setRequestHandler(ListToolsRequestSchema, registry.list);
    server.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      registry.dispatch(request.params, { server }),
    );

    // Stateless mode (no sessionIdGenerator) + JSON response. Per-
    // request transport — see file header for the SDK constraint.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      // Best-effort cleanup. If close() throws (e.g. transport
      // already closed by the SDK), log and swallow so the next
      // request still works.
      try {
        await transport.close();
      } catch (closeError) {
        console.error("[mcp] transport.close failed", closeError);
      }
      try {
        await server.close();
      } catch (closeError) {
        console.error("[mcp] server.close failed", closeError);
      }
    }
  };

  return { registry, handleRequest };
}

/**
 * Service-level teardown. With per-request server+transport creation
 * there is nothing to close at the service level — every request
 * already cleans up after itself in the `finally` block. Kept as an
 * exported async no-op for symmetry with the previous API and so
 * main.ts can call it unconditionally.
 */
export async function destroyMcpService(_svc: McpService): Promise<void> {
  // intentionally empty
}
