import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fsp from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import {
  startHttpServer,
  stopHttpServer,
  type RunningServer,
} from "$/features/mcp-transport/services/httpServer";
import {
  readTokens,
  revokeToken,
} from "$/features/mcp-transport/services/tokenStore";
import type { McpTransportState } from "$/features/mcp-transport/services/setup";
import { SettingsStore } from "$/shared/settingsStore";
import { BROKER_NAME } from "./brokerServer";
import {
  codexConfigSnippet,
  installCodexConfig,
  inspectCodexInstall,
} from "./codexConfig";
import {
  acceptDiscoveryMove,
  createBrokerHost,
  disableCodexDiscovery,
  enableCodexDiscovery,
  getCodexConnection,
  releaseCodexDiscoveryOwner,
  resetCodexCredential,
  resetDiscoveryIdentity,
  resolveCodexDiscoveryOwner,
  startDiscovery,
  type BrokerHost,
  type DiscoveryRuntime,
  type DiscoveryStatus,
} from "./discoveryBroker";
import {
  createRouteQueue,
  replaceRoute,
  restartTransport,
  RouteQueueClosed,
} from "./routeLifecycle";

type StoredData = Record<string, unknown> | null;

function secretFor(id: string): string {
  return `${id}-secret-`.padEnd(40, "x");
}

/** In-memory plugin data, mirrored to `file` when given so a broker can read it. */
function fakePlugin(initial: StoredData, file?: string) {
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
      // Owner-only, as the broker requires on POSIX whatever the umask is
      if (file)
        await fsp.writeFile(file, JSON.stringify(next), { mode: 0o600 });
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

function storedSettings(plugin: ReturnType<typeof fakePlugin>) {
  return (plugin._data?.mcpClientConfig as Record<string, unknown>)
    .codexDiscovery as Record<string, unknown>;
}

let tempDir = "";
let dataPath = "";
type TestControl = {
  close(): void;
  closed: Promise<void>;
  disconnect(): void;
};
let controls: TestControl[] = [];
let registrations: Array<{ registration: unknown; credential: string }> = [];
let notices: string[] = [];
const runtimes: DiscoveryRuntime[] = [];
const hosts: BrokerHost[] = [];
const vaultServers: RunningServer[] = [];
const servers: http.Server[] = [];

async function connectRegistration(
  _port: number,
  _routeId: string,
  credential: string,
  _lease: string,
  registration: unknown,
): Promise<TestControl> {
  registrations.push({ registration, credential });
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

/** A broker host seam that counts elections and can be made to fail. */
function fakeHost(ensure: () => Promise<void> = async () => {}) {
  const host = {
    port: 0,
    hosting: false,
    elections: 0,
    ensure: () => {
      host.elections += 1;
      return ensure();
    },
    close: async () => {},
  };
  return host;
}

function fakeOpts(host: BrokerHost = fakeHost(), file = dataPath) {
  return {
    host,
    transportPort: 27201,
    dataPath: file,
    connectRegistration,
    reconnectMs: 1,
    failoverDelayMs: () => 1,
    notify: (message: string) => notices.push(message),
  };
}

/**
 * What This vault was moved and Make this copy independent run: stop the
 * route, change its saved identity, then start it again.
 */
async function replaceWith(
  plugin: ReturnType<typeof fakePlugin>,
  runtime: DiscoveryRuntime,
  update: () => Promise<void>,
  opts: Parameters<typeof startDiscovery>[1],
): Promise<DiscoveryRuntime> {
  const holder = {
    routeQueue: createRouteQueue(),
    // Only the port is read, to allow and register a route
    mcpTransportState: {
      server: { port: opts.transportPort },
    } as McpTransportState,
    discoveryState: runtime as DiscoveryRuntime | undefined,
  };
  await replaceRoute(holder, {
    update,
    startRoute: (port) =>
      startDiscovery(plugin, { ...opts, transportPort: port }),
  });
  return holder.discoveryState!;
}

/** Resolves on the first status, current or later, that matches. */
function untilStatus(
  runtime: DiscoveryRuntime,
  matches: (status: DiscoveryStatus) => boolean,
): Promise<DiscoveryStatus> {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | undefined;
    unsubscribe = runtime.subscribe((status) => {
      if (done || !matches(status)) return;
      done = true;
      resolve(status);
      unsubscribe?.();
    });
    if (done) unsubscribe();
  });
}

