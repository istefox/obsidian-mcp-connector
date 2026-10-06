import { randomUUID } from "crypto";
import fsp from "fs/promises";
import http from "http";
import path from "path";
import { FileSystemAdapter, Notice } from "obsidian";
import { BIND_HOST, BROKER_PORT } from "$/features/mcp-transport/constants";
import { readTokens } from "$/features/mcp-transport/services/tokenStore";
import { generateToken } from "$/features/mcp-transport/services/token";
import { logger } from "$/shared/logger";
import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";
import {
  BROKER_NAME,
  BROKER_PROTOCOL_VERSION,
  HEALTH_PATH,
  LEASE_HEADER,
  REGISTRATION_PATH,
  startBrokerServer,
  type BrokerRegistration,
  type BrokerServer,
} from "./brokerServer";
import { codexServerId, type CodexConnection } from "./codexConfig";

const DISCOVERY_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const FAILOVER_JITTER_MIN_MS = 50;
const FAILOVER_JITTER_MAX_MS = 250;
// The storage key predates routes for every client. It is kept so existing
// routes, credentials and Codex entries survive without a data migration.
const DATA_KEY = "mcpClientConfig";
const SETTINGS_KEY = "codexDiscovery";
const ROUTE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DiscoverySettings = {
  /** Codex credential swap on; the route exists either way. */
  enabled: boolean;
  routeId: string;
  /** The route credential, also the Codex bearer. */
  accessToken: string;
  tokenId: string | null;
  dataPath?: string;
  serverId?: string;
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
  readonly status: DiscoveryStatus;
  subscribe(listener: (status: DiscoveryStatus) => void): () => void;
  stop(): Promise<void>;
};

