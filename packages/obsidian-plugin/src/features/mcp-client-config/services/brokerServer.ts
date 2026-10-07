import { createHash, timingSafeEqual } from "crypto";
import { constants, type Stats } from "fs";
import fsp, { type FileHandle } from "fs/promises";
import http from "http";
import path from "path";
import { type } from "arktype";
import {
  BIND_HOST,
  BROKER_PORT,
  MCP_PATH_PREFIX,
} from "$/features/mcp-transport/constants";
import { isOriginAllowed } from "$/features/mcp-transport/services/origin";
import { compareTokens } from "$/features/mcp-transport/services/token";
import { PortNumber } from "$/features/mcp-transport/types";

/**
 * The shared discovery broker (ADR-0021, amended by ADR-0027).
 *
 * One vault's renderer hosts this listener on BROKER_PORT for every open
 * vault. Each vault, the host included, registers its route over a
 * loopback control connection; the route lives as long as that
 * connection. A request on `/v1/<route>/mcp` is forwarded to the transport
 * port the vault registered on that connection, never to the `livePort` in
 * its `data.json`: a stale plugin instance can still overwrite that file
 * after a reload. The vault's `data.json` is checked on every request, and
 * the Authorization header is forwarded unchanged so the vault
 * authenticates it. The route credential only proves route ownership at
 * registration. Bare `/mcp` serves configs that pointed at BROKER_PORT
 * before it was the broker's: the bearer token picks the vault.
 */

export const BROKER_NAME = "obsidian-mcp-discovery-broker";
/**
 * Version 3: in-process host, optional Codex owner, bare `/mcp` routing and
 * the transport port in the registration.
 */
export const BROKER_PROTOCOL_VERSION = 3;
export const HEALTH_PATH = "/_obsidian_mcp_broker/health";
export const REGISTRATION_PATH = "/_obsidian_mcp_broker/register";
export const LEASE_HEADER = "x-obsidian-mcp-lease-id";
export const MAX_PENDING_REGISTRATIONS = 32;

const MAX_REGISTRATION_BYTES = 16 * 1024;
const EVICTION_WINDOW_MS = 10_000;
const MAX_EVICTIONS_PER_WINDOW = 3;
const REGISTRATION_TIMEOUT_MS = 2_000;
// Every path below comes from a registration body: require a regular file
// under a small cap before reading it.
const MAX_DATA_JSON_BYTES = 1024 * 1024;
// No final link, and no wait for a writer when the path names a FIFO.
// Windows defines neither flag.
const DATA_FILE_OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ROUTE_PATTERN = new RegExp(`^/v1/(${UUID})${MCP_PATH_PREFIX}$`, "i");
const REGISTRATION_PATTERN = new RegExp(
  `^${REGISTRATION_PATH}/(${UUID})$`,
  "i",
);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type BrokerRegistration = {
  version: number;
  routeId: string;
  /** Canonical path of the vault's `data.json`. */
  dataPath: string;
  leaseId: string;
  /** The vault's running MCP transport port, where its route forwards. */
  port: number;
};

export type BrokerServer = {
  readonly port: number;
  /** Settles once the listener and every connection are gone. */
  readonly closed: Promise<void>;
  /**
   * Stop listening and drop every control connection and forwarded
   * request before returning, then settle with `closed`. Obsidian does
   * not await `onunload`, so nothing may wait for an event first.
   */
  close(): Promise<void>;
};

type Control = {
  registration: BrokerRegistration;
  response: http.ServerResponse;
  requests: Set<() => void>;
  closed: boolean;
};

