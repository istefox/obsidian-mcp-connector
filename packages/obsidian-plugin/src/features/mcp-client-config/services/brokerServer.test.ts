import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import fsp from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { isOriginAllowed } from "$/features/mcp-transport/services/origin";
import {
  BROKER_NAME,
  BROKER_PROTOCOL_VERSION,
  diagnosePluginDataFile,
  HEALTH_PATH,
  LEASE_HEADER,
  MAX_PENDING_REGISTRATIONS,
  REGISTRATION_PATH,
  startBrokerServer,
  type BrokerServer,
} from "./brokerServer";

const routeId = "123e4567-e89b-42d3-a456-426614174000";
const routeCredential = "stable-route-credential";
const pluginId = "mcp-tools-istefox";
let tempDir = "";

/** The plugin's own data file in a vault under the temp directory. */
function vaultFile(vault = "vault", plugin = pluginId): string {
  return path.join(tempDir, vault, ".obsidian", "plugins", plugin, "data.json");
}
const servers: http.Server[] = [];
const brokers: BrokerServer[] = [];
const controls: Array<{ close(): Promise<void> }> = [];
/** Each vault's fake transport port by data file, sent on registration. */
const transportPorts = new Map<string, number>();
// Registrations that never forward still need a valid port
const UNUSED_PORT = 1024;

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function request(
  port: number,
  options: {
    path: string;
    token?: string;
    body?: string;
    method?: string;
    headers?: http.OutgoingHttpHeaders;
  },
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers: {
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(options.body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(options.body),
                "mcp-protocol-version": "2026-07-28",
                "mcp-session-id": "client-session",
              }),
          ...options.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function startBroker(): Promise<number> {
  const broker = await startBrokerServer({ port: 0, pluginId });
  brokers.push(broker);
  return broker.port;
}

/** Saved route settings the broker verifies a registration against. */
function routeSettings(
  dataPath: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    enabled: false,
    routeId,
    tokenId: null,
    accessToken: routeCredential,
    dataPath,
    ...overrides,
  };
}