export type DiscoveryStatus = {
  state: "connecting" | "connected" | "retrying" | "conflict" | "stopped";
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

/**
 * Add the vault name to old UUID-only keys while preserving other saved keys.
 * Settings without a saved key retain their legacy vault-name form, falling
 * back to the route when the name contains no ASCII alphanumerics.
 */
function storedCodexServerId(
  vaultName: string,
  settings: DiscoverySettings,
): string {
  const opaqueId = `obsidian_${settings.routeId.replace(/-/g, "")}`;
  if (settings.serverId) {
    return settings.serverId === opaqueId
      ? codexServerId(vaultName, settings.routeId)
      : settings.serverId;
  }
  try {
    return codexServerId(vaultName);
  } catch {
    return codexServerId(vaultName, settings.routeId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(value: unknown): DiscoverySettings | null {
  if (!isRecord(value)) return null;
  const enabled = value.enabled === true;
  const { routeId, accessToken, tokenId } = value;
  if (typeof routeId !== "string" || !ROUTE_PATTERN.test(routeId)) return null;
  if (typeof accessToken !== "string" || Buffer.byteLength(accessToken) < 32)
    return null;
  if (tokenId !== null && (typeof tokenId !== "string" || tokenId.length === 0))
    return null;
  return {
    enabled,
    routeId,
    accessToken,
    tokenId,
    ...(typeof value.dataPath === "string" ? { dataPath: value.dataPath } : {}),
    ...(typeof value.serverId === "string" ? { serverId: value.serverId } : {}),
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
    result = recipe(parseSettings(slice[SETTINGS_KEY]));
    return { ...slice, [SETTINGS_KEY]: result };
  });
  return result;
}

/** A new route identity with the Codex swap off and its entry name ready. */
function mintSettings(vaultName: string, dataPath: string): DiscoverySettings {
  const routeId = randomUUID();
  return {
    enabled: false,
    routeId,
    accessToken: generateToken(),
    tokenId: null,
    serverId: codexServerId(vaultName, routeId),
    dataPath,
  };
}

export async function resolveCodexDiscoveryOwner(
  plugin: PluginDataLike,
): Promise<string | null> {
  const settings = await readSettings(plugin);
  if (!settings?.enabled || settings.tokenId === null) return null;
  const tokens = await readTokens(plugin);
  return tokens.some((token) => token.id === settings.tokenId)
    ? settings.tokenId
    : null;
}

export async function getCodexConnection(
  plugin: DiscoveryPlugin,
): Promise<CodexConnection | null> {
  const settings = await readSettings(plugin);
  if (!settings?.serverId) return null;
  return {
    vaultName: plugin.app.vault.getName(),
    routeId: settings.routeId,
    accessToken: settings.accessToken,
    brokerPort: BROKER_PORT,
    serverId: settings.serverId,
  };
}

/**
 * Let the Codex credential stand in for `tokenId` on this vault's route.
 * The broker reads this per request, so no connection restarts.
 */
export async function enableCodexDiscovery(
  plugin: DiscoveryPlugin,
  tokenId: string,
): Promise<void> {
  const tokens = await readTokens(plugin);
  if (!tokens.some((token) => token.id === tokenId)) {
    throw new Error(`Token '${tokenId}' is no longer configured.`);
  }
  await updateSettings(plugin, (current) => {
    const routeId = current?.routeId ?? randomUUID();
    return {
      ...current,
      enabled: true,
      routeId,
      accessToken: current?.accessToken ?? generateToken(),
      tokenId,
      serverId: current
        ? current.serverId
        : codexServerId(plugin.app.vault.getName(), routeId),
    };
  });
}

/** Turn off only the Codex credential swap. The route stays for every other client */
export async function disableCodexDiscovery(
  plugin: PluginDataLike,
): Promise<void> {
  await updateSettings(plugin, (current) => ({
    ...current,
    enabled: false,
    routeId: current?.routeId ?? randomUUID(),
    accessToken: current?.accessToken ?? generateToken(),
    tokenId: current?.tokenId ?? null,
  }));
}

/**
 * Replace only the Codex credential. The route, its address and every other
 * client config stay, and the installed Codex entry needs the new value
 */
export async function resetCodexCredential(
  plugin: PluginDataLike,
): Promise<void> {
  await updateSettings(plugin, (current) => {
    if (!current) {
      throw new Error(
        "This vault has no broker route yet. Retry the connection first",
      );
    }
    return { ...current, accessToken: generateToken() };
  });
}

/**
 * Rotate this vault's whole broker identity in its saved settings: route,
 * credential and Codex entry name. Every client config that uses the
 * broker must be replaced. Run with the route stopped, see replaceRoute.
 */
export async function resetDiscoveryIdentity(
  plugin: DiscoveryPlugin,
  opts?: { dataPath?: string },
): Promise<void> {
  const dataPath = await canonicalDataPath(plugin, opts);
  const routeId = randomUUID();
  await updateSettings(plugin, (current) => ({
    enabled: current?.enabled ?? false,
    tokenId: current?.tokenId ?? null,
    routeId,
    accessToken: generateToken(),
    serverId: codexServerId(plugin.app.vault.getName(), routeId),
    dataPath,
  }));
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
    latest
      ? { ...latest, dataPath }
      : mintSettings(plugin.app.vault.getName(), dataPath),
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

async function canonicalDataPath(
  plugin: LocatedPlugin,
  opts?: { dataPath?: string },
): Promise<string> {
  const file = opts?.dataPath ?? resolveDataPath(plugin);
  const resolved = path.join(
    await fsp.realpath(path.dirname(file)),
    path.basename(file),
  );
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function releaseCodexDiscoveryOwner(
  plugin: PluginDataLike,
  tokenId: string,
): Promise<boolean> {
  const current = await readSettings(plugin);
  if (!current || current.tokenId !== tokenId) return false;
  await updateSettings(plugin, () => ({
    ...current,
    enabled: false,
    tokenId: null,
  }));
  return true;
}

/**
 * Register this vault's route with the shared broker and keep it
 * registered. Every vault has a route, minted on first start, whether or
 * not Codex is enabled.
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
      (current) =>
        current ?? mintSettings(plugin.app.vault.getName(), dataPath),
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
  let notified = false;
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
    // Read on every attempt: a Codex credential reset rotates the route
    // credential without restarting this runtime.
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
    );
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
    setStatus({ state: "retrying", message });
    if (error instanceof BrokerUnavailable && !notified) {
      notified = true;
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
    setStatus({ state: "retrying" });
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
  const serverId = storedCodexServerId(plugin.app.vault.getName(), settings);
  if (!settings.dataPath || settings.serverId !== serverId) {
    await updateSettings(plugin, (current) => ({
      ...(current ?? settings),
      dataPath,
      serverId: storedCodexServerId(
        plugin.app.vault.getName(),
        current ?? settings,
      ),
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
        if (response.statusCode !== 200) {
          response.destroy();
          reject(
            response.statusCode === 409
              ? new RegistrationConflict(
                  "This vault's broker route is already in use by another open vault. In the copied vault, use Make this copy independent",
                )
              : new Error(
                  `The shared broker rejected registration with HTTP ${response.statusCode ?? 0}`,
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
