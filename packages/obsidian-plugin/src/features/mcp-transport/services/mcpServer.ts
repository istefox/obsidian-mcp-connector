import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type App } from "obsidian";
import type McpToolsPlugin from "$/main";
import { logger } from "$/shared";
import type { ToolRegistry } from "./toolRegistry";
import type { PromptRegistry } from "./promptRegistry";
import {
  ToolLoadingManager,
  META_TOOLS,
} from "$/features/adaptive-tool-loading";
import { composeToolRegistry } from "$/composeToolRegistry";
import { MAX_REQUEST_BODY_BYTES } from "../constants";
import { bodyTargetsActivateTool, readBodyWithCap } from "./parseRequestBody";

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
  // The populated registry is composed outside the transport (policy
  // lives in $/composeToolRegistry); this layer only serves it.
  const { toolRegistry: registry, promptRegistry } =
    await composeToolRegistry(config);

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
    server.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        // Pass the SDK's request-scoped sendNotification down to the
        // handler. activate_tool uses it so its tools/list_changed carries
        // this call's relatedRequestId and is flushed on the POST response
        // stream (which is SSE for activate_tool — see below).
        const result = await registry.dispatch(request.params, {
          server,
          sendNotification: extra.sendNotification,
        });
        // Record the call for frequency-based promotion (meta-tools are excluded).
        if (!(META_TOOLS as string[]).includes(request.params.name)) {
          toolLoadingManager
            .recordCall(request.params.name, config.plugin)
            .catch(() => {});
        }
        return result;
      },
    );
    server.server.setRequestHandler(
      ListPromptsRequestSchema,
      promptRegistry.list,
    );
    server.server.setRequestHandler(GetPromptRequestSchema, (req) =>
      promptRegistry.dispatch(req.params),
    );

    // Inspect the body before choosing the response mode. The GET SSE
    // stream is blocked (POST-only transport), so a server-initiated
    // notification has nowhere to go — EXCEPT the response stream of the
    // request that triggers it. activate_tool must therefore answer with
    // SSE so its tools/list_changed is flushed on this call's stream and
    // the client re-lists without a reconnect. Every other request keeps
    // the default JSON response (Windows/mcp-remote path unchanged).
    const rawBody = await readBodyWithCap(req, MAX_REQUEST_BODY_BYTES);
    let parsedBody: unknown;
    let isActivateTool = false;
    if (rawBody !== null) {
      try {
        parsedBody = JSON.parse(rawBody);
        isActivateTool = bodyTargetsActivateTool(parsedBody);
      } catch {
        // Malformed JSON: leave parsedBody undefined and let the SDK emit
        // the standard -32700 parse error over the JSON response path.
        parsedBody = undefined;
      }
    }

    // Stateless mode (no sessionIdGenerator). Per-request transport — see
    // file header for the SDK constraint. JSON response by default; SSE
    // only for activate_tool so its notification can be delivered.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: !isActivateTool,
    });

    try {
      await server.connect(transport);
      // Pass the pre-parsed body so the SDK does not re-read the drained
      // stream (readBodyWithCap already consumed it).
      await transport.handleRequest(req, res, parsedBody);
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