async function writeVault(
  dataPath: string,
  data: {
    livePort?: number;
    tokens?: Array<{ id: string; token: string }>;
    settings?: Record<string, unknown>;
  },
): Promise<void> {
  // Owner-only, as the broker requires on POSIX whatever the umask is
  await fsp.mkdir(path.dirname(dataPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(
    dataPath,
    JSON.stringify({
      mcpClientConfig: {
        codexDiscovery: data.settings ?? routeSettings(dataPath),
      },
      mcpTransport: {
        ...(data.livePort === undefined ? {} : { livePort: data.livePort }),
        tokens: data.tokens ?? [{ id: "selected", token: "vault-token" }],
      },
    }),
    { mode: 0o600 },
  );
}

async function registerRoute(
  port: number,
  credential: string,
  leaseId: string,
  id = routeId,
  vaultPath = vaultFile(),
  registeredPath = vaultPath,
  transportPort: unknown = transportPorts.get(vaultPath) ?? UNUSED_PORT,
  /** The lease named in the body. The header carries `leaseId`. */
  bodyLeaseId = "lease",
): Promise<{ close(): Promise<void> }> {
  const body = JSON.stringify({
    version: BROKER_PROTOCOL_VERSION,
    routeId: id,
    dataPath: registeredPath,
    leaseId: bodyLeaseId,
    port: transportPort,
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `${REGISTRATION_PATH}/${id}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-length": String(Buffer.byteLength(body)),
          [LEASE_HEADER]: leaseId,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`registration failed with HTTP ${res.statusCode}`));
          return;
        }
        res.resume();
        let closed = false;
        let resolveClosed!: () => void;
        const closedPromise = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        res.once("close", () => {
          closed = true;
          resolveClosed();
        });
        const control = {
          async close() {
            if (closed) return;
            res.destroy();
            req.destroy();
            await closedPromise;
          },
        };
        controls.push(control);
        resolve(control);
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

/**
 * The broker drops a route when it sees its control connection close,
 * one event after the client side has closed it. Poll the public route
 * until that lands, bounded by attempts rather than time.
 */
async function waitForStatus(
  port: number,
  route: string,
  token: string,
  status: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(port, { path: route, token, body: "{}" });
    if (response.status === status) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`route did not return HTTP ${status}`);
}

/** A fake vault MCP endpoint that echoes the Authorization it received. */
async function vaultTarget(
  label: string,
  vault: string,
  tokens = [{ id: "selected", token: "vault-token" }],
): Promise<string> {
  const target = http.createServer((req, res) => {
    req.resume();
    res.end(`${label}|${req.headers.authorization ?? ""}`);
  });
  servers.push(target);
  const file = vaultFile(vault);
  transportPorts.set(file, await listen(target));
  await writeVault(file, { tokens });
  return file;
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-broker-server-"));
});

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(servers.splice(0).map(close));
  transportPorts.clear();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

test("one stable route forwards the client bearer unchanged to the registered port", async () => {
  const seen: Array<{
    authorization: string | undefined;
    protocolVersion: string | undefined;
    sessionId: string | undefined;
    body: string;
  }> = [];
  const target = (label: string) =>
    http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        seen.push({
          authorization: req.headers.authorization,
          protocolVersion: req.headers["mcp-protocol-version"] as
            | string
            | undefined,
          sessionId: req.headers["mcp-session-id"] as string | undefined,
          body,
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": `${label}-session`,
        });
        res.end(JSON.stringify({ label }));
      });
    });
  const firstTarget = target("first");
  const secondTarget = target("second");
  servers.push(firstTarget, secondTarget);
  const firstPort = await listen(firstTarget);
  const secondPort = await listen(secondTarget);
  const dataPath = vaultFile();
  // Stored Codex keys from older versions are ignored
  const codex = routeSettings(dataPath, { enabled: true, tokenId: "selected" });
  await writeVault(dataPath, {
    livePort: firstPort,
    tokens: [{ id: "selected", token: "first-vault-token" }],
    settings: codex,
  });

  const brokerPort = await startBroker();
  const route = `/v1/${routeId}/mcp`;
  expect(
    (
      await request(brokerPort, {
        path: route,
        token: routeCredential,
        body: "{}",
      })
    ).status,
  ).toBe(404);
  await expect(registerRoute(brokerPort, "wrong", "lease")).rejects.toThrow(
    "HTTP 401",
  );
  await expect(
    registerRoute(brokerPort, routeCredential, "wrong-lease"),
  ).rejects.toThrow("HTTP 401");
  const control = await registerRoute(
    brokerPort,
    routeCredential,
    "lease",
    routeId,
    dataPath,
    dataPath,
    firstPort,
  );
  const first = await request(brokerPort, {
    path: route,
    token: "client-token",
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });

  // A stale plugin instance finishing its save after a reload names
  // another port. The route keeps the port it registered.
  await writeVault(dataPath, {
    livePort: secondPort,
    tokens: [{ id: "selected", token: "second-vault-token" }],
    settings: codex,
  });
  const second = await request(brokerPort, {
    path: route,
    token: "client-token",
    body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  });

  // A transport restart registers the route again with its new port. The
  // same vault's new registration evicts the old control on admission.
  const restarted = await registerRoute(
    brokerPort,
    routeCredential,
    "lease",
    routeId,
    dataPath,
    dataPath,
    secondPort,
  );
  const third = await request(brokerPort, {
    path: route,
    token: "client-token",
    body: '{"jsonrpc":"2.0","id":3,"method":"tools/list"}',
  });

  expect(first.status).toBe(200);
  expect(first.body).toContain("first");
  expect(first.headers["mcp-session-id"]).toBe("first-session");
  expect(second.status).toBe(200);
  expect(second.body).toContain("first");
  expect(third.status).toBe(200);
  expect(third.body).toContain("second");
  expect(seen.map((entry) => entry.authorization)).toEqual([
    "Bearer client-token",
    "Bearer client-token",
    "Bearer client-token",
  ]);
  expect(seen.map((entry) => entry.protocolVersion)).toEqual([
    "2026-07-28",
    "2026-07-28",
    "2026-07-28",
  ]);
  expect(seen.map((entry) => entry.sessionId)).toEqual([
    "client-session",
    "client-session",
    "client-session",
  ]);
  const health = await request(brokerPort, { path: HEALTH_PATH });
  expect(health.status).toBe(200);
  expect(JSON.parse(health.body)).toEqual({
    name: BROKER_NAME,
    version: BROKER_PROTOCOL_VERSION,
  });

  await control.close();
  await restarted.close();
  await waitForStatus(brokerPort, route, routeCredential, 404);
});

test.each([
  ["the broker port", 27200],
  ["below 1024", 80],
  ["above 65535", 70000],
  ["not an integer", 27201.5],
  ["a string", "27201"],
  ["null", null],
])(
  "rejects a registration whose transport port is %s",
  async (_label, transportPort) => {
    const dataPath = vaultFile();
    await writeVault(dataPath, {});
    const port = await startBroker();
    await expect(
      registerRoute(
        port,
        routeCredential,
        "lease",
        routeId,
        dataPath,
        dataPath,
        transportPort,
      ),
    ).rejects.toThrow("HTTP 401");
  },
);

test("rejects a registration whose transport port is the listening broker's", async () => {
  const dataPath = vaultFile();
  await writeVault(dataPath, {});
  const port = await startBroker();
  await expect(
    registerRoute(
      port,
      routeCredential,
      "lease",
      routeId,
      dataPath,
      dataPath,
      port,
    ),
  ).rejects.toThrow("HTTP 401");
});

describe("route authorization", () => {
  async function registered(settings: Record<string, unknown>) {
    const file = await vaultTarget("vault", "vault", [
      { id: "selected", token: "selected-token" },
      { id: "other", token: "other-token" },
    ]);
    const stored = JSON.parse(await fsp.readFile(file, "utf8"));
    stored.mcpClientConfig.codexDiscovery = routeSettings(file, settings);
    await fsp.writeFile(file, JSON.stringify(stored));
    const port = await startBroker();
    await registerRoute(port, routeCredential, "lease", routeId, file);
    return port;
  }
  const call = (port: number, token?: string) =>
    request(port, { path: `/v1/${routeId}/mcp`, token, body: "{}" });

  test("forwards a vault token unchanged so the vault resolves its own client", async () => {
    const port = await registered({ enabled: true, tokenId: "selected" });
    expect((await call(port, "other-token")).body).toBe(
      "vault|Bearer other-token",
    );
  });

  test("ignores stored Codex keys and forwards a client bearer unchanged", async () => {
    const port = await registered({ enabled: true, tokenId: "selected" });
    expect((await call(port, "selected-token")).body).toBe(
      "vault|Bearer selected-token",
    );
  });

  test("forwards the route credential unchanged so the vault rejects it", async () => {
    const port = await registered({ enabled: true, tokenId: "selected" });
    expect((await call(port, routeCredential)).body).toBe(
      `vault|Bearer ${routeCredential}`,
    );
  });

  test("forwards a request without Authorization so the vault answers it", async () => {
    const port = await registered({});
    expect((await call(port)).body).toBe("vault|");
  });
});

describe("bare /mcp token routing", () => {
  const otherRoute = "123e4567-e89b-42d3-a456-426614174001";

  async function twoVaults(secondTokens: Array<{ id: string; token: string }>) {
    const first = await vaultTarget("first", "first", [
      { id: "a", token: "first-token" },
    ]);
    const second = await vaultTarget("second", "second", secondTokens);
    const stored = JSON.parse(await fsp.readFile(second, "utf8"));
    stored.mcpClientConfig.codexDiscovery = routeSettings(second, {
      routeId: otherRoute,
    });
    await fsp.writeFile(second, JSON.stringify(stored));
    const port = await startBroker();
    await registerRoute(port, routeCredential, "lease", routeId, first);
    await registerRoute(port, routeCredential, "lease", otherRoute, second);
    return port;
  }

  test("forwards to the one vault whose token store holds the bearer", async () => {
    const port = await twoVaults([{ id: "b", token: "second-token" }]);
    const first = await request(port, {
      path: "/mcp",
      token: "first-token",
      body: "{}",
    });
    const second = await request(port, {
      path: "/mcp?probe=1",
      token: "second-token",
      body: "{}",
    });
    expect(first.body).toBe("first|Bearer first-token");
    expect(second.body).toBe("second|Bearer second-token");
  });

  test("answers 401 for a token no open vault holds", async () => {
    const port = await twoVaults([{ id: "b", token: "second-token" }]);
    for (const token of ["unknown-token", undefined]) {
      expect(
        (await request(port, { path: "/mcp", token, body: "{}" })).status,
      ).toBe(401);
    }
  });

  test("answers 405 for GET, like the vault does before checking auth", async () => {
    const port = await twoVaults([{ id: "b", token: "second-token" }]);
    expect((await request(port, { path: "/mcp" })).status).toBe(405);
  });

  test("refuses a token two open vaults share with 409 naming the copy action", async () => {
    const port = await twoVaults([{ id: "a", token: "first-token" }]);
    const result = await request(port, {
      path: "/mcp",
      token: "first-token",
      body: "{}",
    });
    expect(result.status).toBe(409);
    expect(result.body).toContain("Make this copy independent");
  });
});

test("the fixed listener permits only one broker while the winner remains healthy", async () => {
  const port = await startBroker();
  await expect(startBrokerServer({ port, pluginId })).rejects.toMatchObject({
    code: "EADDRINUSE",
  });
  const health = await request(port, { path: HEALTH_PATH });
  expect(health.status).toBe(200);
  expect(JSON.parse(health.body).name).toBe(BROKER_NAME);
});

test("close() drops control connections and forwarded streams, then frees the port", async () => {
  let upstreamClosed!: () => void;
  const upstreamGone = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  const target = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: open\n\n");
    res.once("close", upstreamClosed);
  });
  servers.push(target);
  const dataPath = vaultFile();
  transportPorts.set(dataPath, await listen(target));
  await writeVault(dataPath, {});
  const broker = await startBrokerServer({ port: 0, pluginId });
  const control = await registerRoute(broker.port, routeCredential, "lease");
  const downstreamEnded = new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: broker.port,
        path: `/v1/${routeId}/mcp`,
        method: "POST",
        headers: { "content-length": "2" },
      },
      (res) => {
        res.once("data", () => {
          res.once("close", resolve);
          // Close while the stream is still open on both sides
          void broker.close();
        });
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  await downstreamEnded;
  await broker.close();
  await upstreamGone;
  await control.close();
  // Nothing listens any more: the same port binds again
  const rebound = http.createServer();
  await listen(rebound, broker.port);
  await close(rebound);
});

test("broker applies the vault Origin policy before health, registration and routing", async () => {
  const port = await startBroker();
  const paths = [
    HEALTH_PATH,
    `${REGISTRATION_PATH}/${routeId}`,
    `/v1/${routeId}/mcp`,
    "/mcp",
  ];
  for (const origin of [
    undefined,
    "http://localhost:3000",
    "https://127.0.0.1:443",
    "https://evil.example",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example",
    "null",
    "http://localhost/",
    "http://localhost, http://evil.example",
  ]) {
    for (const url of paths) {
      const result = await request(port, {
        path: url,
        ...(url.includes("/register/") ? { body: "{}" } : {}),
        headers: origin === undefined ? {} : { origin },
      });
      expect(result.status).toBe(
        isOriginAllowed(origin)
          ? url === HEALTH_PATH
            ? 200
            : url.includes("/register/")
              ? 401
              : url === "/mcp"
                ? 405
                : 404
          : 403,
      );
    }
  }
});

test("broker rejects unexpected Host headers on every endpoint", async () => {
  const port = await startBroker();
  for (const host of [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `evil.example:${port}`,
    `127.0.0.1.evil.example:${port}`,
    `127.0.0.1:${port + 1}`,
    "127.0.0.1",
  ]) {
    const allowed =
      host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    for (const url of [
      HEALTH_PATH,
      `${REGISTRATION_PATH}/${routeId}`,
      `/v1/${routeId}/mcp`,
    ]) {
      const result = await request(port, {
        path: url,
        ...(url.includes("/register/") ? { body: "{}" } : {}),
        headers: { host },
      });
      expect(result.status).toBe(
        allowed
          ? url === HEALTH_PATH
            ? 200
            : url.includes("/register/")
              ? 401
              : 404
          : 403,
      );
    }
  }
});

test("pending registration cap preserves live routes and releases failed admission slots", async () => {
  const file = await vaultTarget("original", "vault");
  // Registration deadlines expire only when the test fires them, and an
  // armed deadline marks an admitted registration
  const deadlines = new Set<() => void>();
  let slotsTaken!: () => void;
  const allSlotsTaken = new Promise<void>((resolve) => {
    slotsTaken = resolve;
  });
  const broker = await startBrokerServer({
    port: 0,
    pluginId,
    registrationDeadline: (expire) => {
      deadlines.add(expire);
      if (deadlines.size === MAX_PENDING_REGISTRATIONS) slotsTaken();
      return () => deadlines.delete(expire);
    },
  });
  brokers.push(broker);
  const port = broker.port;
  await registerRoute(port, routeCredential, "lease", routeId, file);
  const pending: http.ClientRequest[] = [];
  const outcomes: Promise<number>[] = [];
  for (let i = 0; i < MAX_PENDING_REGISTRATIONS; i++) {
    outcomes.push(
      new Promise<number>((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: `${REGISTRATION_PATH}/${routeId}`,
            headers: { "content-length": "2" },
          },
          (res) => {
            res.resume();
            res.once("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", () => resolve(0));
        // A partial body keeps the registration pending
        req.write("{");
        pending.push(req);
      }),
    );
  }
  try {
    await allSlotsTaken;
    expect(
      (
        await request(port, {
          path: `${REGISTRATION_PATH}/${routeId}`,
          body: "{}",
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await request(port, {
          path: `/v1/${routeId}/mcp`,
          token: "vault-token",
          body: "{}",
        })
      ).body,
    ).toBe("original|Bearer vault-token");
    expect((await request(port, { path: HEALTH_PATH })).status).toBe(200);

    pending[0].end("}");
    expect(await outcomes[0]).toBe(401);
    pending[1].destroy();
    // The remaining incomplete bodies reach their deadline
    for (const expire of [...deadlines]) expire();
    await Promise.all(outcomes);
    expect(deadlines.size).toBe(0);
    const other = await vaultTarget("other", "other");
    const stored = JSON.parse(await fsp.readFile(other, "utf8"));
    stored.mcpClientConfig.codexDiscovery = routeSettings(other, {
      routeId: "123e4567-e89b-42d3-a456-426614174001",
    });
    await fsp.writeFile(other, JSON.stringify(stored));
    await registerRoute(
      port,
      routeCredential,
      "lease",
      "123e4567-e89b-42d3-a456-426614174001",
      other,
    );
    expect(
      (
        await request(port, {
          path: `/v1/${routeId}/mcp`,
          token: "vault-token",
          body: "{}",
        })
      ).body,
    ).toBe("original|Bearer vault-token");
  } finally {
    for (const req of pending) req.destroy();
  }
});

test("a copied route cannot overwrite or unregister the existing owner", async () => {
  const first = await vaultTarget("original", "original");
  const copy = await vaultTarget("copy", "copy");
  const port = await startBroker();
  await registerRoute(port, routeCredential, "lease", routeId, first);
  await expect(
    registerRoute(port, routeCredential, "lease", routeId, copy),
  ).rejects.toThrow("HTTP 409");
  expect(
    (
      await request(port, {
        path: `/v1/${routeId}/mcp`,
        token: "vault-token",
        body: "{}",
      })
    ).body,
  ).toBe("original|Bearer vault-token");
});

test("a same-vault reconnect evicts its own stale control instead of a 409", async () => {
  const file = await vaultTarget("second-connection", "vault");
  const port = await startBroker();
  const first = await registerRoute(
    port,
    routeCredential,
    "lease",
    routeId,
    file,
  );
  // First is still open here. A same-dataPath registration must evict it
  // instead of rejecting with 409, unlike a copied vault's different dataPath.
  const second = await registerRoute(
    port,
    routeCredential,
    "lease",
    routeId,
    file,
  );
  expect(
    (
      await request(port, {
        path: `/v1/${routeId}/mcp`,
        token: "vault-token",
        body: "{}",
      })
    ).body,
  ).toBe("second-connection|Bearer vault-token");
  // The evicted first control is already closed broker-side; close() must be safe to call anyway.
  await first.close();
  await second.close();
});

/** One plugin instance registering with its own lease, header and body alike. */
function registerInstance(port: number, lease: string, file: string) {
  return registerRoute(
    port,
    routeCredential,
    lease,
    routeId,
    file,
    file,
    transportPorts.get(file),
    lease,
  );
}

test("two plugin instances on one data file stop evicting each other", async () => {
  const file = await vaultTarget("shared", "vault");
  const port = await startBroker();
  // A restart evicts the stale control once. Another instance on the same
  // data file does it on every reconnect, so the allowance runs out.
  for (const lease of ["a", "b", "a", "b"]) {
    await registerInstance(port, lease, file);
  }
  await expect(registerInstance(port, "a", file)).rejects.toThrow("HTTP 409");
  // The holder keeps its route
  expect(
    (
      await request(port, {
        path: `/v1/${routeId}/mcp`,
        token: "vault-token",
        body: "{}",
      })
    ).body,
  ).toBe("shared|Bearer vault-token");
});

test("reconnects on one lease never count as evictions", async () => {
  const file = await vaultTarget("vault", "vault");
  const port = await startBroker();
  for (let i = 0; i < 6; i += 1) {
    await registerRoute(port, routeCredential, "lease", routeId, file);
  }
});

describe("registration ownership", () => {
  const dataPath = () => vaultFile();

  test("admits a vault whose Codex connection is off", async () => {
    await writeVault(dataPath(), {
      settings: routeSettings(dataPath(), { enabled: false, tokenId: null }),
    });
    const port = await startBroker();
    await registerRoute(port, routeCredential, "lease");
  });

  test.each([
    [
      "names a different route",
      { routeId: "123e4567-e89b-42d3-a456-426614174099" },
    ],
    ["was saved at another location", { dataPath: "synthetic/copy/data.json" }],
    ["holds a rotated credential", { accessToken: "a-newer-rotated-token" }],
  ])("rejects a registration whose saved settings %s", async (_, override) => {
    await writeVault(dataPath(), {
      settings: routeSettings(dataPath(), override),
    });
    const port = await startBroker();
    await expect(registerRoute(port, routeCredential, "lease")).rejects.toThrow(
      "HTTP 401",
    );
  });

  test("rejects a missing, corrupt or oversized data file, which the vault's diagnosis names", async () => {
    const port = await startBroker();
    /** Refused with a bare 401, while the vault's own check names why. */
    const refused = async (file: string, reason: string) => {
      const result = await request(port, {
        path: `${REGISTRATION_PATH}/${routeId}`,
        token: routeCredential,
        body: JSON.stringify({
          version: BROKER_PROTOCOL_VERSION,
          routeId,
          dataPath: file,
          leaseId: "lease",
          port: UNUSED_PORT,
        }),
        headers: { [LEASE_HEADER]: "lease" },
      });
      expect(result.status).toBe(401);
      expect(JSON.parse(result.body)).toEqual({ error: "unauthorized" });
      const diagnosis = await diagnosePluginDataFile(file, pluginId);
      expect(diagnosis).toContain(file);
      expect(diagnosis).toContain(reason);
    };
    await refused(vaultFile("missing"), "cannot be read (ENOENT)");

    const corrupt = vaultFile("corrupt");
    await fsp.mkdir(path.dirname(corrupt), { recursive: true, mode: 0o700 });
    await fsp.writeFile(corrupt, "not json", { mode: 0o600 });
    await refused(corrupt, "is not valid JSON");

    const oversized = vaultFile("oversized");
    await fsp.mkdir(path.dirname(oversized), { recursive: true, mode: 0o700 });
    await fsp.writeFile(
      oversized,
      JSON.stringify({
        mcpClientConfig: { codexDiscovery: routeSettings(oversized) },
        padding: "x".repeat(1024 * 1024),
      }),
      { mode: 0o600 },
    );
    await refused(oversized, "is larger than 1 MB");
  });

  test("admits only the plugin's own data.json path", async () => {
    const port = await startBroker();
    const pluginsDir = path.join(
      tempDir,
      "unnormalized",
      ".obsidian",
      "plugins",
    );
    await fsp.mkdir(path.join(pluginsDir, "other"), { recursive: true });
    const wrongPaths = [
      path.join(tempDir, "data.json"),
      vaultFile("other-plugin", "another-plugin"),
      path.join(path.dirname(vaultFile("renamed")), "settings.json"),
      path.join(
        tempDir,
        "snippets",
        ".obsidian",
        "snippets",
        pluginId,
        "data.json",
      ),
      // Resolves to a valid file, but is not the canonical path a vault sends
      [pluginsDir, "other", "..", pluginId, "data.json"].join(path.sep),
    ];
    await writeVault(path.join(pluginsDir, pluginId, "data.json"), {});
    for (const file of wrongPaths) {
      // Each file names itself, so only its path can fail the check
      if (!file.includes(`${path.sep}..${path.sep}`))
        await writeVault(file, {});
      const stored = JSON.parse(await fsp.readFile(file, "utf8"));
      stored.mcpClientConfig.codexDiscovery = routeSettings(file);
      await fsp.writeFile(file, JSON.stringify(stored));
      await expect(
        registerRoute(port, routeCredential, "lease", routeId, file),
      ).rejects.toThrow("HTTP 401");
      expect(await diagnosePluginDataFile(file, pluginId)).toContain(
        `is not this plugin's data file, <vault>/<config folder>/plugins/${pluginId}/data.json`,
      );
    }

    const valid = vaultFile("valid");
    await writeVault(valid, {});
    expect(await diagnosePluginDataFile(valid, pluginId)).toBeNull();
    await registerRoute(port, routeCredential, "lease", routeId, valid);
  });

  test("admits a linked plugin folder, as bun run link creates", async () => {
    const file = await vaultTarget("linked", "vault");
    // The plugin's checkout lives outside the vault, linked in by its ID
    const checkout = path.join(tempDir, "checkout");
    await fsp.rename(path.dirname(file), checkout);
    await fsp.symlink(
      checkout,
      path.dirname(file),
      process.platform === "win32" ? "junction" : "dir",
    );
    const port = await startBroker();
    await registerRoute(port, routeCredential, "lease", routeId, file);
    expect(await diagnosePluginDataFile(file, pluginId)).toBeNull();
    expect(
      (
        await request(port, {
          path: `/v1/${routeId}/mcp`,
          token: "vault-token",
          body: "{}",
        })
      ).body,
    ).toBe("linked|Bearer vault-token");
  });
});

