import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import http from "http";
import { createRequire } from "module";
import type { Socket } from "net";
import type { DiscoveryRuntime } from "./discoveryBroker";
import {
  disableCodexDiscovery,
  enableCodexDiscovery,
  getCodexConnection,
  releaseCodexDiscoveryOwner,
  resolveCodexDiscoveryOwner,
  startCodexDiscovery,
  resetDiscoveryIdentity,
  acceptDiscoveryMove,
} from "./discoveryBroker";

type StoredData = Record<string, unknown> | null;

function secretFor(id: string): string {
  return `${id}-secret-`.padEnd(40, "x");
}

function fakePlugin(initial: StoredData) {
  let data = initial;
  return {
    app: {
      vault: {
        adapter: {},
        configDir: ".obsidian",
        getName: () => "NeonHades2",
      },
    },
    manifest: { id: "mcp-tools-istefox" },
    async loadData() {
      return data;
    },
    async saveData(next: unknown) {
      data = next as StoredData;
    },
    get _data() {
      return data;
    },
  };
}

function withTokens(...ids: string[]): StoredData {
  return {
    mcpTransport: {
      tokens: ids.map((id, createdAt) => ({
        id,
        label: id,
        token: secretFor(id),
        createdAt,
      })),
    },
  };
}

let tempDir = "";
let dataPath = "";
type TestControl = {
  close(): void;
  closed: Promise<void>;
  disconnect(): void;
};
let controls: TestControl[] = [];
let registrations: unknown[] = [];

async function connectRegistration(
  _port: number,
  _routeId: string,
  _token: string,
  _lease: string,
  registration: unknown,
): Promise<TestControl> {
  registrations.push(registration);
  let resolveClosed!: () => void;
  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const disconnect = () => {
    if (closed) return;
    closed = true;
    resolveClosed();
  };
  const control = {
    close: disconnect,
    closed: closedPromise,
    disconnect,
  };
  controls.push(control);
  return control;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-discovery-service-"));
  dataPath = path.join(tempDir, "data.json");
  controls = [];
  registrations = [];
});

afterEach(async () => {
  controls.forEach((control) => control.close());
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe("Codex discovery ownership", () => {
  test("is opt-in and registers in memory without writing broker state files", async () => {
    const plugin = fakePlugin(withTokens("a", "b"));
    const runtime = await enableCodexDiscovery(plugin, "b", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });

    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("b");
    const connection = await getCodexConnection(plugin);
    expect(connection?.routeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(connection?.accessToken.length).toBeGreaterThanOrEqual(32);
    const registration = JSON.stringify(registrations[0]);
    expect(registration).not.toContain(secretFor("b"));
    expect(registration).not.toContain(connection!.accessToken);
    expect(registration).toContain('"tokenId":"b"');
    expect(registration).not.toContain("heartbeatAt");
    expect(await fsp.readdir(tempDir)).toEqual([]);

    await runtime.stop();
  });

  test("keeps the route and broker credential stable when the selected token changes", async () => {
    const plugin = fakePlugin(withTokens("a", "b"));
    const first = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });
    const before = await getCodexConnection(plugin);
    await first.stop();

    const second = await enableCodexDiscovery(plugin, "b", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });
    expect(await getCodexConnection(plugin)).toEqual(before);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("b");
    await second.stop();
  });

  test("disable removes only the live registration and permits the same config to be reused", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const runtime = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });
    const connection = await getCodexConnection(plugin);
    await disableCodexDiscovery(plugin, runtime);

    expect(await resolveCodexDiscoveryOwner(plugin)).toBeNull();
    expect(await getCodexConnection(plugin)).toEqual(connection);
    expect(
      await fsp
        .stat(path.join(tempDir, "routes", `${connection!.routeId}.json`))
        .catch(() => null),
    ).toBeNull();
    expect(
      await startCodexDiscovery(plugin, {
        rootDir: tempDir,
        dataPath,
        ensureBroker: async () => {},
        connectRegistration,
      }),
    ).toBeNull();
  });

  test("revoking the owner fails closed without assigning another token", async () => {
    const plugin = fakePlugin(withTokens("a", "b"));
    const runtime = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });

    expect(await releaseCodexDiscoveryOwner(plugin, "b", runtime)).toBe(false);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("a");
    expect(await releaseCodexDiscoveryOwner(plugin, "a", runtime)).toBe(true);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBeNull();
  });

  test("a closed control connection restores a broker and its route", async () => {
    const plugin = fakePlugin(withTokens("a"));
    let probes = 0;
    const runtime = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {
        probes += 1;
      },
      connectRegistration,
      reconnectMs: 1,
    });
    expect(probes).toBe(1);
    expect(controls).toHaveLength(1);

    controls[0].disconnect();
    await waitFor(() => probes === 2 && controls.length === 2);

    await runtime.stop();
    const stoppedAt = probes;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(probes).toBe(stoppedAt);
  });

  test("stop cancels a delayed recovery attempt", async () => {
    const plugin = fakePlugin(withTokens("a"));
    let probes = 0;
    const runtime = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {
        probes += 1;
        if (probes > 1) throw new Error("broker unavailable");
      },
      connectRegistration,
      reconnectMs: 60_000,
    });

    controls[0].disconnect();
    await waitFor(() => probes === 2);
    await runtime.stop();

    expect(probes).toBe(2);
  });
});

