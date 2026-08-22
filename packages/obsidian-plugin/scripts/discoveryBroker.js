"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");

const BROKER_NAME = "obsidian-mcp-discovery-broker";
const BROKER_VERSION = 1;
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

async function readRegistration(routesDir, routeId) {
  try {
    const raw = await fsp.readFile(
      path.join(routesDir, `${routeId}.json`),
      "utf8",
    );
    return parseRegistration(JSON.parse(raw));
  } catch {
    return null;
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

async function proxyRequest(req, res, registration, brokerPort) {
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
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent)
      respond(res, 502, "vault MCP transport is unavailable");
    else res.destroy();
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

function startBroker({
  rootDir,
  port = DEFAULT_PORT,
  idleExitMs = IDLE_EXIT_MS,
} = {}) {
  if (!rootDir || !path.isAbsolute(rootDir))
    throw new Error("rootDir must be absolute");
  const routesDir = path.join(rootDir, "routes");
  fs.mkdirSync(routesDir, { recursive: true, mode: 0o700 });
  for (const directory of [rootDir, routesDir]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `discovery path is not a private directory: ${directory}`,
      );
    }
  }
  try {
    fs.chmodSync(rootDir, 0o700);
    fs.chmodSync(routesDir, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows enforces access through ACLs rather than POSIX mode bits.
  }
  let lastLiveAt = Date.now();
  const activeRoutes = new Map();

  const server = http.createServer(async (req, res) => {
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
      const registration = await readRegistration(
        routesDir,
        registrationMatch[1],
      );
      const token = bearerToken(req.headers.authorization);
      if (
        !registration ||
        !token ||
        !tokenMatches(token, registration.accessTokenHash) ||
        req.headers[LEASE_HEADER] !== registration.leaseId
      ) {
        respond(res, 401, "unauthorized");
        return;
      }
      if (activeRoutes.has(registration.routeId)) {
        respond(res, 409, "route already registered");
        return;
      }

      const control = { leaseId: registration.leaseId, response: res };
      activeRoutes.set(registration.routeId, control);
      req.socket.setKeepAlive(true, 30_000);
      req.resume();
      res.writeHead(200, {
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.flushHeaders();
      const release = () => {
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
    const registration = await readRegistration(routesDir, match[1]);
    if (!registration) {
      respond(res, 404, "route not found");
      return;
    }
    const active = activeRoutes.get(registration.routeId);
    if (!active || active.leaseId !== registration.leaseId) {
      respond(res, 404, "route not found");
      return;
    }
    const token = bearerToken(req.headers.authorization);
    if (!token || !tokenMatches(token, registration.accessTokenHash)) {
      respond(res, 401, "unauthorized");
      return;
    }
    await proxyRequest(req, res, registration, port);
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