type VaultFile = {
  tokens: { id: string; token: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of a presented credential with a stored one. */
function credentialMatches(presented: string, stored: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(stored));
}

/**
 * A registration body comes from any local process. The port is a vault
 * transport port, so never the broker's own.
 */
const registrationSchema = type({
  version: type.unit(BROKER_PROTOCOL_VERSION),
  routeId: new RegExp(`^${UUID}$`, "i"),
  dataPath: type("string").narrow((value) => path.isAbsolute(value)),
  leaseId: "string > 0",
  port: PortNumber.narrow((value) => value !== BROKER_PORT),
});

function parseRegistration(value: unknown): BrokerRegistration | null {
  const parsed = registrationSchema(value);
  if (parsed instanceof type.errors) return null;
  // Rebuilt rather than returned, so undeclared keys are not carried along
  const { version, routeId, dataPath, leaseId, port } = parsed;
  return { version, routeId, dataPath, leaseId, port };
}

/**
 * A registration names the file the broker then trusts for a route's
 * tokens, so it must be this plugin's own data file in canonical form:
 * `<vault>/<configDir>/plugins/<pluginId>/data.json`. Any config directory
 * name is accepted, because each vault can override it. canonicalDataPath
 * resolves links only up to the `plugins` folder, so a linked plugin
 * folder still names the plugin ID here.
 */
function isPluginDataPath(dataPath: string, pluginId: string): boolean {
  // canonicalDataPath lowercases the whole path on Windows
  const same = (actual: string, expected: string) =>
    process.platform === "win32"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  const pluginDir = path.dirname(dataPath);
  const pluginsDir = path.dirname(pluginDir);
  const configDir = path.dirname(pluginsDir);
  return (
    path.normalize(dataPath) === dataPath &&
    same(path.basename(dataPath), "data.json") &&
    same(path.basename(pluginDir), pluginId) &&
    same(path.basename(pluginsDir), "plugins") &&
    // The config directory needs a vault directory above it
    path.dirname(configDir) !== configDir
  );
}

/** Why an entry fails the owner check, see ownershipFault. */
type OwnershipFault = "owner" | "others" | "group";

/**
 * Null when the entry is owned by this user and writable by no one else.
 * Group write is allowed only for the user's own primary group, the
 * per-user group a `002` umask relies on (Ubuntu and similar).
 */
function ownershipFault(entry: Stats): OwnershipFault | null {
  if (entry.uid !== process.getuid?.()) return "owner";
  if ((entry.mode & 0o002) !== 0) return "others";
  if ((entry.mode & 0o020) !== 0 && entry.gid !== process.getgid?.())
    return "group";
  return null;
}

type EntryLabel = "plugins folder" | "plugin folder" | "data file";
type EntryFault = OwnershipFault | "link" | "not-folder" | "not-file" | "size";

/** The check a registered `data.json` failed, see checkPluginDataFile. */
type DataFileProblem =
  | { kind: "path" }
  | { kind: "entry"; label: EntryLabel; entryPath: string; fault: EntryFault }
  | { kind: "unreadable"; code?: string }
  | { kind: "json" };

type DataFileCheck = { value: unknown } | { problem: DataFileProblem };

/**
 * Read a registered vault's `data.json` with the broker's checks, or name
 * the check it failed. On POSIX the `plugins` folder must be a real
 * folder, not a link, owned by this user and writable by no one else, so
 * only this user can create or replace the plugin folder inside it. The
 * plugin folder may be a link, as `bun run link` creates, and is checked
 * where it leads with the same owner rule. Following that one link adds no
 * file another user controls: only this user can place it, and the file
 * itself is checked on the descriptor it is then read from, a regular
 * file, not a link, owned by this user and writable by no one else. A path
 * swapped after the open, for example through a linked ancestor directory,
 * therefore cannot change what is read, and a registration still needs the
 * route credential stored in that file. Windows has no cheap owner check
 * and relies on the ACLs of the user profile that holds the vault.
 *
 * With `read` false every check above still runs, the open and the checks
 * on the open file included, and the file is neither read nor parsed. The
 * value is then undefined.
 */
async function checkPluginDataFile(
  dataPath: string,
  pluginId: string,
  read = true,
): Promise<DataFileCheck> {
  if (!isPluginDataPath(dataPath, pluginId))
    return { problem: { kind: "path" } };
  const posix = process.platform !== "win32";
  const pluginDir = path.dirname(dataPath);
  const pluginsDir = path.dirname(pluginDir);
  const entry = (
    label: EntryLabel,
    entryPath: string,
    fault: EntryFault,
  ): DataFileCheck => ({ problem: { kind: "entry", label, entryPath, fault } });
  let handle: FileHandle | undefined;
  try {
    if (posix) {
      // Not followed, so only this user can place the plugin folder, which
      // is followed and checked where it leads
      const plugins = await fsp.lstat(pluginsDir);
      if (!plugins.isDirectory())
        return entry("plugins folder", pluginsDir, "link");
      const pluginsFault = ownershipFault(plugins);
      if (pluginsFault)
        return entry("plugins folder", pluginsDir, pluginsFault);
      const plugin = await fsp.stat(pluginDir);
      if (!plugin.isDirectory())
        return entry("plugin folder", pluginDir, "not-folder");
      const pluginFault = ownershipFault(plugin);
      if (pluginFault) return entry("plugin folder", pluginDir, pluginFault);
    }
    try {
      handle = await fsp.open(dataPath, DATA_FILE_OPEN_FLAGS);
    } catch (error) {
      // What O_NOFOLLOW reports for a link: ELOOP, or EMLINK on FreeBSD
      const code = (error as NodeJS.ErrnoException).code;
      if (posix && (code === "ELOOP" || code === "EMLINK"))
        return entry("data file", dataPath, "not-file");
      throw error;
    }
    const stat = await handle.stat();
    if (!stat.isFile()) return entry("data file", dataPath, "not-file");
    const fileFault = posix ? ownershipFault(stat) : null;
    if (fileFault) return entry("data file", dataPath, fileFault);
    if (stat.size > MAX_DATA_JSON_BYTES)
      return entry("data file", dataPath, "size");
    if (!read) return { value: undefined };
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    try {
      return { value: JSON.parse(buffer.toString("utf8", 0, length)) };
    } catch {
      return { problem: { kind: "json" } };
    }
  } catch (error) {
    return {
      problem: {
        kind: "unreadable",
        code: (error as NodeJS.ErrnoException).code,
      },
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Read a registered vault's `data.json`, or null when it fails a check.
 * Admission and bare `/mcp` routing read through here, see
 * checkPluginDataFile.
 */
async function readPluginDataFile(
  dataPath: string,
  pluginId: string,
): Promise<unknown> {
  const check = await checkPluginDataFile(dataPath, pluginId);
  return "value" in check ? check.value : null;
}

/**
 * Whether a route's `data.json` still passes every check, without reading
 * it. A forwarded request needs nothing from its contents, because the
 * vault authenticates the bearer itself.
 */
async function passesDataFileChecks(
  dataPath: string,
  pluginId: string,
): Promise<boolean> {
  const check = await checkPluginDataFile(dataPath, pluginId, false);
  return !("problem" in check);
}

function describeProblem(
  problem: DataFileProblem,
  dataPath: string,
  pluginId: string,
): string {
  switch (problem.kind) {
    case "path":
      return `The path ${dataPath} is not this plugin's data file, <vault>/<config folder>/plugins/${pluginId}/data.json`;
    case "unreadable":
      return `The data file ${dataPath} cannot be read${problem.code ? ` (${problem.code})` : ""}`;
    case "json":
      return `The data file ${dataPath} is not valid JSON`;
  }
  const { label, entryPath } = problem;
  switch (problem.fault) {
    case "owner":
      return `The ${label} ${entryPath} is not owned by your user account. Make your account its owner, for example with chown`;
    case "others":
      return `Every user on this computer can write to the ${label} ${entryPath}. Remove that write access, for example with chmod o-w`;
    case "group":
      return `A group other than your own can write to the ${label} ${entryPath}. Remove the group's write access, for example with chmod g-w`;
    case "link":
      return `The ${label} ${entryPath} is a link or not a folder. Replace it with a real folder`;
    case "not-folder":
      return `The ${label} ${entryPath} is not a folder`;
    case "not-file":
      return `The ${label} ${entryPath} is a link or not a regular file. Replace it with the file itself`;
    case "size":
      return `The ${label} ${entryPath} is larger than 1 MB, the most the shared broker reads`;
  }
}

/**
 * Why the broker would refuse to read `dataPath`, as a sentence that names
 * the path and what to change, or null when every check passes. The
 * broker answers a refused registration with a bare `401`, so no other
 * local process learns why: the registering vault runs the same checks
 * itself. Null leaves a cause these checks cannot see, such as a route
 * credential that changed meanwhile.
 */
export async function diagnosePluginDataFile(
  dataPath: string,
  pluginId: string,
): Promise<string | null> {
  const check = await checkPluginDataFile(dataPath, pluginId);
  return "problem" in check
    ? describeProblem(check.problem, dataPath, pluginId)
    : null;
}

/** Read the parts of a vault's `data.json` the broker acts on, or null. */
async function readVaultFile(
  dataPath: string,
  pluginId: string,
): Promise<VaultFile | null> {
  const data = await readPluginDataFile(dataPath, pluginId);
  if (!isRecord(data)) return null;
  const transport = isRecord(data.mcpTransport) ? data.mcpTransport : {};
  const tokens = Array.isArray(transport.tokens)
    ? transport.tokens.filter(
        (entry): entry is { id: string; token: string } =>
          isRecord(entry) &&
          typeof entry.id === "string" &&
          typeof entry.token === "string" &&
          entry.token.length > 0,
      )
    : [];
  return { tokens };
}

/**
 * The route belongs to the vault whose saved settings name both the route
 * and this canonical `data.json` path, and whose route credential the
 * registrant presented. That credential is only a registration secret: no
 * client sends it, and the stored `enabled` and `tokenId` keys of older
 * versions play no part.
 */
async function ownsRegistration(
  registration: BrokerRegistration,
  credential: string,
  pluginId: string,
): Promise<boolean> {
  const data = await readPluginDataFile(registration.dataPath, pluginId);
  const clientConfig = isRecord(data) ? data.mcpClientConfig : undefined;
  const settings = isRecord(clientConfig)
    ? clientConfig.codexDiscovery
    : undefined;
  return (
    isRecord(settings) &&
    settings.routeId === registration.routeId &&
    settings.dataPath === registration.dataPath &&
    typeof settings.accessToken === "string" &&
    credentialMatches(credential, settings.accessToken)
  );
}

/** Schedules `expire` and returns a function that cancels it. */
export type RegistrationDeadline = (expire: () => void) => () => void;

const registrationTimeout: RegistrationDeadline = (expire) => {
  const timer = window.setTimeout(expire, REGISTRATION_TIMEOUT_MS);
  return () => window.clearTimeout(timer);
};

function readRegistration(
  req: http.IncomingMessage,
  deadline: RegistrationDeadline,
): Promise<BrokerRegistration | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (registration: BrokerRegistration | null) => {
      if (settled) return;
      settled = true;
      cancelDeadline();
      resolve(registration);
    };
    const cancelDeadline = deadline(() => {
      req.destroy();
      finish(null);
    });
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REGISTRATION_BYTES) {
        req.destroy();
        finish(null);
      } else chunks.push(chunk);
    });
    req.once("end", () => {
      try {
        const value: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        finish(parseRegistration(value));
      } catch {
        finish(null);
      }
    });
    req.once("error", () => finish(null));
    req.once("close", () => finish(null));
  });
}

