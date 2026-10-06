import {
  BIND_HOST,
  BROKER_PORT,
  MCP_PATH_PREFIX,
} from "$/features/mcp-transport/constants";
import { fixedPort } from "$/features/mcp-transport/services/port";
import { SettingsStore } from "$/shared/settingsStore";
import { isLocationUnresolved, type LocatedPlugin } from "./discoveryBroker";

/**
 * The one place that decides which URL a client config points at
 * (ADR-0027). Every copy button and the Claude Desktop sync go through
 * `resolveClientEndpoint`; the generators stay pure and take the result.
 *
 * - Default: the shared broker's stable route for this vault,
 *   `http://127.0.0.1:27200/v1/<route-id>/mcp`. It survives vault port
 *   changes, so open order no longer breaks a saved config.
 * - Fixed port: the vault's own endpoint, `http://127.0.0.1:<port>/mcp`.
 *   The user pinned the port to address the vault directly.
 */

export function brokerRouteUrl(
  routeId: string,
  port: number = BROKER_PORT,
): string {
  return `http://${BIND_HOST}:${port}/v1/${routeId}${MCP_PATH_PREFIX}`;
}

export function directVaultUrl(port: number): string {
  return `http://${BIND_HOST}:${port}${MCP_PATH_PREFIX}`;
}

/** Pure form of the resolver, for callers that already hold both inputs. */
export function clientEndpointUrl(input: {
  routeId: string;
  fixedPort?: number;
}): string {
  return input.fixedPort === undefined
    ? brokerRouteUrl(input.routeId)
    : directVaultUrl(input.fixedPort);
}

export type EndpointPlugin = LocatedPlugin & {
  /** The vault's broker route runtime, absent until it starts. */
  discoveryState?: { routeId: string } | undefined;
};

/**
 * The URL this vault's client configs should use, or null when there is
 * none to hand out yet: The route has not started, or the vault's location
 * changed and the saved route may still belong to the original vault. An
 * unresolved location holds back a fixed port too, and is read from the
 * saved settings, so it holds with no route running: after a failed start
 * and for a fixed `27200`, which registers none. A fixed port needs no
 * running route otherwise.
 */
export async function resolveClientEndpoint(
  plugin: EndpointPlugin,
): Promise<string | null> {
  if (await isLocationUnresolved(plugin)) return null;
  const slice: unknown = await new SettingsStore(plugin).readSlice(
    "mcpTransport",
  );
  const port = fixedPort(
    typeof slice === "object" && slice !== null && "port" in slice
      ? slice.port
      : undefined,
  );
  if (port !== undefined) return directVaultUrl(port);
  const runtime = plugin.discoveryState;
  if (!runtime) return null;
  return clientEndpointUrl({ routeId: runtime.routeId });
}
