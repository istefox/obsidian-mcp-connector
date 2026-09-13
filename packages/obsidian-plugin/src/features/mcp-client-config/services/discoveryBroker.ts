import { createHash, randomUUID } from "crypto";
import fsp from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { FileSystemAdapter } from "obsidian";
import { DISCOVERY_BROKER_SOURCE } from "../assets/discoveryBrokerSource";
import { readTokens } from "$/features/mcp-transport/services/tokenStore";
import { generateToken } from "$/features/mcp-transport/services/token";
import { logger } from "$/shared/logger";
import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";
import { detectNode, getDetectedNodePath } from "./nodeDetect";
import { codexServerId, type CodexConnection } from "./codexConfig";

export const DISCOVERY_BROKER_PORT = 27206;
export const DISCOVERY_PROTOCOL_VERSION = 2;
const DISCOVERY_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const DATA_KEY = "mcpClientConfig";
const SETTINGS_KEY = "codexDiscovery";
const BROKER_NAME = "obsidian-mcp-discovery-broker";
const ROUTE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DiscoverySettings = {
  enabled: boolean;
  routeId: string;
  accessToken: string;
  tokenId: string | null;
  dataPath?: string;
  serverId?: string;
};

type DiscoveryPlugin = PluginDataLike & {
  app: {
    vault: {
      adapter: unknown;
      configDir: string;
      getName(): string;
    };
  };
  manifest: { id: string };
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
  rootDir?: string;
  brokerPort?: number;
  dataPath?: string;
  ensureBroker?: (rootDir: string, port: number) => Promise<void>;
  connectRegistration?: (
    port: number,
    routeId: string,
    accessToken: string,
    leaseId: string,
    registration: Registration,
  ) => Promise<RegistrationControl>;
  reconnectMs?: number;
};

type Registration = {
  version: number;
  routeId: string;
  dataPath: string;
  tokenId: string | null;
  accessTokenHash: string;
  leaseId: string;
};

class RegistrationConflict extends Error {}

/**
 * Prefer the stable, human-readable vault-name id; fall back to the
 * route-derived id only when the vault name has no ASCII alphanumerics
 * (codexServerId(name) would otherwise throw). Never used where an id
 * derived from the route is the deliberate choice (e.g. identity reset).
 */
