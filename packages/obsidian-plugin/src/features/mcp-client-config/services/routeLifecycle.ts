import { BROKER_PORT } from "$/features/mcp-transport/constants";
import type {
  McpTransportState,
  SetupResult,
} from "$/features/mcp-transport/services/setup";
import { logger } from "$/shared/logger";
import type { DiscoveryRuntime } from "./discoveryBroker";

/**
 * This vault's MCP transport and broker route across plugin startup,
 * unload, transport restarts and route changes (ADR-0027). The steps are
 * passed in, so the order they run in is testable without an Obsidian
 * plugin instance.
 */

/** Rejects an operation that the plugin's unload cancelled. */
export class RouteQueueClosed extends Error {
  constructor() {
    super("The plugin was unloaded");
  }
}

/**
 * Runs one transport or route operation at a time for a plugin instance.
 * Two overlapping saves could otherwise tear down each other's transport,
 * and one could then register a route to a port it no longer holds.
 */
export type RouteQueue = {
  /**
   * Run `operation` once every earlier one has settled, or reject with
   * RouteQueueClosed when the queue closes first. `stale()` turns true
   * once the queue closes: An operation still running then tears down
   * what it created instead of installing it.
   */
  run<T>(operation: (stale: () => boolean) => Promise<T>): Promise<T>;
  /**
   * Called by `onunload`, which Obsidian does not await: Synchronous, and
   * no queued operation runs afterwards.
   */
  close(): void;
  /**
   * Settles once the running operation has, without rejecting. `onunload`
   * waits for it before releasing the transport: an operation still
   * registering a route stops that route itself once it sees `stale()`,
   * so the broker never forwards to a port this vault already released.
   */
  idle(): Promise<void>;
};

export function createRouteQueue(): RouteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const stale = () => closed;
  return {
    run(operation) {
      const result = tail.then(() => {
        if (closed) throw new RouteQueueClosed();
        return operation(stale);
      });
      tail = result.catch(() => undefined);
      return result;
    },
    close() {
      closed = true;
    },
    async idle() {
      await tail;
    },
  };
}

type RoutePlugin = {
  routeQueue: RouteQueue;
  mcpTransportState?: McpTransportState;
  discoveryState?: DiscoveryRuntime;
};

/**
 * The port a route registers, or null when none may. The broker forwards a
 * route to the port registered with it, so a route registered without a
 * running transport would hand clients' bearer tokens to whatever binds
 * that port next. A legacy fixed port on the broker port registers no
 * route either.
 */
function routablePort(plugin: RoutePlugin): number | null {
  const port = plugin.mcpTransportState?.server.port;
  return port === undefined || port === BROKER_PORT ? null : port;
}

/** Clears the field before stopping, so `onunload` never stops it twice. */
async function stopRoute(plugin: RoutePlugin): Promise<void> {
  const runtime = plugin.discoveryState;
  plugin.discoveryState = undefined;
  await runtime?.stop();
}

/**
 * Start and install a route for the running transport's port, or stop it
 * when the queue closed meanwhile.
 */
async function installRoute(
  plugin: RoutePlugin,
  startRoute: (transportPort: number) => Promise<DiscoveryRuntime>,
  stale: () => boolean,
): Promise<boolean> {
  if (stale()) throw new RouteQueueClosed();
  const port = routablePort(plugin);
  if (port === null) return false;
  const runtime = await startRoute(port);
  if (stale()) {
    await runtime.stop();
    throw new RouteQueueClosed();
  }
  plugin.discoveryState = runtime;
  return true;
}

/**
 * Start the vault's MCP transport and its route on load, or restart both,
 * for example after a new fixed port or server name. The route goes down
 * before the old port is released and comes back only once the new
 * transport listens. A failed setup leaves it down, and a failed route
 * start is logged without failing the transport. Only this vault's route
 * stops: a broker this vault hosts keeps serving the other vaults.
 */
export function restartTransport(
  plugin: RoutePlugin,
  steps: {
    /** Must not publish its port once `stale()` is true. */
    setup: (stale: () => boolean) => Promise<SetupResult>;
    teardown: (state: McpTransportState) => Promise<void>;
    startRoute: (transportPort: number) => Promise<DiscoveryRuntime>;
  },
): Promise<SetupResult> {
  return plugin.routeQueue.run(async (stale) => {
    await stopRoute(plugin);
    const previous = plugin.mcpTransportState;
    plugin.mcpTransportState = undefined;
    if (previous) await steps.teardown(previous);
    if (stale()) throw new RouteQueueClosed();
    const result = await steps.setup(stale);
    if (stale()) {
      if (result.success) await steps.teardown(result.state);
      throw new RouteQueueClosed();
    }
    if (!result.success) return result;
    plugin.mcpTransportState = result.state;
    try {
      await installRoute(plugin, steps.startRoute, stale);
    } catch (error) {
      if (error instanceof RouteQueueClosed) throw error;
      logger.warn("Broker route failed to start", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return result;
  });
}

/**
 * Stop this vault's route, apply `update` to its saved identity, such as a
 * confirmed move or a new identity for a copy, then start the route again
 * while the transport runs. Resolves whether a route started.
 */
export function replaceRoute(
  plugin: RoutePlugin,
  steps: {
    update?: () => Promise<void>;
    startRoute: (transportPort: number) => Promise<DiscoveryRuntime>;
  },
): Promise<boolean> {
  return plugin.routeQueue.run(async (stale) => {
    await stopRoute(plugin);
    await steps.update?.();
    return installRoute(plugin, steps.startRoute, stale);
  });
}
