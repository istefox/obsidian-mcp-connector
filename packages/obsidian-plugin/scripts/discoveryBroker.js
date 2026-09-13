"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");

const BROKER_NAME = "obsidian-mcp-discovery-broker";
const BROKER_VERSION = 2;
const MAX_REGISTRATION_BYTES = 16 * 1024;
const MAX_PENDING_REGISTRATIONS = 32;
// Match the vault transport's Origin policy; the broker runs as a standalone script
const ALLOWED_ORIGINS_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const DEFAULT_PORT = 27206;
const IDLE_EXIT_MS = 10_000;
const SWEEP_INTERVAL_MS = 5_000;
const ROUTE_PATTERN =
  /^\/v1\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/mcp$/i;
const REGISTRATION_PATTERN =
  /^\/_obsidian_mcp_broker\/register\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const LEASE_HEADER = "x-obsidian-mcp-lease-id";
const HASH_PATTERN = /^[0-9a-f]{64}$/;
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

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function parseRegistration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== BROKER_VERSION) return null;
  if (
    typeof value.routeId !== "string" ||
    !ROUTE_PATTERN.test(`/v1/${value.routeId}/mcp`)
  )
    return null;
  if (typeof value.dataPath !== "string" || !path.isAbsolute(value.dataPath))
    return null;
  if (typeof value.tokenId !== "string" || value.tokenId.length === 0)
    return null;
  if (
    typeof value.accessTokenHash !== "string" ||
    !HASH_PATTERN.test(value.accessTokenHash)
  )
    return null;
  if (typeof value.leaseId !== "string" || value.leaseId.length === 0)
    return null;
  return value;
}

function parseTransportFile(raw, tokenId) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "vault data is not valid JSON" };
  }
  const port = data?.mcpTransport?.livePort;
  const tokens = data?.mcpTransport?.tokens;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { error: "vault MCP transport is not running" };
  }
  if (!Array.isArray(tokens))
    return { error: "vault token store is unavailable" };
  const record = tokens.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      entry.id === tokenId &&
      typeof entry.token === "string" &&
      entry.token.length > 0,
  );
  if (!record) return { error: "selected vault token no longer exists" };
  return { port, token: record.token };
}

async function readRegistration(req) {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), 2_000);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_REGISTRATION_BYTES) return null;
      chunks.push(chunk);
    }
    return parseRegistration(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const MAX_DATA_JSON_BYTES = 1024 * 1024;

async function ownsRegistration(registration, token) {
  try {
    // dataPath comes straight from the untrusted POST body: require a
    // regular file under a small cap before reading it.
    const stat = await fsp.stat(registration.dataPath);
    if (!stat.isFile() || stat.size > MAX_DATA_JSON_BYTES) return false;
    const data = JSON.parse(await fsp.readFile(registration.dataPath, "utf8"));
    const settings = data?.mcpClientConfig?.codexDiscovery;
    return (
      settings?.enabled === true &&
      settings.routeId === registration.routeId &&
      settings.tokenId === registration.tokenId &&
      typeof settings.accessToken === "string" &&
      tokenMatches(token, sha256(settings.accessToken))
    );
  } catch {
    return false;
  }
}

function bearerToken(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

function tokenMatches(token, expectedHash) {
  const actual = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

function copyHeaders(headers) {
  const next = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) &&
      name.toLowerCase() !== "host"
    ) {
      next[name] = value;
    }
  }
  return next;
}

