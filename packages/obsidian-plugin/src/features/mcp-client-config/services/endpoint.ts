import {
  BIND_HOST,
  BROKER_PORT,
  MCP_PATH_PREFIX,
} from "$/features/mcp-transport/constants";
import { fixedPort } from "$/features/mcp-transport/services/port";
import { SettingsStore } from "$/shared/settingsStore";
import {
  isLocationUnresolved,
  type DiscoveryRuntime,
  type DiscoveryStatus,
  type LocatedPlugin,
} from "./discoveryBroker";

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
 * - Broker cannot reach the vault: the vault's own endpoint on its running
 *   transport port, until the route connects again. A config copied
 *   meanwhile works now, but breaks when that port changes.
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

/**
 * True while the broker reaches this vault on its route, or is expected
 * to again without the user: connecting, connected, or retrying after a
 * dropped control connection such as a failover between hosting vaults.
 * A refused registration, a broker port no compatible broker can use and
 * a route another vault holds leave the route URL dead until the user acts.
 */
function brokerReachesVault(status: DiscoveryStatus): boolean {
  return (
    status.state === "connecting" ||
    status.state === "connected" ||
    status.state === "retrying"
  );
}

export type EndpointPlugin = LocatedPlugin & {
  /** The vault's broker route runtime, absent until it starts. */
  discoveryState?:
    | Pick<DiscoveryRuntime, "routeId" | "status" | "transportPort">
    | undefined;
};

export type ClientEndpoint = {
  url: string;
  /**
   * `direct` is the fallback while the broker cannot reach this vault, see
   * brokerReachesVault. `fixed` is the user's pinned port.
   */
  kind: "broker" | "fixed" | "direct";
};

/**
 * The endpoint this vault's client configs should use, or null when there
 * is none to hand out yet: The route has not started, or the vault's
 * location changed and the saved route may still belong to the original
 * vault. An unresolved location holds back a fixed port too, and is read
 * from the saved settings, so it holds with no route running: after a
 * failed start and for a fixed `27200`, which registers none. A fixed port
 * needs no running route otherwise.
 */
export async function resolveClientEndpointDetails(
  plugin: EndpointPlugin,
): Promise<ClientEndpoint | null> {
  if (await isLocationUnresolved(plugin)) return null;
  const slice: unknown = await new SettingsStore(plugin).readSlice(
    "mcpTransport",
  );
  const port = fixedPort(
    typeof slice === "object" && slice !== null && "port" in slice
      ? slice.port
      : undefined,
  );
  if (port !== undefined) return { url: directVaultUrl(port), kind: "fixed" };
  const runtime = plugin.discoveryState;
  if (!runtime) return null;
  return brokerReachesVault(runtime.status)
    ? { url: clientEndpointUrl({ routeId: runtime.routeId }), kind: "broker" }
    : { url: directVaultUrl(runtime.transportPort), kind: "direct" };
}

/** The URL of resolveClientEndpointDetails, or null. */
export async function resolveClientEndpoint(
  plugin: EndpointPlugin,
): Promise<string | null> {
  return (await resolveClientEndpointDetails(plugin))?.url ?? null;
}