/** Resolves once `count` elections have started on a fake host. */
function untilElections(
  host: ReturnType<typeof fakeHost>,
  count: number,
): Promise<void> {
  return new Promise((resolve) => {
    const ensure = host.ensure;
    host.ensure = () => {
      const result = ensure();
      if (host.elections >= count) resolve();
      return result;
    };
    if (host.elections >= count) resolve();
  });
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-discovery-service-"));
  dataPath = path.join(tempDir, "data.json");
  controls = [];
  registrations = [];
  notices = [];
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  controls.forEach((control) => control.close());
  await Promise.all(vaultServers.splice(0).map(stopHttpServer));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe("routes for every vault", () => {
  test("a vault without Codex gets a route and registers it", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const runtime = await startDiscovery(plugin, fakeOpts());
    runtimes.push(runtime);

    expect(runtime.status.state).toBe("connected");
    expect(await resolveCodexDiscoveryOwner(plugin)).toBeNull();
    const settings = storedSettings(plugin);
    expect(settings.enabled).toBe(false);
    expect(settings.tokenId).toBeNull();
    expect(settings.routeId).toBe(runtime.routeId);
    expect(settings.serverId).toBe(
      `obsidian_neonhades2_${runtime.routeId.replace(/-/g, "")}`,
    );
    const [{ registration, credential }] = registrations;
    expect(credential).toBe(settings.accessToken as string);
    const body = JSON.stringify(registration);
    expect(body).toContain(runtime.routeId);
    expect(registration).toMatchObject({ port: 27201 });
    expect(body).not.toContain(secretFor("a"));
    expect(body).not.toContain(credential);
    expect(body).not.toContain("tokenId");
    expect(await fsp.readdir(tempDir)).toEqual([]);
  });

  test("a restart reuses the minted route", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const first = await startDiscovery(plugin, fakeOpts());
    await first.stop();
    const second = await startDiscovery(plugin, fakeOpts());
    runtimes.push(second);
    expect(second.routeId).toBe(first.routeId);
  });
});

describe("Codex ownership", () => {
  test("enabling Codex only changes settings and keeps the registered route", async () => {
    const plugin = fakePlugin(withTokens("a", "b"));
    const runtime = await startDiscovery(plugin, fakeOpts());
    runtimes.push(runtime);

    await enableCodexDiscovery(plugin, "b");
    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("b");
    const connection = await getCodexConnection(plugin);
    expect(connection?.routeId).toBe(runtime.routeId);
    expect(connection?.brokerPort).toBe(27200);
    expect(codexConfigSnippet(connection!).split("\n")[0]).toBe(
      `[mcp_servers.obsidian_neonhades2_${runtime.routeId.replace(/-/g, "")}]`,
    );

    await enableCodexDiscovery(plugin, "a");
    expect(await getCodexConnection(plugin)).toEqual(connection);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("a");
    expect(registrations).toHaveLength(1);
    expect(runtime.status.state).toBe("connected");
  });

  test("disabling Codex keeps the route and the saved client entry", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const runtime = await startDiscovery(plugin, fakeOpts());
    runtimes.push(runtime);
    await enableCodexDiscovery(plugin, "a");
    const connection = await getCodexConnection(plugin);

    await disableCodexDiscovery(plugin);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBeNull();
    expect(await getCodexConnection(plugin)).toEqual(connection);
    expect(runtime.status.state).toBe("connected");
    expect(registrations).toHaveLength(1);
  });

  test("revoking the owner fails closed without assigning another token", async () => {
    const plugin = fakePlugin(withTokens("a", "b"));
    await enableCodexDiscovery(plugin, "a");

    expect(await releaseCodexDiscoveryOwner(plugin, "b")).toBe(false);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("a");
    expect(await releaseCodexDiscoveryOwner(plugin, "a")).toBe(true);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBeNull();
  });

  test("resetting the Codex credential keeps the route and re-registers with the new credential", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const runtime = await startDiscovery(plugin, fakeOpts());
    runtimes.push(runtime);
    await enableCodexDiscovery(plugin, "a");
    const before = await getCodexConnection(plugin);

    await resetCodexCredential(plugin);
    const after = await getCodexConnection(plugin);
    expect(after?.routeId).toBe(before?.routeId);
    expect(after?.serverId).toBe(before?.serverId);
    expect(after?.accessToken).not.toBe(before?.accessToken);

    controls[0].disconnect();
    await untilStatus(runtime, () => registrations.length === 2);
    expect(registrations[1].credential).toBe(after!.accessToken);
  });
});