describe.skipIf(process.platform === "win32")(
  "registration file ownership on POSIX",
  () => {
    const pluginsDir = (file: string) => path.dirname(path.dirname(file));
    /** Move the plugin folder out of the vault and link it back by its ID. */
    const linkPluginFolder = async (file: string) => {
      const checkout = path.join(tempDir, "checkout");
      await fsp.rename(path.dirname(file), checkout);
      await fsp.symlink(checkout, path.dirname(file));
      return checkout;
    };

    test.each([
      [
        "a world-writable data file",
        (file: string) => fsp.chmod(file, 0o602),
        (file: string) =>
          `Every user on this computer can write to the data file ${file}. Remove that write access, for example with chmod o-w`,
      ],
      [
        "a world-writable plugin folder",
        (file: string) => fsp.chmod(path.dirname(file), 0o707),
        (file: string) =>
          `Every user on this computer can write to the plugin folder ${path.dirname(file)}`,
      ],
      [
        "a world-writable plugins folder",
        (file: string) => fsp.chmod(pluginsDir(file), 0o707),
        (file: string) =>
          `Every user on this computer can write to the plugins folder ${pluginsDir(file)}`,
      ],
      [
        "a symlinked data file",
        async (file: string) => {
          const elsewhere = path.join(tempDir, "elsewhere.json");
          await fsp.rename(file, elsewhere);
          await fsp.symlink(elsewhere, file);
        },
        (file: string) =>
          `The data file ${file} is a link or not a regular file`,
      ],
      [
        // Whoever can replace it could point the plugin folder anywhere
        "a symlinked plugins folder",
        async (file: string) => {
          const elsewhere = path.join(tempDir, "elsewhere");
          await fsp.rename(pluginsDir(file), elsewhere);
          await fsp.symlink(elsewhere, pluginsDir(file));
        },
        (file: string) =>
          `The plugins folder ${pluginsDir(file)} is a link or not a folder`,
      ],
      [
        "a linked plugin folder that every user can write",
        async (file: string) => {
          await fsp.chmod(await linkPluginFolder(file), 0o707);
        },
        (file: string) =>
          `Every user on this computer can write to the plugin folder ${path.dirname(file)}`,
      ],
    ])(
      "rejects %s, and the vault's diagnosis names it",
      async (_label, change, reason) => {
        const file = vaultFile();
        await writeVault(file, {});
        const port = await startBroker();
        await change(file);
        await expect(
          registerRoute(port, routeCredential, "lease"),
        ).rejects.toThrow("HTTP 401");
        expect(await diagnosePluginDataFile(file, pluginId)).toContain(
          reason(file),
        );
      },
    );

    test.each([
      ["data file", (file: string) => file],
      ["plugin folder", (file: string) => path.dirname(file)],
      ["plugins folder", pluginsDir],
    ])(
      "admits a %s writable by the user's own primary group (umask 002), but not by another group",
      async (label, entry) => {
        const file = vaultFile();
        await writeVault(file, {});
        const port = await startBroker();
        await fsp.chmod(entry(file), label === "data file" ? 0o620 : 0o770);
        const gid = process.getgid!();
        const getgid = spyOn(process, "getgid").mockReturnValue(gid + 1);
        try {
          await expect(
            registerRoute(port, routeCredential, "lease"),
          ).rejects.toThrow("HTTP 401");
          expect(await diagnosePluginDataFile(file, pluginId)).toContain(
            `A group other than your own can write to the ${label} ${entry(file)}. Remove the group's write access, for example with chmod g-w`,
          );
        } finally {
          getgid.mockRestore();
        }
        await registerRoute(port, routeCredential, "lease");
      },
    );

    test("rejects a data file owned by another user, then admits the owner", async () => {
      const file = vaultFile();
      await writeVault(file, {});
      const port = await startBroker();
      const uid = process.getuid!();
      const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
      try {
        await expect(
          registerRoute(port, routeCredential, "lease"),
        ).rejects.toThrow("HTTP 401");
        // The first entry checked is the plugins folder
        expect(await diagnosePluginDataFile(file, pluginId)).toContain(
          `The plugins folder ${pluginsDir(file)} is not owned by your user account`,
        );
      } finally {
        getuid.mockRestore();
      }
      await registerRoute(port, routeCredential, "lease");
    });
  },
);