test("a copied settings identity is blocked until an explicit move or reset", async () => {
  const plugin = fakePlugin(withTokens("a"));
  const opts = {
    rootDir: tempDir,
    dataPath,
    ensureBroker: async () => {},
    connectRegistration,
  };
  const first = await enableCodexDiscovery(plugin, "a", opts);
  const original = await getCodexConnection(plugin);
  await first.stop();
  const movedDir = path.join(tempDir, "copy");
  await fsp.mkdir(movedDir);
  const movedOpts = { ...opts, dataPath: path.join(movedDir, "data.json") };
  const blocked = await startCodexDiscovery(plugin, movedOpts);
  expect(blocked?.status.locationChanged).toBe(true);
  expect(controls).toHaveLength(1);
  const moved = await acceptDiscoveryMove(plugin, blocked!, movedOpts);
  expect(moved?.status.state).toBe("connected");
  expect(await getCodexConnection(plugin)).toEqual(original);
  const reset = await resetDiscoveryIdentity(plugin, moved!, movedOpts);
  const next = await getCodexConnection(plugin);
  expect(next?.routeId).not.toBe(original?.routeId);
  expect(next?.accessToken).not.toBe(original?.accessToken);
  expect(next?.serverId).not.toBe(original?.serverId);
  await reset?.stop();
});

test("initial connection failure retries and publishes connected then stopped status", async () => {
  const plugin = fakePlugin(withTokens("a"));
  let attempts = 0;
  const runtime = await enableCodexDiscovery(plugin, "a", {
    rootDir: tempDir,
    dataPath,
    reconnectMs: 1,
    connectRegistration,
    ensureBroker: async () => {
      if (++attempts < 3) throw new Error("not ready");
    },
  });
  const statuses: string[] = [];
  const unsubscribe = runtime.subscribe((status) =>
    statuses.push(status.state),
  );
  await waitFor(() => runtime.status.state === "connected");
  await runtime.stop();
  expect(statuses).toContain("retrying");
  expect(statuses).toContain("connected");
  expect(statuses.at(-1)).toBe("stopped");
  unsubscribe();
});

test("legacy settings retain route, credential and client entry when first bound to a location", async () => {
  const plugin = fakePlugin({
    ...withTokens("a"),
    mcpClientConfig: {
      codexDiscovery: {
        enabled: true,
        routeId: "123e4567-e89b-42d3-a456-426614174000",
        accessToken: secretFor("broker"),
        tokenId: "a",
      },
    },
  });
  const before = await getCodexConnection(plugin);
  const runtime = await startCodexDiscovery(plugin, {
    rootDir: tempDir,
    dataPath,
    ensureBroker: async () => {},
    connectRegistration,
  });
  expect(await getCodexConnection(plugin)).toEqual(before);
  expect(before?.serverId).toBe("obsidian_neonhades2");
  await runtime?.stop();
});