describe("recovery", () => {
  test("a dropped control connection re-elects after the failover delay", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const host = fakeHost();
    const delays: number[] = [];
    const runtime = await startDiscovery(plugin, {
      ...fakeOpts(host),
      failoverDelayMs: () => {
        delays.push(1);
        return 1;
      },
    });
    expect(host.elections).toBe(1);
    expect(delays).toEqual([]);

    const reelected = untilElections(host, 2);
    controls[0].disconnect();
    await reelected;
    await untilStatus(runtime, (status) => status.state === "connected");
    expect(delays).toEqual([1]);
    expect(controls).toHaveLength(2);
    // The transport did not restart, so the reconnect sends the same port
    expect(registrations.map(({ registration }) => registration)).toMatchObject(
      [{ port: 27201 }, { port: 27201 }],
    );

    await runtime.stop();
    expect(host.elections).toBe(2);
  });

  test("the default failover delay is jittered between 50 and 250 ms", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const scheduled: number[] = [];
    const realSetTimeout = window.setTimeout;
    // Record the delay the runtime asks for without waiting for it
    window.setTimeout = ((handler: () => void, delay?: number) => {
      scheduled.push(delay ?? 0);
      return realSetTimeout(handler, 0);
    }) as typeof window.setTimeout;
    try {
      const { failoverDelayMs: _unused, ...opts } = fakeOpts();
      const runtime = await startDiscovery(plugin, opts);
      runtimes.push(runtime);
      for (let drop = 0; drop < 20; drop += 1) {
        const reconnected = untilStatus(
          runtime,
          () => controls.length === drop + 2,
        );
        controls[drop].disconnect();
        await reconnected;
      }
    } finally {
      window.setTimeout = realSetTimeout;
    }
    expect(scheduled).toHaveLength(20);
    for (const delay of scheduled) {
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(250);
    }
  });

  test("stop cancels a delayed recovery attempt", async () => {
    const plugin = fakePlugin(withTokens("a"));
    let fail = false;
    const host = fakeHost(async () => {
      if (fail) throw new Error("broker unavailable");
    });
    const runtime = await startDiscovery(plugin, {
      ...fakeOpts(host),
      reconnectMs: 60_000,
    });

    fail = true;
    const reelected = untilElections(host, 2);
    controls[0].disconnect();
    await reelected;
    await untilStatus(runtime, (status) => status.message !== undefined);
    await runtime.stop();

    expect(host.elections).toBe(2);
    expect(runtime.status.state).toBe("stopped");
  });

  test("stop() racing a pending reconnection closes the connection once it resolves", async () => {
    const plugin = fakePlugin(withTokens("a"));
    let callCount = 0;
    let resolveSecond!: (control: TestControl) => void;
    const secondControlPending = new Promise<TestControl>((resolve) => {
      resolveSecond = resolve;
    });
    let secondRequested!: () => void;
    const secondCalled = new Promise<void>((resolve) => {
      secondRequested = resolve;
    });
    const gatedConnect: typeof connectRegistration = async (
      port,
      routeIdArg,
      token,
      lease,
      registration,
    ) => {
      callCount += 1;
      if (callCount === 1) {
        return connectRegistration(
          port,
          routeIdArg,
          token,
          lease,
          registration,
        );
      }
      // The recovery attempt stays pending until the test resolves it, so
      // establishControl's own stopped-check (after openRegistration
      // resolves) is what tears this connection down, not stop() itself.
      secondRequested();
      return secondControlPending;
    };

    const runtime = await startDiscovery(plugin, {
      ...fakeOpts(),
      connectRegistration: gatedConnect,
    });
    expect(controls).toHaveLength(1);

    controls[0].disconnect();
    await secondCalled;

    const stopPromise = runtime.stop();
    let secondClosed = false;
    let resolveSecondClosed!: () => void;
    const secondClosedPromise = new Promise<void>((resolve) => {
      resolveSecondClosed = resolve;
    });
    resolveSecond({
      close: () => {
        secondClosed = true;
        resolveSecondClosed();
      },
      closed: secondClosedPromise,
      disconnect: () => {},
    });

    await stopPromise;
    expect(secondClosed).toBe(true);
  });

  test("initial connection failure retries and publishes connected then stopped status", async () => {
    const plugin = fakePlugin(withTokens("a"));
    let attempts = 0;
    const host = fakeHost(async () => {
      if (++attempts < 3) throw new Error("not ready");
    });
    const runtime = await startDiscovery(plugin, fakeOpts(host));
    const statuses: string[] = [];
    const unsubscribe = runtime.subscribe((status) =>
      statuses.push(status.state),
    );
    await untilStatus(runtime, (status) => status.state === "connected");
    await runtime.stop();
    expect(statuses).toContain("retrying");
    expect(statuses).toContain("connected");
    expect(statuses.at(-1)).toBe("stopped");
    unsubscribe();
  });
});

test("a copied settings identity is blocked until an explicit move or reset", async () => {
  const plugin = fakePlugin(withTokens("a"));
  const opts = fakeOpts();
  const first = await startDiscovery(plugin, opts);
  await enableCodexDiscovery(plugin, "a");
  const original = await getCodexConnection(plugin);
  await first.stop();
  const movedDir = path.join(tempDir, "copy");
  await fsp.mkdir(movedDir);
  const movedOpts = { ...opts, dataPath: path.join(movedDir, "data.json") };
  const blocked = await startDiscovery(plugin, movedOpts);
  expect(blocked.status.locationChanged).toBe(true);
  expect(controls).toHaveLength(1);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("Vault location changed");
  const moved = await replaceWith(
    plugin,
    blocked,
    () => acceptDiscoveryMove(plugin, movedOpts),
    movedOpts,
  );
  expect(blocked.status.state).toBe("stopped");
  expect(moved.status.state).toBe("connected");
  expect(await getCodexConnection(plugin)).toEqual(original);
  const reset = await replaceWith(
    plugin,
    moved,
    () => resetDiscoveryIdentity(plugin, movedOpts),
    movedOpts,
  );
  runtimes.push(reset);
  const next = await getCodexConnection(plugin);
  expect(reset.routeId).toBe(next!.routeId);
  expect(next?.routeId).not.toBe(original?.routeId);
  expect(next?.accessToken).not.toBe(original?.accessToken);
  expect(next?.serverId).not.toBe(original?.serverId);
  expect(codexConfigSnippet(next!).split("\n")[0]).toBe(
    `[mcp_servers.obsidian_neonhades2_${next!.routeId.replace(/-/g, "")}]`,
  );
  expect(await resolveCodexDiscoveryOwner(plugin)).toBe("a");
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
  expect(await getCodexConnection(plugin)).toBeNull();
  const runtime = await startDiscovery(plugin, fakeOpts());
  runtimes.push(runtime);
  const after = await getCodexConnection(plugin);
  expect(after?.routeId).toBe("123e4567-e89b-42d3-a456-426614174000");
  expect(after?.accessToken).toBe(secretFor("broker"));
  expect(after?.serverId).toBe("obsidian_neonhades2");
});