function respond(res, status, message) {
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function proxyRequest(req, res, control, brokerPort) {
  const { registration } = control;
  let raw;
  try {
    raw = await fsp.readFile(registration.dataPath, "utf8");
  } catch {
    respond(res, 503, "vault data is unavailable");
    return;
  }
  const transport = parseTransportFile(raw, registration.tokenId);
  if (transport.error) {
    respond(res, 503, transport.error);
    return;
  }
  if (transport.port === brokerPort) {
    respond(res, 502, "vault transport resolves to the discovery broker");
    return;
  }
  if (control.closed || req.aborted || res.destroyed) {
    res.destroy();
    return;
  }

  const headers = copyHeaders(req.headers);
  headers.authorization = `Bearer ${transport.token}`;
  headers.host = `127.0.0.1:${transport.port}`;
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: transport.port,
      path: "/mcp",
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

function startBroker({
  rootDir,
  port = DEFAULT_PORT,
  idleExitMs = IDLE_EXIT_MS,
} = {}) {
  if (!rootDir || !path.isAbsolute(rootDir))
    throw new Error("rootDir must be absolute");
  let lastLiveAt = Date.now();
  const activeRoutes = new Map();
  let pendingRegistrations = 0;

  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) ||
      (req.headers.origin !== undefined &&
        !ALLOWED_ORIGINS_PATTERN.test(req.headers.origin))
    ) {
      res.setHeader("connection", "close");
      respond(res, 403, "untrusted request origin or host");
      return;
    }
    if (req.method === "GET" && req.url === "/_obsidian_mcp_broker/health") {
      const body = JSON.stringify({
        name: BROKER_NAME,
        version: BROKER_VERSION,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    const registrationMatch = REGISTRATION_PATTERN.exec(req.url || "");
    if (req.method === "POST" && registrationMatch) {
      if (pendingRegistrations >= MAX_PENDING_REGISTRATIONS) {
        res.setHeader("connection", "close");
        respond(res, 503, "too many pending registrations");
        return;
      }
      pendingRegistrations += 1;
      let registration;
      let authorized = false;
      try {
        registration = await readRegistration(req);
        const token = bearerToken(req.headers.authorization);
        authorized = Boolean(
          registration &&
          registration.routeId === registrationMatch[1] &&
          token &&
          tokenMatches(token, registration.accessTokenHash) &&
          req.headers[LEASE_HEADER] === registration.leaseId &&
          (await ownsRegistration(registration, token)),
        );
      } finally {
        // Only admission counts toward the cap, never an established control stream
        pendingRegistrations -= 1;
      }
      if (!authorized) {
        respond(res, 401, "unauthorized");
        return;
      }
      const existing = activeRoutes.get(registration.routeId);
      if (existing) {
        // Same dataPath means the same vault reconnecting, e.g. a stale
        // control from a prior lease that has not been reaped yet: evict it
        // instead of reporting a false identity conflict. A different
        // dataPath is a genuine copied-vault conflict.
        if (existing.registration.dataPath === registration.dataPath) {
          existing.response.destroy();
        } else {
          respond(res, 409, "route already registered");
          return;
        }
      }

      if (req.aborted || res.destroyed) return;
      const control = {
        registration,
        response: res,
        requests: new Set(),
        closed: false,
      };
      activeRoutes.set(registration.routeId, control);
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
        if (activeRoutes.get(registration.routeId) === control) {
          activeRoutes.delete(registration.routeId);
        }
      };
      req.on("aborted", release);
      res.on("close", release);
      return;
    }
    const match = ROUTE_PATTERN.exec(req.url || "");
    if (!match) {
      respond(res, 404, "route not found");
      return;
    }
    const active = activeRoutes.get(match[1]);
    if (!active) {
      respond(res, 404, "route not found");
      return;
    }
    const token = bearerToken(req.headers.authorization);
    if (!token || !tokenMatches(token, active.registration.accessTokenHash)) {
      respond(res, 401, "unauthorized");
      return;
    }
    await proxyRequest(req, res, active, server.address().port);
  });

  const sweep = setInterval(
    () => {
      if (activeRoutes.size > 0) {
        lastLiveAt = Date.now();
      } else if (Date.now() - lastLiveAt >= idleExitMs) {
        clearInterval(sweep);
        server.close(() => {
          if (require.main === module) process.exit(0);
        });
        server.closeAllConnections();
      }
    },
    Math.min(SWEEP_INTERVAL_MS, idleExitMs),
  );
  sweep.unref();
  server.on("close", () => clearInterval(sweep));
  server.listen(port, "127.0.0.1");
  return server;
}

function parseArgs(argv) {
  const result = { rootDir: "", port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--root") result.rootDir = path.resolve(argv[i + 1] || "");
    else if (argv[i] === "--port") result.port = Number(argv[i + 1]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!result.rootDir) throw new Error("--root is required");
  if (
    !Number.isInteger(result.port) ||
    result.port < 1024 ||
    result.port > 65535
  ) {
    throw new Error("--port must be an integer from 1024 to 65535");
  }
  return result;
}

module.exports = {
  MAX_PENDING_REGISTRATIONS,
  BROKER_NAME,
  BROKER_VERSION,
  DEFAULT_PORT,
  IDLE_EXIT_MS,
  parseArgs,
  parseRegistration,
  parseTransportFile,
  proxyRequest,
  readRegistration,
  sha256,
  startBroker,
  tokenMatches,
};

if (require.main === module) {
  try {
    startBroker(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`obsidian-mcp-discovery-broker: ${error.message}\n`);
    process.exit(1);
  }
}