test("real registration transport recovers after broker loss and isolates a copied vault", async () => {
  const require = createRequire(import.meta.url);
  const broker = require("../../../../scripts/discoveryBroker.js") as {
    startBroker(options: { rootDir: string; port: number }): http.Server;
  };
  const sockets = new Set<Socket>();
  const runtimes: DiscoveryRuntime[] = [];
  const listen = (server: http.Server) =>
    new Promise<number>((resolve) =>
      server.once("listening", () =>
        resolve((server.address() as { port: number }).port),
      ),
    );
  let front = broker.startBroker({
    rootDir: path.join(tempDir, "broker"),
    port: 0,
  });
  front.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(front);
  const upstream = http.createServer((_req, res) => res.end("owned-vault"));
  upstream.listen(0, "127.0.0.1");
  const upstreamPort = await listen(upstream);
  const plugin = fakePlugin({
    ...withTokens("a"),
    mcpTransport: {
      tokens: [{ id: "a", token: secretFor("a") }],
      livePort: upstreamPort,
    },
  });
  const save = plugin.saveData;
  plugin.saveData = async (next) => {
    await save(next);
    await fsp.writeFile(dataPath, JSON.stringify(next));
  };
  await plugin.saveData(plugin._data);
  const opts = {
    rootDir: tempDir,
    dataPath,
    brokerPort: port,
    reconnectMs: 5,
    ensureBroker: async () => {},
  };
  const response = async (
    connection: NonNullable<Awaited<ReturnType<typeof getCodexConnection>>>,
  ) => {
    const result = await fetch(
      `http://127.0.0.1:${port}/v1/${connection.routeId}/mcp`,
      {
        method: "POST",
        body: "{}",
        headers: { Authorization: `Bearer ${connection.accessToken}` },
      },
    );
    await result.text();
    return result.status;
  };
  try {
    const runtime = await enableCodexDiscovery(plugin, "a", opts);
    runtimes.push(runtime);
    const identity = (await getCodexConnection(plugin))!;
    expect(runtime.status.state).toBe("connected");
    expect(await response(identity)).toBe(200);
    let sawRetry = false;
    const unsubscribe = runtime.subscribe((status) => {
      if (status.state === "retrying") sawRetry = true;
    });
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => front.close(() => resolve()));
    await waitFor(() => sawRetry);
    front = broker.startBroker({
      rootDir: path.join(tempDir, "new-broker"),
      port,
    });
    front.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await listen(front);
    await waitFor(() => runtime.status.state === "connected");
    expect(await response(identity)).toBe(200);
    unsubscribe();

    const copyPath = path.join(tempDir, "copy.json");
    const copy = fakePlugin(JSON.parse(JSON.stringify(plugin._data)));
    const copySave = copy.saveData;
    copy.saveData = async (next) => {
      await copySave(next);
      await fsp.writeFile(copyPath, JSON.stringify(next));
    };
    await copy.saveData(copy._data);
    const copyOpts = { ...opts, dataPath: copyPath };
    const blocked = (await startCodexDiscovery(copy, copyOpts))!;
    runtimes.push(blocked);
    expect(blocked.status.locationChanged).toBe(true);
    const conflict = (await acceptDiscoveryMove(copy, blocked, copyOpts))!;
    runtimes.push(conflict);
    expect(conflict.status.state).toBe("conflict");
    expect(await response(identity)).toBe(200);
    const separate = (await resetDiscoveryIdentity(copy, conflict, copyOpts))!;
    runtimes.push(separate);
    expect(separate.status.state).toBe("connected");
    const copiedIdentity = (await getCodexConnection(copy))!;
    expect(copiedIdentity.routeId).not.toBe(identity.routeId);
    expect(await response(copiedIdentity)).toBe(200);
    await separate.stop();
    expect(await response(identity)).toBe(200);
  } finally {
    for (const runtime of runtimes) await runtime.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => front.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("generated broker asset matches its source", async () => {
  const { DISCOVERY_BROKER_SOURCE } =
    await import("../assets/discoveryBrokerSource");
  const source = await fsp.readFile(
    path.join(import.meta.dir, "../../../../scripts/discoveryBroker.js"),
    "utf8",
  );
  expect(DISCOVERY_BROKER_SOURCE).toBe(source);
});