test.each(["enable", "start"])(
  "%s upgrades a UUID-only entry through an aliased path and keeps its name after a rename",
  async (action) => {
    const routeId = "123e4567-e89b-42d3-a456-426614174000";
    const opaqueId = "obsidian_123e4567e89b42d3a456426614174000";
    const namedId = "obsidian_neonhades2_123e4567e89b42d3a456426614174000";
    const vaultDir = path.join(tempDir, "vault");
    const aliasDir = path.join(tempDir, "vault-alias");
    await fsp.mkdir(vaultDir);
    await fsp.symlink(
      vaultDir,
      aliasDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const resolvedPath = path.join(await fsp.realpath(vaultDir), "data.json");
    const plugin = fakePlugin({
      ...withTokens("a"),
      mcpClientConfig: {
        codexDiscovery: {
          enabled: action === "start",
          routeId,
          accessToken: secretFor("broker"),
          tokenId: action === "start" ? "a" : null,
          dataPath:
            process.platform === "win32"
              ? resolvedPath.toLowerCase()
              : resolvedPath,
          serverId: opaqueId,
        },
      },
    });
    const before = await getCodexConnection(plugin);
    expect(codexConfigSnippet(before!).split("\n")[0]).toBe(
      `[mcp_servers.${opaqueId}]`,
    );
    const opts = fakeOpts(fakeHost(), path.join(aliasDir, "data.json"));
    if (action === "enable") await enableCodexDiscovery(plugin, "a");
    const runtime = await startDiscovery(plugin, opts);
    expect(runtime.status.locationChanged).not.toBe(true);
    expect(storedSettings(plugin).serverId).toBe(namedId);
    const after = await getCodexConnection(plugin);
    expect(after?.routeId).toBe(routeId);
    expect(after?.accessToken).toBe(before?.accessToken);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("a");
    await runtime.stop();

    plugin.app.vault.getName = () => "Renamed";
    const restarted = await startDiscovery(plugin, opts);
    runtimes.push(restarted);
    const renamed = await getCodexConnection(plugin);
    expect(renamed?.serverId).toBe(namedId);
    expect(codexConfigSnippet(renamed!).split("\n")[0]).toBe(
      `[mcp_servers.${namedId}]`,
    );
  },
);

test.each(["start/move", "start/reset", "enable/move", "enable/reset"])(
  "%s preserves a copied vault's saved name until its location is resolved",
  async (scenario) => {
    const routeId = "123e4567-e89b-42d3-a456-426614174000";
    const opaqueId = "obsidian_123e4567e89b42d3a456426614174000";
    const plugin = fakePlugin({
      ...withTokens("a"),
      mcpClientConfig: {
        codexDiscovery: {
          enabled: true,
          routeId,
          accessToken: secretFor("broker"),
          tokenId: "a",
          serverId: opaqueId,
          dataPath: "synthetic-original-location/data.json",
        },
      },
    });
    plugin.app.vault.getName = () => "Copy of Notes";
    const opts = fakeOpts();
    const configPath = path.join(tempDir, "synthetic-config.toml");
    const original = await getCodexConnection(plugin);
    await installCodexConfig(original!, { configPath });
    const previous = await fsp.readFile(configPath, "utf8");
    if (scenario.startsWith("enable")) await enableCodexDiscovery(plugin, "a");
    const blocked = await startDiscovery(plugin, opts);
    expect(blocked.status.locationChanged).toBe(true);
    expect(registrations).toHaveLength(0);
    const unresolved = await getCodexConnection(plugin);
    expect(unresolved?.serverId).toBe(opaqueId);
    expect(unresolved?.routeId).toBe(routeId);
    expect(
      (await inspectCodexInstall(unresolved!, { configPath })).action,
    ).toBe("unchanged");
    expect((await installCodexConfig(unresolved!, { configPath })).action).toBe(
      "unchanged",
    );
    expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
    plugin.app.vault.getName = () => "Renamed Copy";
    expect((await getCodexConnection(plugin))?.serverId).toBe(opaqueId);
    const resolved = await replaceWith(
      plugin,
      blocked,
      scenario.endsWith("move")
        ? () => acceptDiscoveryMove(plugin, opts)
        : () => resetDiscoveryIdentity(plugin, opts),
      opts,
    );
    runtimes.push(resolved);
    const ready = await getCodexConnection(plugin);
    expect(ready?.serverId).toBe(
      `obsidian_renamed_copy_${ready!.routeId.replace(/-/g, "")}`,
    );
    if (scenario.endsWith("move")) {
      expect(ready?.routeId).toBe(routeId);
      expect((await installCodexConfig(ready!, { configPath })).action).toBe(
        "migrate",
      );
    } else {
      expect(ready?.routeId).not.toBe(routeId);
      expect((await installCodexConfig(ready!, { configPath })).action).toBe(
        "add",
      );
      expect(
        (await fsp.readFile(configPath, "utf8")).startsWith(previous),
      ).toBe(true);
    }
  },
);

test("a new fallback entry keeps its saved name after an ASCII vault rename", async () => {
  const plugin = fakePlugin(withTokens("a"));
  plugin.app.vault.getName = () => "日記";
  const first = await startDiscovery(plugin, fakeOpts());
  const before = await getCodexConnection(plugin);
  const expectedId = `obsidian_vault_${before!.routeId.replace(/-/g, "")}`;
  expect(before?.serverId).toBe(expectedId);
  await first.stop();
  plugin.app.vault.getName = () => "Journal";
  const second = await startDiscovery(plugin, fakeOpts());
  runtimes.push(second);
  const after = await getCodexConnection(plugin);
  expect(after?.serverId).toBe(expectedId);
  expect(after?.routeId).toBe(before?.routeId);
  expect(after?.accessToken).toBe(before?.accessToken);
  expect(codexConfigSnippet(after!).split("\n")[0]).toBe(
    `[mcp_servers.${expectedId}]`,
  );
});

// ---------------------------------------------------------------------------
// Real broker, real vault transports
// ---------------------------------------------------------------------------

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    );
  });
}

