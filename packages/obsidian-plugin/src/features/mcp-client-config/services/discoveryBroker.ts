import { randomUUID } from "crypto";
import fsp from "fs/promises";
import http from "http";
import path from "path";
import { FileSystemAdapter, Notice } from "obsidian";
import { BIND_HOST, BROKER_PORT } from "$/features/mcp-transport/constants";
import { generateToken } from "$/features/mcp-transport/services/token";
import { logger } from "$/shared/logger";
import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";
import {
  BROKER_NAME,
  BROKER_PROTOCOL_VERSION,
  diagnosePluginDataFile,
  HEALTH_PATH,
  LEASE_HEADER,
  REGISTRATION_PATH,
  startBrokerServer,
  type BrokerRegistration,
  type BrokerServer,
} from "./brokerServer";
import type { CodexConnection } from "./codexConfig";
import { vaultServerId } from "./generators";

const DISCOVERY_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const FAILOVER_JITTER_MIN_MS = 50;
const FAILOVER_JITTER_MAX_MS = 250;
// The storage key predates routes for every client. It is kept so existing
// routes and credentials survive without a data migration. Older versions
// also stored `enabled` and `tokenId` for a Codex credential swap and a
// `serverId` Codex entry name: they are kept on disk but ignored.
const DATA_KEY = "mcpClientConfig";
const SETTINGS_KEY = "codexDiscovery";
const ROUTE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DiscoverySettings = {
  routeId: string;
  /** The route credential. Only registration presents it, never a client. */
  accessToken: string;
  dataPath?: string;
};

/** A plugin whose own `data.json` location can be resolved. */
export type LocatedPlugin = PluginDataLike & {
  app: {
    vault: {
      adapter: unknown;
      configDir: string;
    };
  };
  manifest: { id: string };
};

type DiscoveryPlugin = LocatedPlugin & {
  app: { vault: { getName(): string } };
};

export type DiscoveryRuntime = {
  routeId: string;
  /**
   * The vault transport port this route registers, which is also the
   * vault's direct address while the broker cannot reach it.
   */
  readonly transportPort: number;
  readonly status: DiscoveryStatus;
  subscribe(listener: (status: DiscoveryStatus) => void): () => void;
  stop(): Promise<void>;
};

export type DiscoveryStatus = {
  /**
   * `retrying` follows a transient failure or a dropped control
   * connection, such as a failover between hosting vaults, so the broker
   * is expected to reach this vault again on its own. `rejected` (the
   * broker refused the registration) and `unavailable` (no compatible
   * broker can run on its port) keep retrying with backoff, but need the
   * user to act, like `conflict`, which stops retrying.
   */
  state:
    | "connecting"
    | "connected"
    | "retrying"
    | "rejected"
    | "unavailable"
    | "conflict"
    | "stopped";
  message?: string;
  locationChanged?: boolean;
};

type RegistrationControl = {
  close(): void;
  closed: Promise<void>;
};

type RuntimeOptions = {
  /** The plugin's broker host, shared by every runtime it starts. */
  host: BrokerHost;
  /**
   * The vault's running MCP transport port, sent with every registration of
   * this runtime. The broker forwards the route there. A transport restart
   * stops the runtime and starts a new one with the new port.
   */
  transportPort: number;
  dataPath?: string;
  connectRegistration?: (
    port: number,
    routeId: string,
    credential: string,
    leaseId: string,
    registration: BrokerRegistration,
  ) => Promise<RegistrationControl>;
  reconnectMs?: number;
  /** Delay before re-electing after a dropped control connection. */
  failoverDelayMs?: () => number;
  /** Shows a message the user has to act on. Defaults to a Notice. */
  notify?: (message: string) => void;
};

class RegistrationConflict extends Error {}

/** The broker port is held by something this plugin cannot reuse. */
class BrokerUnavailable extends Error {}

/** The broker refused the registration with `401` or `403`. */
class RegistrationRejected extends Error {
  constructor(
    readonly status: number,
    message = `The shared broker rejected registration with HTTP ${status}`,
  ) {
    super(message);
  }
}

/**
 * What the route status and its Notice say about a refused registration.
 * The broker answers every refusal with a bare `401`, so the vault runs
 * the broker's own checks on its data file to name the cause.
 */