test("reads the data file it checked, not one swapped in after the open", async () => {
  const file = await vaultTarget("vault", "vault");
  // The substitute differs only in its token, so the file actually read
  // decides whether bare /mcp routes the bearer to this vault
  const original = JSON.parse(await fsp.readFile(file, "utf8"));
  const substitute = structuredClone(original);
  substitute.mcpTransport.tokens = [
    { id: "selected", token: "substitute-token" },
  ];
  const staged = path.join(tempDir, "staged.json");
  await fsp.writeFile(staged, JSON.stringify(substitute), { mode: 0o600 });
  const port = await startBroker();
  await registerRoute(port, routeCredential, "lease", routeId, file);
  const call = (token = "vault-token") =>
    request(port, { path: "/mcp", token, body: "{}" });

  const open = fsp.open;
  const swap = spyOn(fsp, "open").mockImplementation(
    async (...args: Parameters<typeof fsp.open>) => {
      swap.mockRestore();
      const handle = await open(...args);
      // Moved rather than overwritten: Windows refuses to replace an open file
      await fsp.rename(file, path.join(tempDir, "opened.json"));
      await fsp.rename(staged, file);
      return handle;
    },
  );
  try {
    expect((await call()).body).toBe("vault|Bearer vault-token");
  } finally {
    swap.mockRestore();
  }
  // The swap held: the next read opens the substitute
  expect((await call()).status).toBe(401);
  expect((await call("substitute-token")).body).toBe(
    "vault|Bearer substitute-token",
  );
});