/**
 * A port nothing listens on right now. Small TOCTOU window, the same
 * trade-off httpServer.test.ts and port.test.ts accept.
 */
async function freePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type Vault = {
  name: string;
  plugin: ReturnType<typeof fakePlugin>;
  file: string;
  /** The vault's running transport port. */
  port: number;
};

const PLUGIN_ID = "mcp-tools-istefox";

/** The only data file path a broker admits, with its directories created. */
async function pluginDataFile(vault: string): Promise<string> {
  const dir = path.join(tempDir, vault, ".obsidian", "plugins", PLUGIN_ID);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "data.json");
}

/**
 * A vault with a real MCP transport whose handler reports which vault and
 * which token served the request, the identity a tool profile hangs off.
 */
async function openVault(name: string, ...tokenIds: string[]): Promise<Vault> {
  const file = await pluginDataFile(name);
  const plugin = fakePlugin(withTokens(...tokenIds), file);
  const server = await startHttpServer({
    resolveTokens: () => readTokens(plugin),
    requestHandler: async (req, res, tokenId) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ vault: name, tokenId }));
    },
    ports: [await freePort()],
  });
  vaultServers.push(server);
  return { name, plugin, file, port: server.port };
}

function hostOn(port: number): BrokerHost {
  const host = createBrokerHost({ port, pluginId: PLUGIN_ID });
  hosts.push(host);
  return host;
}

async function start(vault: Vault, host: BrokerHost, port = vault.port) {
  const runtime = await startDiscovery(vault.plugin, {
    host,
    transportPort: port,
    dataPath: vault.file,
    reconnectMs: 5,
    failoverDelayMs: () => 1,
    notify: (message: string) => notices.push(message),
  });
  runtimes.push(runtime);
  return runtime;
}