/** Same parsing as the vault's own auth check, so both see one token. */
function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/.exec(header ?? "");
  const token = match?.[1].trim();
  return token ? token : null;
}

function copyHeaders(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      value !== undefined &&
      !HOP_BY_HOP_HEADERS.has(lower) &&
      lower !== "host" &&
      lower !== "authorization"
    ) {
      next[name] = value;
    }
  }
  return next;
}

function respond(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Pipe one request to the MCP endpoint on the port the vault registered,
 * with its Authorization header unchanged so the vault authenticates it.
 */
function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  control: Control,
  query: string,
): void {
  if (control.closed || req.aborted || res.destroyed) {
    res.destroy();
    return;
  }
  const { port } = control.registration;
  const headers = copyHeaders(req.headers);
  const { authorization } = req.headers;
  if (authorization !== undefined) headers.authorization = authorization;
  headers.host = `${BIND_HOST}:${port}`;
  // A pooled socket would outlive the broker that opened it
  headers.connection = "close";
  const upstream = http.request(
    {
      host: BIND_HOST,
      port,
      path: `${MCP_PATH_PREFIX}${query}`,
      method: req.method,
      headers,
    },
    (upstreamResponse) => {
      res.writeHead(
        upstreamResponse.statusCode || 502,
        copyHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(res);
      upstreamResponse.on("error", () => res.destroy());
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent)
      respond(res, 502, "vault MCP transport is unavailable");
    else res.destroy();
  });
  // Release this transport connection, without inventing an MCP cancellation or replay
  const dispose = () => upstream.destroy();
  control.requests.add(dispose);
  const cleanup = () => {
    control.requests.delete(dispose);
    req.off("aborted", dispose);
    res.off("close", dispose);
  };
  upstream.once("close", cleanup);
  req.once("aborted", dispose);
  res.once("close", dispose);
  req.pipe(upstream);
}