async function rejectionMessage(
  status: number,
  dataPath: string,
  pluginId: string,
): Promise<string> {
  const reason = await diagnosePluginDataFile(dataPath, pluginId);
  const cause = reason
    ? `The shared broker refused this vault's route: ${reason}`
    : `The shared broker refused this vault's route with HTTP ${status}, for a reason this vault cannot check, such as a route credential that changed meanwhile or another open vault running a different MCP Connector build`;
  return `${cause}. Until that is fixed, client configs that use the broker cannot reach this vault, and the copy buttons in Access Control give its direct address instead`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(value: unknown): DiscoverySettings | null {
  if (!isRecord(value)) return null;
  const { routeId, accessToken } = value;
  if (typeof routeId !== "string" || !ROUTE_PATTERN.test(routeId)) return null;
  if (typeof accessToken !== "string" || Buffer.byteLength(accessToken) < 32)
    return null;
  return {
    routeId,
    accessToken,
    ...(typeof value.dataPath === "string" ? { dataPath: value.dataPath } : {}),
  };
}

async function readSettings(
  plugin: PluginDataLike,
): Promise<DiscoverySettings | null> {
  const slice = await new SettingsStore(plugin).readSlice(DATA_KEY);
  return parseSettings(isRecord(slice) ? slice[SETTINGS_KEY] : undefined);
}

async function updateSettings(
  plugin: PluginDataLike,
  recipe: (current: DiscoverySettings | null) => DiscoverySettings,
): Promise<DiscoverySettings> {
  let result!: DiscoverySettings;
  await new SettingsStore(plugin).updateSlice(DATA_KEY, (current) => {
    const slice = isRecord(current) ? current : {};
    const stored = slice[SETTINGS_KEY];
    result = recipe(parseSettings(stored));
    // Unknown keys stay, so no write migrates the stored settings
    return {
      ...slice,
      [SETTINGS_KEY]: { ...(isRecord(stored) ? stored : {}), ...result },
    };
  });
  return result;
}

/** A new route identity. */
function mintSettings(dataPath: string): DiscoverySettings {
  return { routeId: randomUUID(), accessToken: generateToken(), dataPath };
}

/**
 * The Codex entry for one token row: that row's vault token, sent to `url`
 * from resolveClientEndpoint, under the same per-vault key as every other
 * client config, so a new snippet replaces this vault's existing entry.
 */
export function getCodexConnection(
  plugin: DiscoveryPlugin,
  token: string,
  url: string,
): CodexConnection {
  return {
    serverId: vaultServerId(plugin.app.vault.getName()),
    accessToken: token,
    url,
  };
}

/**
 * Rotate this vault's whole broker identity in its saved settings: route
 * and route credential. Every client config that uses the broker must be
 * replaced. Run with the route stopped, see replaceRoute.
 */
export async function resetDiscoveryIdentity(
  plugin: DiscoveryPlugin,
  opts?: { dataPath?: string },
): Promise<void> {
  const dataPath = await canonicalDataPath(plugin, opts);
  await updateSettings(plugin, () => mintSettings(dataPath));
}

/**
 * Explicitly accept a vault move in the saved settings without rotating
 * identity or editing client configuration. Run with the route stopped,
 * see replaceRoute.
 */
export async function acceptDiscoveryMove(
  plugin: DiscoveryPlugin,
  opts?: { dataPath?: string },
): Promise<void> {
  const dataPath = await canonicalDataPath(plugin, opts);
  await updateSettings(plugin, (latest) =>
    latest ? { ...latest, dataPath } : mintSettings(dataPath),
  );
}

/**
 * True while the saved route belongs to another location: The vault was
 * moved or copied, and neither a confirmed move nor a new identity has
 * resolved it. Read from the saved settings, so it holds whether or not a
 * route runs. Fails closed when the location cannot be read.
 */
export async function isLocationUnresolved(
  plugin: LocatedPlugin,
  opts?: { dataPath?: string },
): Promise<boolean> {
  const saved = (await readSettings(plugin))?.dataPath;
  if (saved === undefined) return false;
  try {
    return saved !== (await canonicalDataPath(plugin, opts));
  } catch {
    return true;
  }
}

/**
 * The `data.json` path this vault registers and saves with its route.
 * Links are resolved up to the `plugins` folder, so a vault opened through
 * an alias keeps its saved location. The plugin folder and file names are
 * appended unresolved: A plugin folder linked elsewhere, as `bun run link`
 * creates, would otherwise lose the plugin ID the broker requires in the
 * path. For a plugin folder that is no link the result is the same as
 * resolving the whole folder.
 */
async function canonicalDataPath(
  plugin: LocatedPlugin,
  opts?: { dataPath?: string },
): Promise<string> {
  const file = opts?.dataPath ?? resolveDataPath(plugin);
  const pluginDir = path.dirname(file);
  const resolved = path.join(
    await fsp.realpath(path.dirname(pluginDir)),
    path.basename(pluginDir),
    path.basename(file),
  );
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Register this vault's route with the shared broker and keep it
 * registered. Every vault has a route, minted on first start.
 */
export async function startDiscovery(
  plugin: DiscoveryPlugin,
  opts: RuntimeOptions,
): Promise<DiscoveryRuntime> {
  const dataPath = await canonicalDataPath(plugin, opts);
  const settings =
    (await readSettings(plugin)) ??
    (await updateSettings(
      plugin,
      (current) => current ?? mintSettings(dataPath),
    ));
  return startRuntime(plugin, settings, dataPath, opts);
}

function failoverJitter(): number {
  return (
    FAILOVER_JITTER_MIN_MS +
    Math.floor(
      Math.random() * (FAILOVER_JITTER_MAX_MS - FAILOVER_JITTER_MIN_MS + 1),
    )
  );
}

async function startRuntime(
  plugin: DiscoveryPlugin,
  settings: DiscoverySettings,
  dataPath: string,
  opts: RuntimeOptions,
): Promise<DiscoveryRuntime> {
  const { host } = opts;
  const routeId = settings.routeId;
  const leaseId = randomUUID();
  const openRegistration = opts.connectRegistration ?? connectRegistration;
  const reconnectMs = opts.reconnectMs ?? DISCOVERY_RECONNECT_MS;
  const failoverDelay = opts.failoverDelayMs ?? failoverJitter;
  const notify =
    opts.notify ??
    ((message: string) => new Notice(`MCP Connector: ${message}`));
  let stopped = false;
  let control: RegistrationControl | null = null;
  let recovery: Promise<void> | null = null;
  let cancelReconnectDelay: (() => void) | null = null;
  let status: DiscoveryStatus = { state: "connecting" };
  let backoff = reconnectMs;
  let lastLoggedMessage: string | null = null;
  const notified = new Set<DiscoveryStatus["state"]>();
  const listeners = new Set<(status: DiscoveryStatus) => void>();
  const setStatus = (next: DiscoveryStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
  };

  const registration: BrokerRegistration = {
    version: BROKER_PROTOCOL_VERSION,
    routeId,
    dataPath,
    leaseId,
    port: opts.transportPort,
  };

  const establishControl = async () => {
    await host.ensure();
    if (stopped) return;
    // Read on every attempt, so a changed route fails instead of
    // registering with a stale credential.
    const current = await readSettings(plugin);
    if (current?.routeId !== routeId) {
      throw new Error(
        "This vault's broker route changed. Retry the connection",
      );
    }
    const next = await openRegistration(
      host.port,
      routeId,
      current.accessToken,
      leaseId,
      registration,
    ).catch(async (error: unknown) => {
      if (!(error instanceof RegistrationRejected)) throw error;
      throw new RegistrationRejected(
        error.status,
        await rejectionMessage(error.status, dataPath, plugin.manifest.id),
      );
    });
    if (stopped) {
      next.close();
      await next.closed;
      return;
    }
    control = next;
    backoff = reconnectMs;
    lastLoggedMessage = null;
    setStatus({ state: "connected" });
    void next.closed.then(() => {
      if (control === next) control = null;
      // The host may have gone: re-elect promptly, with jitter so the
      // remaining vaults do not all race for the port at once.
      if (!stopped) scheduleRecovery(failoverDelay());
    });
  };

  function nextDelay(): number {
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_RECONNECT_MS);
    return delay;
  }

  function recordFailure(error: unknown): void {
    if (stopped) return;
    const message =
      error instanceof Error ? error.message : "Connection failed";
    if (error instanceof RegistrationConflict) {
      setStatus({ state: "conflict", message });
      return;
    }
    // Both leave the broker unable to reach this vault until the user acts,
    // so each raises one Notice per runtime. Retries go on, so fixing the
    // cause recovers without a reload.
    const state =
      error instanceof RegistrationRejected
        ? "rejected"
        : error instanceof BrokerUnavailable
          ? "unavailable"
          : "retrying";
    // A transient failure says nothing about a cause the user must fix, so
    // the refusal and its message hold until a registration succeeds.
    // Showing `retrying` would hand out the dead route URL meanwhile.
    const holdsForUser =
      status.state === "rejected" || status.state === "unavailable";
    if (state !== "retrying" || !holdsForUser) setStatus({ state, message });
    if (state !== "retrying" && !notified.has(state)) {
      notified.add(state);
      notify(message);
    }
    // Log on every distinct failure reason, not just the first, so a
    // changing cause during a long outage is still visible in the logs.
    if (message !== lastLoggedMessage) {
      logger.warn("Broker connection recovery failed", { error: message });
      lastLoggedMessage = message;
    }
  }

  async function recover(firstDelay: number): Promise<void> {
    let delay = firstDelay;
    while (!stopped && control === null) {
      await waitToReconnect(delay);
      if (stopped) return;
      try {
        await establishControl();
        return;
      } catch (error) {
        recordFailure(error);
        if (status.state === "conflict") return;
        delay = nextDelay();
      }
    }
  }

  function waitToReconnect(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        cancelReconnectDelay = null;
        resolve();
      }, delayMs);
      cancelReconnectDelay = () => {
        window.clearTimeout(timer);
        cancelReconnectDelay = null;
        resolve();
      };
    });
  }

  function scheduleRecovery(firstDelay: number): void {
    if (stopped || recovery !== null) return;
    // A dropped control. After a failed first attempt the status already
    // names the failure, which the user needs while the retry waits.
    if (status.state === "connected") setStatus({ state: "retrying" });
    recovery = recover(firstDelay).finally(() => {
      recovery = null;
      // Only a control that dropped before this recovery settled gets
      // here, so it fails over like any other dropped control.
      if (!stopped && control === null && status.state !== "conflict")
        scheduleRecovery(failoverDelay());
    });
  }

  const runtime: DiscoveryRuntime = {
    routeId,
    transportPort: opts.transportPort,
    get status() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(status);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Closes the control connection and cancels any retry before its first await. */
    async stop() {
      if (stopped) return;
      stopped = true;
      cancelReconnectDelay?.();
      const currentControl = control;
      control = null;
      currentControl?.close();
      if (currentControl) await currentControl.closed;
      if (recovery) await recovery;
      setStatus({ state: "stopped" });
      listeners.clear();
    },
  };
  if (settings.dataPath && settings.dataPath !== dataPath) {
    const message =
      "Vault location changed. Confirm a move or make this copy independent";
    setStatus({ state: "conflict", locationChanged: true, message });
    notify(
      `${message} in Access Control. Until then, client configs that use the shared broker cannot reach this vault`,
    );
    return runtime;
  }
  if (!settings.dataPath) {
    await updateSettings(plugin, (current) => ({
      ...(current ?? settings),
      dataPath,
    }));
  }
  try {
    await establishControl();
  } catch (error) {
    recordFailure(error);
    if (status.state !== "conflict") scheduleRecovery(nextDelay());
  }
  return runtime;
}