function call(
  port: number,
  route: string,
  token?: string,
  method = "POST",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = method === "POST" ? "{}" : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          connection: "close",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const routeOf = (runtime: DiscoveryRuntime) => `/v1/${runtime.routeId}/mcp`;

describe("broker hosting", () => {
  test("two vaults racing for the port elect one host and both register with it", async () => {
    const port = await freePort();
    const hostA = hostOn(port);
    const hostB = hostOn(port);
    const a = await openVault("a", "a1");
    const b = await openVault("b", "b1");

    const [ra, rb] = await Promise.all([start(a, hostA), start(b, hostB)]);

    expect([hostA.hosting, hostB.hosting].filter(Boolean)).toHaveLength(1);
    expect(ra.status.state).toBe("connected");
    expect(rb.status.state).toBe("connected");
    expect(
      JSON.parse((await call(port, routeOf(ra), secretFor("a1"))).body),
    ).toEqual({
      vault: "a",
      tokenId: "a1",
    });
    expect(
      JSON.parse((await call(port, routeOf(rb), secretFor("b1"))).body),
    ).toEqual({
      vault: "b",
      tokenId: "b1",
    });
    expect(notices).toEqual([]);
  });

  test("when the hosting vault unloads, another vault takes over and requests succeed again", async () => {
    const port = await freePort();
    const hostA = hostOn(port);
    const hostB = hostOn(port);
    const a = await openVault("a", "a1");
    const b = await openVault("b", "b1");
    const ra = await start(a, hostA);
    const rb = await start(b, hostB);
    expect(hostA.hosting).toBe(true);
    expect(hostB.hosting).toBe(false);
    expect((await call(port, routeOf(rb), secretFor("b1"))).status).toBe(200);

    const dropped = untilStatus(rb, (status) => status.state === "retrying");
    // What onunload does: both start closing before anything is awaited
    const stopped = ra.stop();
    const closed = hostA.close();
    await Promise.all([stopped, closed]);
    await dropped;
    await untilStatus(rb, (status) => status.state === "connected");

    expect(hostB.hosting).toBe(true);
    expect(
      JSON.parse((await call(port, routeOf(rb), secretFor("b1"))).body),
    ).toEqual({
      vault: "b",
      tokenId: "b1",
    });
    // The unloaded vault's route went with it
    expect((await call(port, routeOf(ra), secretFor("a1"))).status).toBe(404);
  });

  test("unloading the host leaves no listener, control connection or forwarded stream behind", async () => {
    let upstreamClosed!: () => void;
    const upstreamGone = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: open\n\n");
      res.once("close", upstreamClosed);
    });
    servers.push(upstream);
    const file = await pluginDataFile("vault");
    const plugin = fakePlugin(withTokens("a"), file);
    const upstreamPort = await listen(upstream);
    const port = await freePort();
    const host = createBrokerHost({ port, pluginId: PLUGIN_ID });
    const runtime = await startDiscovery(plugin, {
      host,
      transportPort: upstreamPort,
      dataPath: file,
      notify: (message: string) => notices.push(message),
    });
    expect(host.hosting).toBe(true);

    // Wrapped: resolving with the bare promise would wait for the close
    const downstream = await new Promise<{ closed: Promise<void> }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: routeOf(runtime),
            method: "POST",
            headers: { connection: "close", "content-length": "2" },
          },
          (res) => {
            const closed = new Promise<void>((done) => res.once("close", done));
            res.once("data", () => resolve({ closed }));
          },
        );
        req.on("error", reject);
        req.end("{}");
      },
    );

    const stopped = runtime.stop();
    const closed = host.close();
    expect(host.hosting).toBe(false);
    await Promise.all([stopped, closed]);
    await upstreamGone;
    await downstream.closed;
    expect(runtime.status.state).toBe("stopped");
    // The listener is gone: the same port binds again
    const rebound = http.createServer();
    await listen(rebound, port);
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
  });

  test("closing the host during an election cancels it without starting a listener", async () => {
    const port = await freePort();
    const host = createBrokerHost({ port, pluginId: PLUGIN_ID });
    const election = host.ensure();
    await host.close();
    await expect(election).rejects.toThrow("closed");
    expect(host.hosting).toBe(false);
    const rebound = http.createServer();
    await listen(rebound, port);
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
  });

  test.each([
    [
      "a foreign process",
      (_req: http.IncomingMessage, res: http.ServerResponse) => {
        res.writeHead(404);
        res.end();
      },
      "older MCP Connector version",
    ],
    [
      "a broker of another plugin version",
      (_req: http.IncomingMessage, res: http.ServerResponse) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: BROKER_NAME, version: 2 }));
      },
      "different MCP Connector version",
    ],
  ])(
    "a port held by %s leaves direct ports working and notifies once",
    async (_label, handler, expected) => {
      const squatter = http.createServer(handler);
      servers.push(squatter);
      const port = await listen(squatter);
      const vault = await openVault("a", "a1");
      const runtime = await start(vault, hostOn(port));
      // Two failed elections, each publishing its reason
      let failures = 0;
      await untilStatus(
        runtime,
        (status) => status.message !== undefined && ++failures === 2,
      );
      expect(runtime.status.state).toBe("retrying");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(expected);
      expect(notices[0]).toContain("Direct vault ports keep working");
    },
  );
});