/**
 * Listen on `port` and resolve once listening, or reject with the listen
 * error (EADDRINUSE when another vault won the port).
 */
export function startBrokerServer(opts: {
  port: number;
  /** The plugin ID every registered `data.json` path must name. */
  pluginId: string;
  /** Bounds how long a registration body may take. Defaults to two seconds. */
  registrationDeadline?: RegistrationDeadline;
}): Promise<BrokerServer> {
  const deadline = opts.registrationDeadline ?? registrationTimeout;
  const routes = new Map<string, Control>();
  let pendingRegistrations = 0;
  let closing = false;
  // When a route's control was last evicted by another lease, per route
  const evictions = new Map<string, number[]>();

  /**
   * Records an eviction of `key`'s control by a different lease and says
   * whether it exceeds the allowance: a restarting vault evicts its own
   * stale control once, a second vault on the same data file does so on
   * every reconnect.
   */
  function evictionRefused(key: string): boolean {
    const now = Date.now();
    const recent = (evictions.get(key) ?? []).filter(
      (at) => now - at < EVICTION_WINDOW_MS,
    );
    const refused = recent.length >= MAX_EVICTIONS_PER_WINDOW;
    if (!refused) recent.push(now);
    evictions.set(key, recent);
    return refused;
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) respond(res, 500, "broker request failed");
      else res.destroy();
    });
  });

  let boundPort = opts.port;

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (
      ![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(
        req.headers.host ?? "",
      ) ||
      !isOriginAllowed(req.headers.origin)
    ) {
      res.setHeader("connection", "close");
      respond(res, 403, "untrusted request origin or host");
      return;
    }
    const url = req.url ?? "";
    if (req.method === "GET" && url === HEALTH_PATH) {
      const body = JSON.stringify({
        name: BROKER_NAME,
        version: BROKER_PROTOCOL_VERSION,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    const registrationMatch = REGISTRATION_PATTERN.exec(url);
    if (req.method === "POST" && registrationMatch) {
      await register(req, res, registrationMatch[1]);
      return;
    }
    const queryStart = url.indexOf("?");
    const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
    const query = queryStart === -1 ? "" : url.slice(queryStart);
    const routeMatch = ROUTE_PATTERN.exec(pathname);
    if (routeMatch) {
      await routeRequest(req, res, routeMatch[1].toLowerCase(), query);
      return;
    }
    if (pathname === MCP_PATH_PREFIX) {
      await bareRequest(req, res, query);
      return;
    }
    respond(res, 404, "route not found");
  }

  async function register(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    routeId: string,
  ): Promise<void> {
    if (pendingRegistrations >= MAX_PENDING_REGISTRATIONS) {
      res.setHeader("connection", "close");
      respond(res, 503, "too many pending registrations");
      return;
    }
    pendingRegistrations += 1;
    let registration: BrokerRegistration | null = null;
    let authorized = false;
    try {
      registration = await readRegistration(req, deadline);
      const credential = bearerToken(req.headers.authorization);
      authorized = Boolean(
        registration &&
        registration.routeId.toLowerCase() === routeId.toLowerCase() &&
        // A route that forwards to the broker itself would loop
        registration.port !== boundPort &&
        credential &&
        req.headers[LEASE_HEADER] === registration.leaseId &&
        (await ownsRegistration(registration, credential, opts.pluginId)),
      );
    } finally {
      // Only admission counts toward the cap, never an established control stream
      pendingRegistrations -= 1;
    }
    if (!authorized || !registration) {
      respond(res, 401, "unauthorized");
      return;
    }
    const key = registration.routeId.toLowerCase();
    const existing = routes.get(key);
    if (existing) {
      // Same dataPath means the same vault reconnecting, e.g. a stale
      // control from a prior lease that has not been reaped yet: evict it
      // instead of reporting a false identity conflict. A different
      // dataPath is a genuine copied-vault conflict.
      if (existing.registration.dataPath === registration.dataPath) {
        // Two open vaults that share one data file would otherwise evict
        // each other's control forever. A different lease is another
        // plugin instance, so repeated evictions of it are refused.
        if (
          existing.registration.leaseId !== registration.leaseId &&
          evictionRefused(key)
        ) {
          respond(res, 409, "route already registered");
          return;
        }
        existing.response.destroy();
      } else {
        respond(res, 409, "route already registered");
        return;
      }
    }
    if (closing || req.aborted || res.destroyed) {
      res.destroy();
      return;
    }
    const control: Control = {
      registration,
      response: res,
      requests: new Set(),
      closed: false,
    };
    routes.set(key, control);
    req.socket.setKeepAlive(true, 30_000);
    req.resume();
    res.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.flushHeaders();
    const release = () => {
      control.closed = true;
      for (const dispose of control.requests) dispose();
      control.requests.clear();
      if (routes.get(key) === control) routes.delete(key);
    };
    req.on("aborted", release);
    res.on("close", release);
  }

  async function routeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    routeId: string,
    query: string,
  ): Promise<void> {
    const control = routes.get(routeId);
    if (!control) {
      respond(res, 404, "route not found");
      return;
    }
    // The data file must still pass its checks, but the vault authenticates
    if (
      !(await passesDataFileChecks(
        control.registration.dataPath,
        opts.pluginId,
      ))
    ) {
      respond(res, 503, "vault data is unavailable");
      return;
    }
    forward(req, res, control, query);
  }

  /**
   * Legacy `/mcp` on the broker port: route by the bearer token alone, so
   * a config written when a vault served this port directly keeps working.
   */
  async function bareRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: string,
  ): Promise<void> {
    // The vault answers a method it does not serve before checking auth.
    const reject = () =>
      req.method === "POST"
        ? respond(res, 401, "unauthorized")
        : respond(res, 405, "method not allowed");
    const presented = bearerToken(req.headers.authorization);
    if (presented === null) {
      reject();
      return;
    }
    const controls = [...routes.values()];
    const vaults = await Promise.all(
      controls.map((control) =>
        readVaultFile(control.registration.dataPath, opts.pluginId),
      ),
    );
    // Keyed by data file: a route replaced by the same vault is one match
    const matches = new Map<string, Control>();
    controls.forEach((control, index) => {
      const vault = vaults[index];
      if (!vault) return;
      // No early exit, the vault's own auth loop avoids leaking position too
      let matched = false;
      for (const entry of vault.tokens) {
        if (compareTokens(presented, entry.token)) matched = true;
      }
      if (matched) matches.set(control.registration.dataPath, control);
    });
    if (matches.size === 0) {
      reject();
      return;
    }
    if (matches.size > 1) {
      respond(
        res,
        409,
        "This token belongs to more than one open vault, usually a copied vault. In the copy, use Make this copy independent and copy its client config again",
      );
      return;
    }
    const [control] = matches.values();
    forward(req, res, control, query);
  }

  const closed = new Promise<void>((resolve) =>
    server.once("close", () => resolve()),
  );

  function close(): Promise<void> {
    if (!closing) {
      closing = true;
      // Releasing a control destroys the requests forwarded for its route
      for (const control of [...routes.values()]) control.response.destroy();
      // ERR_SERVER_NOT_RUNNING (a failed or already stopped listener)
      // still means the port is free, so the callback error is ignored.
      server.close(() => undefined);
      // Cast: closeAllConnections is Node >=18.2 (Obsidian's Electron and
      // Bun both have it) but the pinned @types/node@16 predates it.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    }
    return closed;
  }

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object") boundPort = address.port;
      resolve({
        get port() {
          return boundPort;
        },
        closed,
        close,
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port, BIND_HOST);
  });
}