describe.skipIf(process.platform === "win32")(
  "data file checks on every forwarded request",
  () => {
    const route = `/v1/${routeId}/mcp`;

    /** Forwarding works, then stops once `change` lands. */
    async function stopsAfter(
      file: string,
      change: () => Promise<(() => void) | void>,
    ) {
      const port = await startBroker();
      await registerRoute(port, routeCredential, "lease", routeId, file);
      const routed = await request(port, {
        path: route,
        token: "vault-token",
        body: "{}",
      });
      expect(routed.body).toBe("vault|Bearer vault-token");
      const restore = await change();
      try {
        expect(
          (
            await request(port, {
              path: route,
              token: "vault-token",
              body: "{}",
            })
          ).status,
        ).toBe(503);
        // Bare /mcp finds no vault that holds the token either
        expect(
          (
            await request(port, {
              path: "/mcp",
              token: "vault-token",
              body: "{}",
            })
          ).status,
        ).toBe(401);
      } finally {
        restore?.();
      }
    }

    test.each([
      [
        "made world-writable",
        async (file: string) => {
          await fsp.chmod(file, 0o602);
        },
      ],
      [
        "made writable by another group",
        async (file: string) => {
          await fsp.chmod(file, 0o620);
          const gid = process.getgid!();
          const getgid = spyOn(process, "getgid").mockReturnValue(gid + 1);
          return () => getgid.mockRestore();
        },
      ],
      [
        "in a plugins folder made world-writable",
        async (file: string) => {
          await fsp.chmod(path.dirname(path.dirname(file)), 0o707);
        },
      ],
      [
        "owned by another user",
        async () => {
          const uid = process.getuid!();
          const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
          return () => getuid.mockRestore();
        },
      ],
      [
        "replaced by a link",
        async (file: string) => {
          const elsewhere = path.join(tempDir, "elsewhere.json");
          await fsp.rename(file, elsewhere);
          await fsp.symlink(elsewhere, file);
        },
      ],
      [
        // Opening one for reading would wait for a writer
        "replaced by a FIFO",
        async (file: string) => {
          await fsp.rm(file);
          execFileSync("mkfifo", ["-m", "600", file]);
        },
      ],
    ])(
      "forwarding stops once the data file is %s after admission",
      async (_label, change) => {
        const file = await vaultTarget("vault", "vault");
        await stopsAfter(file, () => change(file));
      },
    );

    test("forwarding stops once a linked ancestor points at a file the user does not control", async () => {
      // The vault is reached through a link, like one an attacker controls
      const link = path.join(tempDir, "link");
      await fsp.mkdir(path.join(tempDir, "real"));
      await fsp.symlink(path.join(tempDir, "real"), link);
      const file = await vaultTarget("vault", path.join("link", "vault"));
      // The same tree elsewhere, with a data file anyone can write
      const decoy = path.join(tempDir, "decoy");
      const decoyFile = path.join(decoy, path.relative(link, file));
      await fsp.mkdir(path.dirname(decoyFile), {
        recursive: true,
        mode: 0o700,
      });
      await fsp.copyFile(file, decoyFile);
      await fsp.chmod(decoyFile, 0o666);
      await stopsAfter(file, async () => {
        await fsp.unlink(link);
        await fsp.symlink(decoy, link);
      });
    });
  },
);

