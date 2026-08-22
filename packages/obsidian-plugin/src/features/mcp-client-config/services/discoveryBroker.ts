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
import type { CodexConnection } from "./codexConfig";

export const DISCOVERY_BROKER_PORT = 27206;
export const DISCOVERY_PROTOCOL_VERSION = 1;
const DISCOVERY_RECONNECT_MS = 1_000;
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
  stop(): Promise<void>;
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
  ) => Promise<RegistrationControl>;
  reconnectMs?: number;
};

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
  return { enabled, routeId, accessToken, tokenId };
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
    enabled: true,
    routeId: current?.routeId ?? randomUUID(),
    accessToken: current?.accessToken ?? generateToken(),
    tokenId,
  }));
  try {
    return await startRuntime(plugin, settings, opts);
  } catch (error) {
    await updateSettings(plugin, (current) => ({
      ...(current ?? settings),
      enabled: false,
    }));
    throw error;
  }
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
    enabled: false,
    routeId: current?.routeId ?? randomUUID(),
    accessToken: current?.accessToken ?? generateToken(),
    tokenId: current?.tokenId ?? null,
  }));
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
  const rootDir =
    opts?.rootDir ?? path.join(os.tmpdir(), "obsidian-mcp-connector-broker-v1");
  const routesDir = path.join(rootDir, "routes");
  const dataPath = opts?.dataPath ?? resolveDataPath(plugin);
  const brokerPort = opts?.brokerPort ?? DISCOVERY_BROKER_PORT;
  const leaseId = randomUUID();
  const registrationPath = path.join(routesDir, `${settings.routeId}.json`);
  const ensureBrokerRunning = opts?.ensureBroker ?? ensureBroker;
  const openRegistration = opts?.connectRegistration ?? connectRegistration;
  const reconnectMs = opts?.reconnectMs ?? DISCOVERY_RECONNECT_MS;
  let stopped = false;
  let control: RegistrationControl | null = null;
  let recovery: Promise<void> | null = null;
  let cancelReconnectDelay: (() => void) | null = null;

  const writeRegistration = async () => {
    const registration = {
      version: DISCOVERY_PROTOCOL_VERSION,
      routeId: settings.routeId,
      dataPath,
      tokenId: settings.tokenId,
      accessTokenHash: createHash("sha256")
        .update(settings.accessToken, "utf8")
        .digest("hex"),
      leaseId,
    };
    await writeJsonAtomic(registrationPath, registration);
  };

  const establishControl = async () => {
    await ensureBrokerRunning(rootDir, brokerPort);
    if (stopped) return;
    const next = await openRegistration(
      brokerPort,
      settings.routeId,
      settings.accessToken,
      leaseId,
    );
    if (stopped) {
      next.close();
      await next.closed;
      return;
    }
    control = next;
    void next.closed.then(() => {
      if (control === next) control = null;
      if (!stopped) scheduleRecovery();
    });
  };

  async function recover(): Promise<void> {
    let reported = false;
    while (!stopped && control === null) {
      try {
        await establishControl();
        return;
      } catch (error) {
        if (!reported) {
          logger.warn("Codex discovery connection recovery failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          reported = true;
        }
        if (!stopped) await waitToReconnect();
      }
    }
  }

  function waitToReconnect(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cancelReconnectDelay = null;
        resolve();
      }, reconnectMs);
      cancelReconnectDelay = () => {
        clearTimeout(timer);
        cancelReconnectDelay = null;
        resolve();
      };
    });
  }

  function scheduleRecovery(): void {
    if (stopped || recovery !== null) return;
    recovery = recover().finally(() => {
      recovery = null;
    });
  }

  await ensurePrivateDirectory(rootDir);
  await ensurePrivateDirectory(routesDir);
  await writeRegistration();
  try {
    await establishControl();
  } catch (error) {
    await removeOwnedRegistration(registrationPath, leaseId);
    throw error;
  }

  return {
    routeId: settings.routeId,
    async stop() {
      if (stopped) return;
      stopped = true;
      cancelReconnectDelay?.();
      const currentControl = control;
      control = null;
      currentControl?.close();
      if (currentControl) await currentControl.closed;
      if (recovery) await recovery;
      await removeOwnedRegistration(registrationPath, leaseId);
    },
  };
}

async function connectRegistration(
  port: number,
  routeId: string,
  accessToken: string,
  leaseId: string,
): Promise<RegistrationControl> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/_obsidian_mcp_broker/register/${routeId}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-length": "0",
          "x-obsidian-mcp-lease-id": leaseId,
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `Discovery broker rejected registration with HTTP ${response.statusCode ?? 0}.`,
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
    request.setTimeout(2_000, () => {
      request.destroy(new Error("Discovery broker registration timed out."));
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
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

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, JSON.stringify(value), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fsp.rename(tempPath, filePath);
  } finally {
    await fsp.rm(tempPath, { force: true });
  }
}

async function removeOwnedRegistration(
  registrationPath: string,
  leaseId: string,
): Promise<void> {
  try {
    const value = JSON.parse(await fsp.readFile(registrationPath, "utf8"));
    if (value?.leaseId === leaseId)
      await fsp.rm(registrationPath, { force: true });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(error instanceof SyntaxError)
    ) {
      throw error;
    }
  }
}

type ProbeResult = "healthy" | "free" | "occupied";

async function probeBroker(port: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
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
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const value = JSON.parse(body);
            resolve(
              res.statusCode === 200 &&
                value.name === BROKER_NAME &&
                value.version === DISCOVERY_PROTOCOL_VERSION
                ? "healthy"
                : "occupied",
            );
          } catch {
            resolve("occupied");
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve("occupied");
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "ECONNREFUSED" ? "free" : "occupied");
    });
  });
}

async function ensureBroker(rootDir: string, port: number): Promise<void> {
  const initial = await probeBroker(port);
  if (initial === "healthy") return;
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (spawnError) throw spawnError;
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