async function connectRegistration(
  port: number,
  routeId: string,
  credential: string,
  leaseId: string,
  registration: BrokerRegistration,
): Promise<RegistrationControl> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const body = JSON.stringify(registration);
    const deadline = window.setTimeout(() => {
      request.destroy(new Error("Broker registration timed out"));
    }, 2_000);
    const request = http.request(
      {
        host: BIND_HOST,
        port,
        path: `${REGISTRATION_PATH}/${routeId}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          [LEASE_HEADER]: leaseId,
        },
      },
      (response) => {
        window.clearTimeout(deadline);
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.destroy();
          reject(
            status === 409
              ? new RegistrationConflict(
                  "This vault's broker route is already in use by another open vault. In the copied vault, use Make this copy independent. Vaults that share one plugin folder cannot both use its route",
                )
              : status === 401 || status === 403
                ? new RegistrationRejected(status)
                : new Error(
                    `The shared broker rejected registration with HTTP ${status}`,
                  ),
          );
          return;
        }
        request.setTimeout(0);
        response.resume();
        let closed = false;
        let markClosed!: () => void;
        const closedPromise = new Promise<void>((resolveClosed) => {
          markClosed = () => {
            if (closed) return;
            closed = true;
            resolveClosed();
          };
        });
        response.once("close", markClosed);
        response.once("error", markClosed);
        settled = true;
        resolve({
          close() {
            response.destroy();
            request.destroy();
          },
          closed: closedPromise,
        });
      },
    );
    request.once("error", (error) => {
      window.clearTimeout(deadline);
      if (!settled) reject(error);
    });
    request.end(body);
  });
}

function resolveDataPath(plugin: LocatedPlugin): string {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error("The shared broker requires a desktop vault.");
  }
  return path.join(
    adapter.getBasePath(),
    plugin.app.vault.configDir,
    "plugins",
    plugin.manifest.id,
    "data.json",
  );
}

// ---------------------------------------------------------------------------
// Broker hosting
// ---------------------------------------------------------------------------

export type BrokerHost = {
  readonly port: number;
  /** True while this vault's renderer serves the broker. */
  readonly hosting: boolean;
  /**
   * Make sure a compatible broker answers on `port`: reuse a healthy one,
   * or host it when the port is free. Concurrent calls share one attempt.
   */
  ensure(): Promise<void>;
  /**
   * Stop hosting and cancel any election in progress. The listener starts
   * closing before this returns; the promise settles once it is gone.
   */
  close(): Promise<void>;
};

type ProbeResult = "healthy" | "free" | "occupied" | "incompatible";

/**
 * One per plugin instance, so restarting a vault's route (retry, move,
 * reset) never takes the broker away from the other vaults. `pluginId` is
 * the manifest ID, which every registered `data.json` path must name.
 */
export function createBrokerHost(opts: {
  pluginId: string;
  port?: number;
}): BrokerHost {
  const port = opts.port ?? BROKER_PORT;
  let hosted: BrokerServer | null = null;
  let election: Promise<void> | null = null;
  let closed = false;
  const cancelProbes = new Set<() => void>();
  const closedError = () => new Error("The broker host was closed");

  async function elect(): Promise<void> {
    let result = await probeBroker(port, cancelProbes);
    if (closed) throw closedError();
    if (result === "free") {
      try {
        const server = await startBrokerServer({
          port,
          pluginId: opts.pluginId,
        });
        if (closed) {
          await server.close();
          throw closedError();
        }
        hosted = server;
        void server.closed.then(() => {
          if (hosted === server) hosted = null;
        });
        logger.info("Hosting the shared MCP broker", { port });
        return;
      } catch (error) {
        if (closed) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") {
          throw new BrokerUnavailable(
            `The shared broker could not listen on port ${port} (${code ?? String(error)}). Client configs that use it cannot connect. Direct vault ports keep working`,
          );
        }
        // Another vault bound the port between the probe and this listen
        result = await probeBroker(port, cancelProbes);
        if (closed) throw closedError();
      }
    }
    if (result === "healthy") return;
    throw new BrokerUnavailable(
      result === "incompatible"
        ? "Another open vault runs the shared broker with a different MCP Connector version. Update the plugin in every open vault. Direct vault ports keep working"
        : `Port ${port} is used by another program or by a vault server, such as a vault running an older MCP Connector version or a vault whose fixed port is ${port}. Client configs that use the shared broker cannot connect until it is free: Update or close that vault, or change its fixed port. Direct vault ports keep working`,
    );
  }

  return {
    port,
    get hosting() {
      return hosted !== null;
    },
    ensure() {
      if (closed) return Promise.reject(closedError());
      if (hosted) return Promise.resolve();
      election ??= elect().finally(() => {
        election = null;
      });
      return election;
    },
    close() {
      closed = true;
      for (const cancel of [...cancelProbes]) cancel();
      const server = hosted;
      hosted = null;
      const pending = election;
      return Promise.all([
        server?.close(),
        // A listen still in flight closes its server before settling
        pending?.catch(() => undefined),
      ]).then(() => undefined);
    },
  };
}

function probeBroker(
  port: number,
  cancels: Set<() => void>,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      cancels.delete(cancel);
      resolve(result);
    };
    const req = http.get(
      {
        host: BIND_HOST,
        port,
        path: HEALTH_PATH,
        timeout: 400,
        // A pooled socket would outlive the probe, and the broker it reached
        headers: { connection: "close" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 4096) {
            res.destroy();
            finish("occupied");
          }
        });
        res.on("error", () => finish("occupied"));
        res.on("aborted", () => finish("occupied"));
        res.on("end", () => {
          try {
            const value: unknown = JSON.parse(body);
            finish(
              res.statusCode === 200 &&
                isRecord(value) &&
                value.name === BROKER_NAME &&
                value.version === BROKER_PROTOCOL_VERSION
                ? "healthy"
                : isRecord(value) && value.name === BROKER_NAME
                  ? "incompatible"
                  : "occupied",
            );
          } catch {
            finish("occupied");
          }
        });
      },
    );
    const cancel = () => {
      req.destroy();
      finish("occupied");
    };
    const deadline = window.setTimeout(cancel, 750);
    cancels.add(cancel);
    req.on("timeout", cancel);
    req.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "free" : "occupied");
    });
  });
}
