import type McpToolsPlugin from "$/main";
import { SettingsStore } from "$/shared/settingsStore";
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
import { resolvePorts } from "./port";
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
    // SettingsStore.updateSlice serializes the load→(maybe
    // generate)→save through the shared mutex; returning the slice
    // unchanged when a valid token exists skips the write.
    let bearerToken!: string;
    await new SettingsStore(plugin).updateSlice("mcpTransport", (current) => {
      const slice = (current as Record<string, unknown> | undefined) ?? {};
      const token = slice.bearerToken as string | undefined;

      // Byte length, not UTF-16 code units: the 32-byte floor is a
      // security threshold and must hold regardless of encoding.
      if (!token || Buffer.byteLength(token, "utf8") < 32) {
        // No valid token yet — generate a fresh one and persist it.
        // This only happens on the very first load after plugin install.
        bearerToken = generateToken();
        return { ...slice, bearerToken };
      }
      bearerToken = token;
      return current; // NO_CHANGE: keep the existing valid token
    });

    const mcpTransportSlice = (await new SettingsStore(plugin).readSlice(
      "mcpTransport",
    )) as { port?: unknown } | undefined;
    const ports = resolvePorts(mcpTransportSlice?.port);

    const mcp = await createMcpService({
      app: plugin.app,
      plugin,
      pluginVersion: plugin.manifest.version,
    });
    let server: RunningServer;
    try {
      server = await startHttpServer({
        bearerToken,
        requestHandler: mcp.handleRequest,
        ports,
      });
    } catch (err) {
      // A single-element `ports` list means the user configured a fixed
      // port: bindWithFallback's own "range exhausted" error (no .code)
      // means that one port was busy. Any other error (e.g. a genuine
      // EACCES/EADDRNOTAVAIL, which carries a .code) passes through
      // unchanged — only the busy-fixed-port case gets the friendlier
      // message. No fallback to the range: that would reintroduce the
      // cross-session port drift a fixed port is meant to fix (#337).
      if (ports.length === 1 && err instanceof Error && !("code" in err)) {
        throw new Error(
          `Port ${ports[0]} is in use — the MCP server did not start. Free it or change the port in settings.`,
        );
      }
      throw err;
    }

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