describe("requests through the broker", () => {
  async function connected() {
    const port = await freePort();
    const vault = await openVault("a", "t1", "t2");
    const runtime = await start(vault, hostOn(port));
    return { port, vault, runtime };
  }

  test("a client token reaches the vault as itself, so its tool profile applies", async () => {
    const { port, vault, runtime } = await connected();
    await enableCodexDiscovery(vault.plugin, "t1");
    expect(
      JSON.parse((await call(port, routeOf(runtime), secretFor("t2"))).body),
    ).toEqual({
      vault: "a",
      tokenId: "t2",
    });
  });

  test("a revoked token gets the vault's own 401", async () => {
    const { port, vault, runtime } = await connected();
    await revokeToken(vault.plugin, "t2");
    const result = await call(port, routeOf(runtime), secretFor("t2"));
    expect(result.status).toBe(401);
    // The vault answers with no body; a broker refusal would carry JSON
    expect(result.body).toBe("");
  });

  test("GET without auth answers 405 on the route and on bare /mcp", async () => {
    const { port, runtime } = await connected();
    expect((await call(port, routeOf(runtime), undefined, "GET")).status).toBe(
      405,
    );
    expect((await call(port, "/mcp", undefined, "GET")).status).toBe(405);
  });

  test("the Codex credential is swapped for the selected token, and disabling Codex keeps the route", async () => {
    const { port, vault, runtime } = await connected();
    await enableCodexDiscovery(vault.plugin, "t1");
    const codex = (await getCodexConnection(vault.plugin))!;
    expect(
      JSON.parse((await call(port, routeOf(runtime), codex.accessToken)).body),
    ).toEqual({
      vault: "a",
      tokenId: "t1",
    });

    await disableCodexDiscovery(vault.plugin);
    expect((await call(port, routeOf(runtime), codex.accessToken)).status).toBe(
      401,
    );
    expect(runtime.status.state).toBe("connected");
    expect(
      JSON.parse((await call(port, routeOf(runtime), secretFor("t2"))).body),
    ).toEqual({
      vault: "a",
      tokenId: "t2",
    });
  });

  test("bare /mcp routes by token: one match, no match and a copied vault", async () => {
    const port = await freePort();
    const host = hostOn(port);
    const a = await openVault("a", "a1");
    const b = await openVault("b", "b1");
    await start(a, host);
    await start(b, hostOn(port));

    expect(
      JSON.parse((await call(port, "/mcp", secretFor("b1"))).body),
    ).toEqual({
      vault: "b",
      tokenId: "b1",
    });
    expect((await call(port, "/mcp", "unknown-token")).status).toBe(401);

    // A copy that carries vault a's token secrets but its own route
    const copy = await openVault("copy", "a1");
    await start(copy, hostOn(port));
    const duplicate = await call(port, "/mcp", secretFor("a1"));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toContain("Make this copy independent");
  });
});

test("a copied vault that claims the original's route is refused until it is made independent", async () => {
  const port = await freePort();
  const original = await openVault("original", "a1");
  const host = hostOn(port);
  const ownRuntime = await start(original, host);

  const copyFile = await pluginDataFile("copy");
  const copy = fakePlugin(
    JSON.parse(JSON.stringify(original.plugin._data)) as StoredData,
    copyFile,
  );
  await copy.saveData(copy._data);
  const copyOpts = {
    host: hostOn(port),
    transportPort: original.port,
    dataPath: copyFile,
    reconnectMs: 5,
    failoverDelayMs: () => 1,
    notify: (message: string) => notices.push(message),
  };
  const blocked = await startDiscovery(copy, copyOpts);
  runtimes.push(blocked);
  expect(blocked.status.locationChanged).toBe(true);
  const conflict = await replaceWith(
    copy,
    blocked,
    () => acceptDiscoveryMove(copy, copyOpts),
    copyOpts,
  );
  runtimes.push(conflict);
  expect(conflict.status.state).toBe("conflict");
  expect(conflict.status.message).toContain("Make this copy independent");
  expect((await call(port, routeOf(ownRuntime), secretFor("a1"))).status).toBe(
    200,
  );

  const separate = await replaceWith(
    copy,
    conflict,
    () => resetDiscoveryIdentity(copy, copyOpts),
    copyOpts,
  );
  runtimes.push(separate);
  expect(separate.status.state).toBe("connected");
  expect(separate.routeId).not.toBe(ownRuntime.routeId);
  await separate.stop();
  expect(
    JSON.parse((await call(port, routeOf(ownRuntime), secretFor("a1"))).body),
  ).toEqual({
    vault: "original",
    tokenId: "a1",
  });
});

