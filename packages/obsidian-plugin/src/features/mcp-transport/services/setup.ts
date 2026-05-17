import type McpToolsPlugin from "$/main";
import { globalSettingsMutex } from "$/features/command-permissions";
import { logger } from "$/shared";
import {
  startHttpServer,
  stopHttpServer,
  type RunningServer,
} from "./httpServer";
import {
  createMcpService,
  destroyMcpService,
  type McpService,
} from "./mcpServer";
import { generateToken } from "./token";

export type McpTransportState = {
  server: RunningServer;
  mcp: McpService;
  bearerToken: string;
};

export type SetupResult =
  | { success: true; state: McpTransportState }
  | { success: false; error: string };

/**
 * Initialize the MCP HTTP transport for the plugin.
 *
 * Loads (or generates and persists) a bearer token from plugin data,
 * then starts the in-process MCP server and HTTP listener.
 *
 * The bearer token is generated once on first load and stored in data.json
 * under `mcpTransport.bearerToken`. Subsequent loads reuse the stored value
 * so that clients don't need to re-authenticate on every plugin reload.
 *
 * Args:
 *   plugin: The Obsidian Plugin instance (provides loadData/saveData/manifest).
 *
 * Returns:
 *   SetupResult — success with the running state, or failure with an error message.
 */
export async function setup(plugin: McpToolsPlugin): Promise<SetupResult> {
  try {
    // Serialize the load→(maybe generate)→save through the shared
    // mutex so a first-run token write cannot clobber a concurrent
    // settings write from another feature (data.json is not atomic).
    const bearerToken = await globalSettingsMutex.run(async () => {
      const settings = ((await plugin.loadData()) ?? {}) as Record<
        string,
        unknown
      >;
      const mcpTransportSettings = (settings.mcpTransport ?? {}) as Record<
        string,
        unknown
      >;
      let token = mcpTransportSettings.bearerToken as string | undefined;

      // Byte length, not UTF-16 code units: the 32-byte floor is a
      // security threshold and must hold regardless of encoding.
      if (!token || Buffer.byteLength(token, "utf8") < 32) {
        // No valid token yet — generate a fresh one and persist it.
        // This only happens on the very first load after plugin install.
        token = generateToken();
        await plugin.saveData({
          ...settings,
          mcpTransport: { ...mcpTransportSettings, bearerToken: token },
        });
      }
      return token;
    });

    const mcp = await createMcpService({
      app: plugin.app,
      plugin,
      pluginVersion: plugin.manifest.version,
    });
    const server = await startHttpServer({
      bearerToken,
      requestHandler: mcp.handleRequest,
    });

    logger.info("MCP Connector HTTP server listening", {
      port: server.port,
      pluginVersion: plugin.manifest.version,
    });

    return { success: true, state: { server, mcp, bearerToken } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("MCP Connector failed to start HTTP server", {
      error: message,
    });
    return { success: false, error: message };
  }
}

/**
 * Gracefully shut down the MCP HTTP transport.
 *
 * Stops the HTTP server first (releases the port), then destroys the MCP
 * service (closes transport + server). Order matters: stopping HTTP first
 * prevents new requests from reaching a half-closed MCP service.
 *
 * Args:
 *   state: The McpTransportState returned by a successful setup() call.
 */
export async function teardown(state: McpTransportState): Promise<void> {
  await stopHttpServer(state.server);
  await destroyMcpService(state.mcp);
}
