import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Notice, type App } from "obsidian";
import type McpToolsPlugin from "$/main";
import { logger } from "$/shared";
import { ToolRegistryClass } from "./toolRegistry";
import type { ToolRegistry } from "./toolRegistry";
import { PromptRegistryClass } from "./promptRegistry";
import type { PromptRegistry } from "./promptRegistry";
import { registerTools } from "$/features/mcp-tools";
import { applyDisabledToolsFilter } from "$/features/tool-toggle";
import {
  applyAdaptiveFilter,
  ToolLoadingManager,
  META_TOOLS,
} from "$/features/adaptive-tool-loading";
import {
  toolCatalogSchema,
  toolCatalogHandler,
} from "$/features/mcp-tools/tools/toolCatalog";
import {
  activateToolSchema,
  activateToolHandler,
} from "$/features/mcp-tools/tools/activateTool";

export type McpServiceConfig = {
  app: App;
  plugin: McpToolsPlugin;
  pluginVersion: string;
};

export type McpService = {
  registry: ToolRegistry;
  promptRegistry: PromptRegistry;
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
  const toolLoadingManager = new ToolLoadingManager();
  const registry = new ToolRegistryClass();
  const promptRegistry = new PromptRegistryClass();
  await registerTools(registry, {
    app: config.app,
    plugin: config.plugin,
    pluginVersion: config.pluginVersion,
  });

  // Register adaptive-loading meta-tools. These need access to the
  // registry itself (for listing/status) and are always active regardless
  // of profile, so they are registered here rather than in registerTools.
  registry.register(toolCatalogSchema, () =>
    toolCatalogHandler({ registry, plugin: config.plugin }),
  );
  registry.register(activateToolSchema, async (request, { server }) =>
    activateToolHandler({
      arguments: (request as { arguments: { name: string } }).arguments,
      registry,
      plugin: config.plugin,
      server,
      onActivated: (name) =>
        new Notice(`MCP Connector: "${name}" promoted to active`),
    }),
  );

  // Apply the adaptive profile filter (All/Core/Adaptive).
  // Runs before toolToggle so the user-controlled disable list still wins.
  await applyAdaptiveFilter(registry, config.plugin);

  // Apply the user's `toolToggle.disabled` filter.
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
          // listChanged: true signals support for notifications/tools/list_changed
          // (MCP spec 2025-06-18), emitted by activate_tool.
          tools: { listChanged: true },
          prompts: {},
        },
      },
    );

    // Wire the ArkType-based registry against the underlying SDK
    // Server so tools/list and tools/call go through our boolean
    // coercion + error formatting + disableByName support.
    server.server.setRequestHandler(ListToolsRequestSchema, registry.list);
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await registry.dispatch(request.params, { server });
      // Record the call for frequency-based promotion (meta-tools are excluded).
      if (!(META_TOOLS as string[]).includes(request.params.name)) {
        toolLoadingManager
          .recordCall(request.params.name, config.plugin)
          .catch(() => {});
      }
      return result;
    });
    server.server.setRequestHandler(
      ListPromptsRequestSchema,
      promptRegistry.list,
    );
    server.server.setRequestHandler(GetPromptRequestSchema, (req) =>
      promptRegistry.dispatch(req.params),
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
        logger.error("[mcp] transport.close failed", { error: closeError });
      }
      try {
        await server.close();
      } catch (closeError) {
        logger.error("[mcp] server.close failed", { error: closeError });
      }
    }
  };

  return { registry, promptRegistry, handleRequest };
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