describe("route lifecycle", () => {
  /** What onload starts: no transport or route yet. */
  function loading() {
    return {
      routeQueue: createRouteQueue(),
      mcpTransportState: undefined as McpTransportState | undefined,
      discoveryState: undefined as DiscoveryRuntime | undefined,
    };
  }

  const started = async () => ({
    success: true as const,
    // Only the port is read, to allow a route
    state: { server: { port: 27201 } } as McpTransportState,
  });

  test("a start nobody interrupts installs its route", async () => {
    const plugin = loading();
    const result = await restartTransport(plugin, {
      setup: started,
      teardown: async () => {},
      startRoute: () => startDiscovery(fakePlugin(withTokens("a")), fakeOpts()),
    });
    runtimes.push(plugin.discoveryState!);
    expect(result.success).toBe(true);
    expect(plugin.discoveryState?.status.state).toBe("connected");
  });

  test.each([
    ["the broker host closes", false],
    ["the election succeeds", true],
  ])(
    "a route still starting at unload stops once %s",
    async (_label, elected) => {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const host = fakeHost(async () => {
        await barrier;
        if (!elected) throw new Error("The broker host was closed");
      });
      const electing = untilElections(host, 1);
      const plugin = loading();
      let runtime: DiscoveryRuntime | undefined;
      const start = restartTransport(plugin, {
        setup: started,
        teardown: async () => {},
        startRoute: async () => {
          runtime = await startDiscovery(
            fakePlugin(withTokens("a")),
            fakeOpts(host),
          );
          return runtime;
        },
      });
      await electing;
      // What onunload does while the first election is still pending
      plugin.routeQueue.close();
      release();

      await expect(start).rejects.toBeInstanceOf(RouteQueueClosed);
      expect(plugin.discoveryState).toBeUndefined();
      expect(runtime?.status.state).toBe("stopped");
      // No retry ran after the stop
      expect(host.elections).toBe(1);
      expect(registrations).toHaveLength(elected ? 1 : 0);
      await Promise.all(controls.map((control) => control.closed));
    },
  );

  /** The broker drops a route one event after its control closes. */
  async function untilRouteGone(port: number, route: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      // No credential, so nothing secret reaches whatever answers
      if ((await call(port, route)).status === 404) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("route was not dropped");
  }

  async function routedVault() {
    const port = await freePort();
    const host = hostOn(port);
    const vault = await openVault("a", "a1");
    const runtime = await start(vault, host);
    const holder: {
      routeQueue: ReturnType<typeof createRouteQueue>;
      mcpTransportState?: McpTransportState;
      discoveryState?: DiscoveryRuntime;
    } = {
      routeQueue: createRouteQueue(),
      // Only the server is read, by the teardown below
      mcpTransportState: {
        server: vaultServers[vaultServers.length - 1],
      } as McpTransportState,
      discoveryState: runtime,
    };
    expect((await call(port, routeOf(runtime), secretFor("a1"))).status).toBe(
      200,
    );
    return { port, host, vault, runtime, holder };
  }

  test("a failed transport restart leaves the route down and sends the old port nothing", async () => {
    const { port, host, vault, runtime, holder } = await routedVault();
    const oldPort = holder.mcpTransportState!.server.port;
    let routeStarts = 0;

    const result = await restartTransport(holder, {
      setup: async () => ({
        success: false,
        error: `Port ${oldPort + 1} is in use — the MCP server did not start.`,
      }),
      teardown: (state) => {
        // Deregistered before the old port is released
        expect(runtime.status.state).toBe("stopped");
        return stopHttpServer(state.server);
      },
      startRoute: (transportPort) => {
        routeStarts += 1;
        return start(vault, host, transportPort);
      },
    });

    expect(result.success).toBe(false);
    expect(routeStarts).toBe(0);
    expect(holder.discoveryState).toBeUndefined();
    expect(holder.mcpTransportState).toBeUndefined();
    expect(runtime.status.state).toBe("stopped");
    // The broker stays up for the other vaults
    expect(host.hosting).toBe(true);
    await untilRouteGone(port, routeOf(runtime));

    // Another process takes the released port
    const seen: Array<string | undefined> = [];
    const squatter = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      res.end();
    });
    servers.push(squatter);
    await listen(squatter, oldPort);
    expect((await call(port, routeOf(runtime), secretFor("a1"))).status).toBe(
      404,
    );
    expect((await call(port, "/mcp", secretFor("a1"))).status).toBe(401);
    expect(seen).toEqual([]);
  });

  test("a transport restart registers the route again with the new transport's port", async () => {
    const { port, host, vault, runtime, holder } = await routedVault();
    let registeredPort: number | undefined;
    const result = await restartTransport(holder, {
      setup: async () => {
        // The route is already down while the new transport starts
        expect(holder.discoveryState).toBeUndefined();
        expect(runtime.status.state).toBe("stopped");
        const server = await startHttpServer({
          resolveTokens: () => readTokens(vault.plugin),
          requestHandler: async (req, res, tokenId) => {
            req.resume();
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ vault: "restarted", tokenId }));
          },
          ports: [await freePort()],
        });
        vaultServers.push(server);
        // A stale save names the old port, which only the .mcpb shim reads
        await new SettingsStore(vault.plugin).updateSlice(
          "mcpTransport",
          (current) => ({
            ...(current as Record<string, unknown>),
            livePort: vault.port,
          }),
        );
        return {
          success: true,
          state: { server } as McpTransportState,
        };
      },
      teardown: (state) => stopHttpServer(state.server),
      startRoute: (transportPort) => {
        registeredPort = transportPort;
        return start(vault, host, transportPort);
      },
    });

    expect(result.success).toBe(true);
    expect(registeredPort).toBe(holder.mcpTransportState!.server.port);
    expect(registeredPort).not.toBe(vault.port);
    const restarted = holder.discoveryState!;
    expect(restarted).not.toBe(runtime);
    expect(restarted.routeId).toBe(runtime.routeId);
    expect(restarted.status.state).toBe("connected");
    expect(
      JSON.parse((await call(port, routeOf(restarted), secretFor("a1"))).body),
    ).toEqual({ vault: "restarted", tokenId: "a1" });
  });
});
