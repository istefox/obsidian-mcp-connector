import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "module";
import fsp from "fs/promises";
import http from "http";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const broker = require("./discoveryBroker.js") as {
  BROKER_NAME: string;
  BROKER_VERSION: number;
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
  options: { path: string; token?: string; body?: string },
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
): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/_obsidian_mcp_broker/register/${routeId}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": "0",
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
    req.end();
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
        mcpTransport: {
          livePort: port,
          tokens: [{ id: "selected", token }],
        },
      }),
      "utf8",
    );
  await writeVaultData(firstPort, "first-vault-token");
  await fsp.writeFile(
    path.join(tempDir, "routes", `${routeId}.json`),
    JSON.stringify({
      version: broker.BROKER_VERSION,
      routeId,
      dataPath,
      tokenId: "selected",
      accessTokenHash: broker.sha256(clientToken),
      leaseId: "lease",
    }),
    "utf8",
  );

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
  await fsp.writeFile(
    path.join(tempDir, "routes", `${routeId}.json`),
    JSON.stringify({
      version: broker.BROKER_VERSION,
      routeId,
      dataPath: path.join(tempDir, "data.json"),
      tokenId: "selected",
      accessTokenHash: broker.sha256(clientToken),
      leaseId: "lease",
    }),
    "utf8",
  );
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
