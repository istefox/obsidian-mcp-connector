import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "module";
import { spawn, spawnSync } from "child_process";
import fsp from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { isOriginAllowed } from "../src/features/mcp-transport/services/origin";

const require = createRequire(import.meta.url);
const broker = require("./discoveryBroker.js") as {
  BROKER_NAME: string;
  BROKER_VERSION: number;
  IDLE_EXIT_MS: number;
  MAX_PENDING_REGISTRATIONS: number;
  parseRegistration(value: unknown): unknown;
  parseTransportFile(
    raw: string,
    tokenId: string,
  ): { port: number; token: string } | { error: string };
  sha256(value: string): string;
  startBroker(options: {
    rootDir: string;
    port: number;
    idleExitMs?: number;
  }): http.Server;
};

const routeId = "123e4567-e89b-42d3-a456-426614174000";
const clientToken = "stable-client-token";
const nodeCommand = process.platform === "win32" ? "node.exe" : "node";
const systemNodeTest =
  spawnSync(nodeCommand, ["--version"], { stdio: "ignore" }).status === 0
    ? test
    : test.skip;
let tempDir = "";
const servers: http.Server[] = [];
const controls: Array<{ close(): Promise<void> }> = [];

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
        method: options.body === undefined ? "GET" : "POST",
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
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function registerRoute(
  port: number,
  token: string,
  leaseId: string,
  id = routeId,
  vaultPath = path.join(tempDir, "data.json"),
): Promise<{ close(): Promise<void> }> {
  const stored = JSON.parse(
    await fsp.readFile(vaultPath, "utf8").catch(() => "{}"),
  );
  stored.mcpClientConfig = {
    codexDiscovery: {
      enabled: true,
      routeId: id,
      tokenId: "selected",
      accessToken: clientToken,
    },
  };
  await fsp.writeFile(vaultPath, JSON.stringify(stored));
  const body = JSON.stringify({
    version: broker.BROKER_VERSION,
    routeId: id,
    dataPath: vaultPath,
    tokenId: "selected",
    accessTokenHash: broker.sha256(clientToken),
    leaseId: "lease",
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/_obsidian_mcp_broker/register/${id}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": String(Buffer.byteLength(body)),
          "x-obsidian-mcp-lease-id": leaseId,
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

async function waitForStatus(
  port: number,
  path: string,
  token: string,
  status: number,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await request(port, { path, token, body: "{}" });
    if (response.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`route did not return HTTP ${status}`);
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-discovery-broker-"));
  await fsp.mkdir(path.join(tempDir, "routes"), { recursive: true });
});

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
  await Promise.all(servers.splice(0).map(close));
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe("discovery broker parsing", () => {
  test("uses a ten-second idle window", () => {
    expect(broker.IDLE_EXIT_MS).toBe(10_000);
  });

  test("validates registrations and resolves only the selected token", () => {
    const registration = {
      version: broker.BROKER_VERSION,
      routeId,
      dataPath: path.join(tempDir, "data.json"),
      tokenId: "b",
      accessTokenHash: broker.sha256(clientToken),
      leaseId: "lease",
    };
    expect(broker.parseRegistration(registration)).toEqual(registration);
    expect(
      broker.parseRegistration({ ...registration, leaseId: "" }),
    ).toBeNull();

    const parsed = broker.parseTransportFile(
      JSON.stringify({
        mcpTransport: {
          livePort: 27203,
          bearerToken: "legacy-secret",
          tokens: [
            { id: "a", token: "a-secret" },
            { id: "b", token: "b-secret" },
          ],
        },
      }),
      "b",
    );
    expect(parsed).toEqual({ port: 27203, token: "b-secret" });
  });
});

systemNodeTest("the broker source starts under system Node.js", async () => {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const scriptPath = path.join(tempDir, "discoveryBroker.js");
  await fsp.copyFile(
    path.join(import.meta.dir, "discoveryBroker.js"),
    scriptPath,
  );
  const child = spawn(
    nodeCommand,
    [scriptPath, "--root", tempDir, "--port", String(port)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await request(port, {
          path: "/_obsidian_mcp_broker/health",
        });
        if (response.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(healthy, stderr).toBe(true);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill();
      await exited;
    }
  }
});

test("one stable route discovers changed vault ports and tokens on every request", async () => {
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
      req.on("data", (chunk) => (body += chunk));
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
  const dataPath = path.join(tempDir, "data.json");

  const writeVaultData = (port: number, token: string) =>
    fsp.writeFile(
      dataPath,
      JSON.stringify({
        mcpClientConfig: {
          codexDiscovery: {
            enabled: true,
            routeId,
            tokenId: "selected",
            accessToken: clientToken,
          },
        },
        mcpTransport: {
          livePort: port,
          tokens: [{ id: "selected", token }],
        },
      }),
      "utf8",
    );
  await writeVaultData(firstPort, "first-vault-token");

  const front = broker.startBroker({
    rootDir: tempDir,
    port: 0,
    idleExitMs: 60_000,
  });
  servers.push(front);
  const brokerPort = await new Promise<number>((resolve) => {
    front.on("listening", () => {
      const address = front.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const route = `/v1/${routeId}/mcp`;
  expect(
    (await request(brokerPort, { path: route, token: clientToken, body: "{}" }))
      .status,
  ).toBe(404);
  await expect(registerRoute(brokerPort, "wrong", "lease")).rejects.toThrow(
    "HTTP 401",
  );
  await expect(
    registerRoute(brokerPort, clientToken, "wrong-lease"),
  ).rejects.toThrow("HTTP 401");
  const control = await registerRoute(brokerPort, clientToken, "lease");
  const first = await request(brokerPort, {
    path: route,
    token: clientToken,
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });

  await writeVaultData(secondPort, "second-vault-token");
  const second = await request(brokerPort, {
    path: route,
    token: clientToken,
    body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  });

  expect(first.status).toBe(200);
  expect(first.body).toContain("first");
  expect(first.headers["mcp-session-id"]).toBe("first-session");
  expect(second.status).toBe(200);
  expect(second.body).toContain("second");
  expect(seen.map((entry) => entry.authorization)).toEqual([
    "Bearer first-vault-token",
    "Bearer second-vault-token",
  ]);
  expect(seen.map((entry) => entry.protocolVersion)).toEqual([
    "2026-07-28",
    "2026-07-28",
  ]);
  expect(seen.map((entry) => entry.sessionId)).toEqual([
    "client-session",
    "client-session",
  ]);
  expect(
    (await request(brokerPort, { path: route, token: "wrong", body: "{}" }))
      .status,
  ).toBe(401);
  const health = await request(brokerPort, {
    path: "/_obsidian_mcp_broker/health",
  });
  expect(health.status).toBe(200);
  expect(JSON.parse(health.body)).toEqual({
    name: broker.BROKER_NAME,
    version: broker.BROKER_VERSION,
  });

  await control.close();
  await waitForStatus(brokerPort, route, clientToken, 404);
});

test("the fixed listener permits only one broker while the winner remains healthy", async () => {
  const first = broker.startBroker({
    rootDir: tempDir,
    port: 0,
    idleExitMs: 60_000,
  });
  servers.push(first);
  const port = await new Promise<number>((resolve) => {
    first.on("listening", () => {
      const address = first.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  const second = broker.startBroker({
    rootDir: tempDir,
    port,
    idleExitMs: 60_000,
  });
  const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
    second.once("error", resolve);
  });
  expect(error.code).toBe("EADDRINUSE");

  const health = await request(port, {
    path: "/_obsidian_mcp_broker/health",
  });
  expect(health.status).toBe(200);
  expect(JSON.parse(health.body).name).toBe(broker.BROKER_NAME);
});

test("an open control connection prevents idle exit until the vault disconnects", async () => {
  const front = broker.startBroker({
    rootDir: tempDir,
    port: 0,
    idleExitMs: 20,
  });
  servers.push(front);
  const brokerPort = await new Promise<number>((resolve) => {
    front.on("listening", () => {
      const address = front.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const control = await registerRoute(brokerPort, clientToken, "lease");

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(front.listening).toBe(true);

  const closed = new Promise<void>((resolve) => front.once("close", resolve));
  await control.close();
  await Promise.race([
    closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("broker did not exit when idle")), 100),
    ),
  ]);
  expect(front.listening).toBe(false);
});

async function frontPort(): Promise<number> {
  const front = broker.startBroker({
    rootDir: path.join(tempDir, "broker"),
    port: 0,
    idleExitMs: 60_000,
  });
  servers.push(front);
  return new Promise((resolve) =>
    front.once("listening", () =>
      resolve((front.address() as { port: number }).port),
    ),
  );
}

async function vaultTarget(label: string, filename: string): Promise<string> {
  const target = http.createServer((_req, res) => res.end(label));
  servers.push(target);
  const port = await listen(target);
  const file = path.join(tempDir, filename);
  await fsp.writeFile(
    file,
    JSON.stringify({
      mcpTransport: {
        livePort: port,
        tokens: [{ id: "selected", token: "test-vault-token" }],
      },
    }),
  );
  return file;
}

test("broker applies the vault Origin policy before health, registration and routing", async () => {
  const port = await frontPort();
  const paths = [
    "/_obsidian_mcp_broker/health",
    `/_obsidian_mcp_broker/register/${routeId}`,
    `/v1/${routeId}/mcp`,
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
          ? url.endsWith("/health")
            ? 200
            : url.includes("/register/")
              ? 401
              : 404
          : 403,
      );
    }
  }
});

test("broker rejects unexpected Host headers on every endpoint", async () => {
  const port = await frontPort();
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
      "/_obsidian_mcp_broker/health",
      `/_obsidian_mcp_broker/register/${routeId}`,
      `/v1/${routeId}/mcp`,
    ]) {
      const result = await request(port, {
        path: url,
        ...(url.includes("/register/") ? { body: "{}" } : {}),
        headers: { host },
      });
      expect(result.status).toBe(
        allowed
          ? url.endsWith("/health")
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
  const file = await vaultTarget("original", "data.json");
  const port = await frontPort();
  const server = servers[servers.length - 1];
  await registerRoute(port, clientToken, "lease", routeId, file);
  const pending: http.ClientRequest[] = [];
  const outcomes: Promise<number>[] = [];
  let observed = 0;
  let received!: () => void;
  const allReceived = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("pending requests did not arrive")),
      1000,
    );
    received = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const observe = (req: http.IncomingMessage) => {
    if (
      req.headers["x-test-pending"] === "yes" &&
      ++observed === broker.MAX_PENDING_REGISTRATIONS
    )
      received();
  };
  server.on("request", observe);
  try {
    for (let i = 0; i < broker.MAX_PENDING_REGISTRATIONS; i++) {
      outcomes.push(
        new Promise<number>((resolve) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: `/_obsidian_mcp_broker/register/${routeId}`,
              headers: { "content-length": "2", "x-test-pending": "yes" },
            },
            (res) => {
              res.resume();
              res.once("end", () => resolve(res.statusCode ?? 0));
            },
          );
          req.on("error", () => resolve(0));
          pending.push(req);
          req.write("{");
        }),
      );
    }
    await allReceived;
    expect(
      (
        await request(port, {
          path: `/_obsidian_mcp_broker/register/${routeId}`,
          body: "{}",
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await request(port, {
          path: `/v1/${routeId}/mcp`,
          token: clientToken,
          body: "{}",
        })
      ).body,
    ).toBe("original");
    expect(
      (await request(port, { path: "/_obsidian_mcp_broker/health" })).status,
    ).toBe(200);

    pending[0].end("}");
    expect(await outcomes[0]).toBe(401);
    const other = await vaultTarget("other", "other.json");
    await registerRoute(
      port,
      clientToken,
      "lease",
      "123e4567-e89b-42d3-a456-426614174001",
      other,
    );
    pending[1].destroy();
    // The remaining incomplete bodies hit the production two-second deadline
    await Promise.all(outcomes);
    const third = await vaultTarget("third", "third.json");
    await registerRoute(
      port,
      clientToken,
      "lease",
      "123e4567-e89b-42d3-a456-426614174002",
      third,
    );
    expect(
      (
        await request(port, {
          path: `/v1/${routeId}/mcp`,
          token: clientToken,
          body: "{}",
        })
      ).body,
    ).toBe("original");
  } finally {
    server.off("request", observe);
    for (const req of pending) req.destroy();
  }
});

test("removing the broker's executable directory cannot remove live registrations", async () => {
  const file = await vaultTarget("original", "data.json");
  const port = await frontPort();
  await registerRoute(port, clientToken, "lease", routeId, file);
  const root = path.join(tempDir, "broker");
  await fsp.mkdir(root);
  await fsp.rmdir(root);
  expect(
    (
      await request(port, {
        path: `/v1/${routeId}/mcp`,
        token: clientToken,
        body: "{}",
      })
    ).body,
  ).toBe("original");
  expect(await fsp.stat(root).catch(() => null)).toBeNull();
});

test("a copied route cannot overwrite or unregister the existing owner", async () => {
  const first = await vaultTarget("original", "original.json");
  const copy = await vaultTarget("copy", "copy.json");
  const port = await frontPort();
  await registerRoute(port, clientToken, "lease", routeId, first);
  await expect(
    registerRoute(port, clientToken, "lease", routeId, copy),
  ).rejects.toThrow("HTTP 409");
  expect(
    (
      await request(port, {
        path: `/v1/${routeId}/mcp`,
        token: clientToken,
        body: "{}",
      })
    ).body,
  ).toBe("original");
});

test("a same-vault reconnect evicts its own stale control instead of a 409", async () => {
  const file = await vaultTarget("second-connection", "data.json");
  const port = await frontPort();
  const first = await registerRoute(port, clientToken, "lease", routeId, file);
  // First is still open here. A same-dataPath registration must evict it
  // instead of rejecting with 409, unlike a copied vault's different dataPath.
  const second = await registerRoute(port, clientToken, "lease", routeId, file);
  expect(
    (
      await request(port, {
        path: `/v1/${routeId}/mcp`,
        token: clientToken,
        body: "{}",
      })
    ).body,
  ).toBe("second-connection");
  // The evicted first control is already closed broker-side; close() must be safe to call anyway.
  await first.close();
  await second.close();
});

describe("ownsRegistration rejection branches", () => {
  async function rawRegister(
    port: number,
    dataPath: string,
    overrides: Partial<{ routeId: string }> = {},
  ) {
    const id = overrides.routeId ?? routeId;
    const body = JSON.stringify({
      version: broker.BROKER_VERSION,
      routeId: id,
      dataPath,
      tokenId: "selected",
      accessTokenHash: broker.sha256(clientToken),
      leaseId: "lease",
    });
    return request(port, {
      path: `/_obsidian_mcp_broker/register/${id}`,
      token: clientToken,
      body,
      headers: { "x-obsidian-mcp-lease-id": "lease" },
    });
  }

  test("rejects a registration whose on-disk settings name a different routeId", async () => {
    const dataPath = path.join(tempDir, "data.json");
    await fsp.writeFile(
      dataPath,
      JSON.stringify({
        mcpClientConfig: {
          codexDiscovery: {
            enabled: true,
            routeId: "123e4567-e89b-42d3-a456-426614174099",
            tokenId: "selected",
            accessToken: clientToken,
          },
        },
      }),
    );
    const port = await frontPort();
    expect((await rawRegister(port, dataPath)).status).toBe(401);
  });

  test("rejects a registration for a disabled discovery entry", async () => {
    const dataPath = path.join(tempDir, "data.json");
    await fsp.writeFile(
      dataPath,
      JSON.stringify({
        mcpClientConfig: {
          codexDiscovery: {
            enabled: false,
            routeId,
            tokenId: "selected",
            accessToken: clientToken,
          },
        },
      }),
    );
    const port = await frontPort();
    expect((await rawRegister(port, dataPath)).status).toBe(401);
  });

  test("rejects a registration whose access token has since rotated", async () => {
    const dataPath = path.join(tempDir, "data.json");
    await fsp.writeFile(
      dataPath,
      JSON.stringify({
        mcpClientConfig: {
          codexDiscovery: {
            enabled: true,
            routeId,
            tokenId: "selected",
            accessToken: "a-newer-rotated-token",
          },
        },
      }),
    );
    const port = await frontPort();
    expect((await rawRegister(port, dataPath)).status).toBe(401);
  });

  test("rejects a registration whose dataPath file is missing or corrupt", async () => {
    const port = await frontPort();
    expect(
      (await rawRegister(port, path.join(tempDir, "missing.json"))).status,
    ).toBe(401);

    const corrupt = path.join(tempDir, "corrupt.json");
    await fsp.writeFile(corrupt, "not json");
    expect((await rawRegister(port, corrupt)).status).toBe(401);
  });
});

test("concurrent clients share one broker and closing another vault preserves its sibling", async () => {
  const first = await vaultTarget("first", "first.json");
  const second = await vaultTarget("second", "second.json");
  const id = "123e4567-e89b-42d3-a456-426614174001";
  const port = await frontPort();
  const a = await registerRoute(port, clientToken, "lease", routeId, first);
  await registerRoute(port, clientToken, "lease", id, second);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      request(port, {
        path: `/v1/${i % 2 ? id : routeId}/mcp`,
        token: clientToken,
        body: "{}",
      }),
    ),
  );
  expect(results.map((result) => result.body)).toEqual(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? "second" : "first")),
  );
  await a.close();
  await waitForStatus(port, `/v1/${routeId}/mcp`, clientToken, 404);
  expect(
    (
      await request(port, {
        path: `/v1/${id}/mcp`,
        token: clientToken,
        body: "{}",
      })
    ).body,
  ).toBe("second");
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
  const targetPort = await listen(target);
  await fsp.writeFile(
    path.join(tempDir, "data.json"),
    JSON.stringify({
      mcpTransport: {
        livePort: targetPort,
        tokens: [{ id: "selected", token: "test-token" }],
      },
    }),
  );
  const port = await frontPort();
  await registerRoute(port, clientToken, "lease");
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/v1/${routeId}/mcp`,
        method: "POST",
        headers: {
          authorization: `Bearer ${clientToken}`,
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
  await Promise.race([
    closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("upstream remained open")), 1000),
    ),
  ]);
  expect(
    (await request(port, { path: "/_obsidian_mcp_broker/health" })).status,
  ).toBe(200);
});