function safeCodexServerId(vaultName: string, routeId: string): string {
  try {
    return codexServerId(vaultName);
  } catch {
    return codexServerId(vaultName, routeId);
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
  plugin: DiscoveryPlugin,
): Promise<DiscoverySettings | null> {
  const slice = await new SettingsStore(plugin).readSlice(DATA_KEY);
  return parseSettings(isRecord(slice) ? slice[SETTINGS_KEY] : undefined);
}

async function updateSettings(
  plugin: DiscoveryPlugin,
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

export async function resolveCodexDiscoveryOwner(
  plugin: DiscoveryPlugin,
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
  if (!settings) return null;
  return {
    vaultName: plugin.app.vault.getName(),
    routeId: settings.routeId,
    accessToken: settings.accessToken,
    brokerPort: DISCOVERY_BROKER_PORT,
    serverId:
      settings.serverId ??
      safeCodexServerId(plugin.app.vault.getName(), settings.routeId),
  };
}

export async function enableCodexDiscovery(
  plugin: DiscoveryPlugin,
  tokenId: string,
  opts?: RuntimeOptions,
): Promise<DiscoveryRuntime> {
  const tokens = await readTokens(plugin);
  if (!tokens.some((token) => token.id === tokenId)) {
    throw new Error(`Token '${tokenId}' is no longer configured.`);
  }
  const settings = await updateSettings(plugin, (current) => ({
    ...current,
    enabled: true,
    routeId: current?.routeId ?? randomUUID(),
    accessToken: current?.accessToken ?? generateToken(),
    tokenId,
    serverId:
      current?.serverId ??
      (current
        ? safeCodexServerId(plugin.app.vault.getName(), current.routeId)
        : undefined),
  }));
  if (!settings.serverId) {
    settings.serverId = codexServerId(
      plugin.app.vault.getName(),
      settings.routeId,
    );
    await updateSettings(plugin, (current) => ({
      ...(current ?? settings),
      serverId: settings.serverId,
    }));
  }
  return startRuntime(plugin, settings, opts);
}

export async function startCodexDiscovery(
  plugin: DiscoveryPlugin,
  opts?: RuntimeOptions,
): Promise<DiscoveryRuntime | null> {
  const settings = await readSettings(plugin);
  if (!settings?.enabled || settings.tokenId === null) return null;
  const tokens = await readTokens(plugin);
  if (!tokens.some((token) => token.id === settings.tokenId)) return null;
  return startRuntime(plugin, settings, opts);
}

export async function disableCodexDiscovery(
  plugin: DiscoveryPlugin,
  runtime?: DiscoveryRuntime,
): Promise<void> {
  if (runtime) await runtime.stop();
  await updateSettings(plugin, (current) => ({
    ...current,
    enabled: false,
    routeId: current?.routeId ?? randomUUID(),
    accessToken: current?.accessToken ?? generateToken(),
    tokenId: current?.tokenId ?? null,
  }));
}

/** Rotate only this vault's broker identity; existing client configuration must be replaced */
export async function resetDiscoveryIdentity(
  plugin: DiscoveryPlugin,
  runtime?: DiscoveryRuntime,
  opts?: RuntimeOptions,
): Promise<DiscoveryRuntime | null> {
  await runtime?.stop();
  const dataPath = await canonicalDataPath(plugin, opts);
  const routeId = randomUUID();
  const settings = await updateSettings(plugin, (current) => ({
    enabled: current?.enabled ?? false,
    tokenId: current?.tokenId ?? null,
    routeId,
    accessToken: generateToken(),
    serverId: codexServerId(plugin.app.vault.getName(), routeId),
    dataPath,
  }));
  return settings.enabled && settings.tokenId !== null
    ? startRuntime(plugin, settings, opts)
    : null;
}

/** Explicitly accept a vault move without rotating identity or editing client configuration */
export async function acceptDiscoveryMove(
  plugin: DiscoveryPlugin,
  runtime?: DiscoveryRuntime,
  opts?: RuntimeOptions,
): Promise<DiscoveryRuntime | null> {
  await runtime?.stop();
  const current = await readSettings(plugin);
  if (!current) return null;
  const dataPath = await canonicalDataPath(plugin, opts);
  const settings = await updateSettings(plugin, (latest) => ({
    ...(latest ?? current),
    dataPath,
  }));
  return settings.enabled && settings.tokenId !== null
    ? startRuntime(plugin, settings, opts)
    : null;
}

async function canonicalDataPath(
  plugin: DiscoveryPlugin,
  opts?: RuntimeOptions,
): Promise<string> {
  const file = opts?.dataPath ?? resolveDataPath(plugin);
  const resolved = path.join(
    await fsp.realpath(path.dirname(file)),
    path.basename(file),
  );
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function brokerDirectory(): string {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ??
        path.join(os.homedir(), "AppData", "Local"))
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : (process.env.XDG_DATA_HOME ??
          path.join(os.homedir(), ".local", "share"));
  return path.join(base, "obsidian-mcp-connector", "broker-v2");
}

export async function releaseCodexDiscoveryOwner(
  plugin: DiscoveryPlugin,
  tokenId: string,
  runtime?: DiscoveryRuntime,
): Promise<boolean> {
  const current = await readSettings(plugin);
  if (!current || current.tokenId !== tokenId) return false;
  if (runtime) await runtime.stop();
  await updateSettings(plugin, () => ({
    ...current,
    enabled: false,
    tokenId: null,
  }));
  return true;
}

async function startRuntime(
  plugin: DiscoveryPlugin,
  settings: DiscoverySettings,
  opts?: RuntimeOptions,
): Promise<DiscoveryRuntime> {
  const rootDir = opts?.rootDir ?? brokerDirectory();
  const dataPath = await canonicalDataPath(plugin, opts);
  const brokerPort = opts?.brokerPort ?? DISCOVERY_BROKER_PORT;
  const leaseId = randomUUID();
  const ensureBrokerRunning = opts?.ensureBroker ?? ensureBroker;
  const openRegistration = opts?.connectRegistration ?? connectRegistration;
  const reconnectMs = opts?.reconnectMs ?? DISCOVERY_RECONNECT_MS;
  let stopped = false;
  let control: RegistrationControl | null = null;
  let recovery: Promise<void> | null = null;
  let cancelReconnectDelay: (() => void) | null = null;
  let status: DiscoveryStatus = { state: "connecting" };
  let currentDelay = reconnectMs;
  let lastLoggedMessage: string | null = null;
  const listeners = new Set<(status: DiscoveryStatus) => void>();
  const setStatus = (next: DiscoveryStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
  };

  const registration: Registration = {
    version: DISCOVERY_PROTOCOL_VERSION,
    routeId: settings.routeId,
    dataPath,
    tokenId: settings.tokenId,
    accessTokenHash: createHash("sha256")
      .update(settings.accessToken, "utf8")
      .digest("hex"),
    leaseId,
  };

  const establishControl = async () => {
    await ensureBrokerRunning(rootDir, brokerPort);
    if (stopped) return;
    const next = await openRegistration(
      brokerPort,
      settings.routeId,
      settings.accessToken,
      leaseId,
      registration,
    );
    if (stopped) {
      next.close();
      await next.closed;
      return;
    }
    control = next;
    currentDelay = reconnectMs;
    lastLoggedMessage = null;
    setStatus({ state: "connected" });
    void next.closed.then(() => {
      if (control === next) control = null;
      if (!stopped) scheduleRecovery();
    });
  };

  async function recover(): Promise<void> {
    while (!stopped && control === null) {
      try {
        await establishControl();
        return;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Connection failed";
        if (error instanceof RegistrationConflict) {
          setStatus({ state: "conflict", message });
          return;
        }
        setStatus({ state: "retrying", message });
        // Log on every distinct failure reason, not just the first, so a
        // changing cause during a long outage is still visible in the logs.
        if (message !== lastLoggedMessage) {
          logger.warn("Codex discovery connection recovery failed", {
            error: message,
          });
          lastLoggedMessage = message;
        }
        if (!stopped) {
          await waitToReconnect(currentDelay);
          currentDelay = Math.min(currentDelay * 2, MAX_RECONNECT_MS);
        }
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

  function scheduleRecovery(): void {
    if (stopped || recovery !== null) return;
    setStatus({ state: "retrying" });
    recovery = recover().finally(() => {
      recovery = null;
      if (!stopped && control === null && status.state !== "conflict")
        scheduleRecovery();
    });
  }

  const runtime: DiscoveryRuntime = {
    routeId: settings.routeId,
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
    setStatus({
      state: "conflict",
      locationChanged: true,
      message:
        "Vault location changed. Confirm a move or create a new identity for this copy",
    });
    return runtime;
  }
  if (!settings.dataPath || !settings.serverId) {
    const fallbackServerId = safeCodexServerId(
      plugin.app.vault.getName(),
      settings.routeId,
    );
    settings = await updateSettings(plugin, (current) => ({
      ...(current ?? settings),
      dataPath,
      serverId: (current ?? settings).serverId ?? fallbackServerId,
    }));
  }
  try {
    await establishControl();
  } catch (error) {
    if (error instanceof RegistrationConflict)
      setStatus({ state: "conflict", message: error.message });
    else scheduleRecovery();
  }
  return runtime;
}

async function connectRegistration(
  port: number,
  routeId: string,
  accessToken: string,
  leaseId: string,
  registration: Registration,
): Promise<RegistrationControl> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const body = JSON.stringify(registration);
    const deadline = window.setTimeout(() => {
      request.destroy(new Error("Broker registration timed out"));
    }, 2_000);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/_obsidian_mcp_broker/register/${routeId}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "x-obsidian-mcp-lease-id": leaseId,
        },
      },
      (response) => {
        window.clearTimeout(deadline);
        if (response.statusCode !== 200) {
          response.destroy();
          reject(
            response.statusCode === 409
              ? new RegistrationConflict(
                  "This identity is already in use by another open vault. Reset the copied vault's connection identity",
                )
              : new Error(
                  `Discovery broker rejected registration with HTTP ${response.statusCode ?? 0}`,
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

function resolveDataPath(plugin: DiscoveryPlugin): string {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error("Codex discovery requires a desktop vault.");
  }
  return path.join(
    adapter.getBasePath(),
    plugin.app.vault.configDir,
    "plugins",
    plugin.manifest.id,
    "data.json",
  );
}

type ProbeResult = "healthy" | "free" | "occupied" | "incompatible";

async function probeBroker(port: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const finish = (result: ProbeResult) => {
      window.clearTimeout(deadline);
      resolve(result);
    };
    const deadline = window.setTimeout(() => {
      req.destroy();
      finish("occupied");
    }, 750);
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/_obsidian_mcp_broker/health",
        timeout: 400,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
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
                value.version === DISCOVERY_PROTOCOL_VERSION
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
    req.on("timeout", () => {
      req.destroy();
      finish("occupied");
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "free" : "occupied");
    });
  });
}

async function ensureBroker(rootDir: string, port: number): Promise<void> {
  const initial = await probeBroker(port);
  if (initial === "healthy") return;
  if (initial === "incompatible") {
    throw new Error(
      "An older broker is running. Update the plugin in the open vaults, close their connections, then retry. No process was replaced",
    );
  }
  if (initial === "occupied") {
    throw new Error(`Port ${port} is in use by another process.`);
  }

  const node = await detectNode();
  const nodePath = getDetectedNodePath();
  if (!node.found || nodePath === null) {
    throw new Error("Node.js is required for the shared discovery broker.");
  }
  await ensurePrivateDirectory(rootDir);
  const scriptPath = path.join(rootDir, "discoveryBroker.js");
  await writeBrokerSource(scriptPath);
  const child = spawn(
    nodePath,
    [scriptPath, "--root", rootDir, "--port", String(port)],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  let spawnError: Error | null = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const failure = spawnError;
    if (failure) throw failure;
    const result = await probeBroker(port);
    if (result === "healthy") return;
    if (result === "occupied") break;
  }
  throw new Error(`The discovery broker did not start on port ${port}.`);
}

async function writeBrokerSource(scriptPath: string): Promise<void> {
  try {
    if ((await fsp.readFile(scriptPath, "utf8")) === DISCOVERY_BROKER_SOURCE)
      return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await ensurePrivateDirectory(path.dirname(scriptPath));
  const tempPath = `${scriptPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, DISCOVERY_BROKER_SOURCE, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fsp.rename(tempPath, scriptPath);
  } finally {
    await fsp.rm(tempPath, { force: true });
  }
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await fsp.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Discovery path is not a private directory: ${directoryPath}`,
    );
  }
  try {
    await fsp.chmod(directoryPath, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows enforces access through ACLs rather than POSIX mode bits.
  }
}