describe("route requests check the data file without reading it", () => {
  const route = `/v1/${routeId}/mcp`;
  const call = (port: number, path: string) =>
    request(port, { path, token: "vault-token", body: "{}" });

  async function registered() {
    const file = await vaultTarget("vault", "vault");
    const port = await startBroker();
    await registerRoute(port, routeCredential, "lease", routeId, file);
    expect((await call(port, route)).body).toBe("vault|Bearer vault-token");
    return { file, port };
  }

  test("a route request opens and checks the file but never reads it, while bare /mcp reads it", async () => {
    const { file, port } = await registered();
    // The broker's handles on the data file, each with its reads
    const handles: Array<{ mock: { calls: unknown[] } }> = [];
    const open = fsp.open;
    const spy = spyOn(fsp, "open").mockImplementation(
      async (...args: Parameters<typeof fsp.open>) => {
        const handle = await open(...args);
        if (args[0] === file) handles.push(spyOn(handle, "read"));
        return handle;
      },
    );
    const readFrom = () =>
      handles.filter((handle) => handle.mock.calls.length > 0).length;
    try {
      expect((await call(port, route)).body).toBe("vault|Bearer vault-token");
      expect(handles.length).toBe(1);
      expect(readFrom()).toBe(0);
      expect((await call(port, "/mcp")).body).toBe("vault|Bearer vault-token");
      expect(handles.length).toBe(2);
      expect(readFrom()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a file grown over 1 MB after admission stops forwarding", async () => {
    const { file, port } = await registered();
    const stored = JSON.parse(await fsp.readFile(file, "utf8"));
    stored.padding = "x".repeat(1024 * 1024);
    await fsp.writeFile(file, JSON.stringify(stored));
    expect((await call(port, route)).status).toBe(503);
    expect((await call(port, "/mcp")).status).toBe(401);
  });

  test("a file that turns into invalid JSON after admission still forwards the bearer unchanged", async () => {
    const { file, port } = await registered();
    await fsp.writeFile(file, "not json");
    expect((await call(port, route)).body).toBe("vault|Bearer vault-token");
    // Bare /mcp needs the token store, so it finds no vault
    expect((await call(port, "/mcp")).status).toBe(401);
  });
});

test("concurrent clients share one broker and closing another vault preserves its sibling", async () => {
  const first = await vaultTarget("first", "first");
  const second = await vaultTarget("second", "second");
  const id = "123e4567-e89b-42d3-a456-426614174001";
  const stored = JSON.parse(await fsp.readFile(second, "utf8"));
  stored.mcpClientConfig.codexDiscovery = routeSettings(second, {
    routeId: id,
  });
  await fsp.writeFile(second, JSON.stringify(stored));
  const port = await startBroker();
  const a = await registerRoute(port, routeCredential, "lease", routeId, first);
  await registerRoute(port, routeCredential, "lease", id, second);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      request(port, {
        path: `/v1/${i % 2 ? id : routeId}/mcp`,
        token: "vault-token",
        body: "{}",
      }),
    ),
  );
  expect(results.map((result) => result.body.split("|")[0])).toEqual(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? "second" : "first")),
  );
  await a.close();
  await waitForStatus(port, `/v1/${routeId}/mcp`, "vault-token", 404);
  expect(
    (
      await request(port, {
        path: `/v1/${id}/mcp`,
        token: "vault-token",
        body: "{}",
      })
    ).body,
  ).toBe("second|Bearer vault-token");
});

test("downstream stream closure releases only that upstream connection", async () => {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const target = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: test\n\n");
    res.once("close", finish);
  });
  servers.push(target);
  const dataPath = vaultFile();
  transportPorts.set(dataPath, await listen(target));
  await writeVault(dataPath, {});
  const port = await startBroker();
  await registerRoute(port, routeCredential, "lease");
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/v1/${routeId}/mcp`,
        method: "POST",
        headers: {
          authorization: `Bearer ${routeCredential}`,
          "content-length": "2",
        },
      },
      (res) => {
        res.once("data", () => {
          res.destroy();
          req.destroy();
          resolve();
        });
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  // Bounded by the test timeout: the upstream must close on its own
  await closed;
  expect((await request(port, { path: HEALTH_PATH })).status).toBe(200);
});
