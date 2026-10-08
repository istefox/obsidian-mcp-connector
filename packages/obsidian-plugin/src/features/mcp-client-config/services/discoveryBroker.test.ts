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
  codexEntryFor,
  inspectCodexInstall,
  installCodexConfig,
  type CodexInstallInput,
  type CodexInstallPreview,
  type CodexTokenForm,
} from "./codexConfig";
import { brokerRouteUrl } from "./endpoint";
import { vaultServerId } from "./generators";
import {
  acceptDiscoveryMove,
  createBrokerHost,
  getCodexConnection,
  isLocationUnresolved,
  resetDiscoveryIdentity,
  savedRouteId,
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

const ROW_URL = "http://127.0.0.1:27200/v1/synthetic-route/mcp";

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
  test("every vault gets a route and registers it", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const runtime = await startDiscovery(plugin, fakeOpts());
    runtimes.push(runtime);

    expect(runtime.status.state).toBe("connected");
    const settings = storedSettings(plugin);
    expect(settings).not.toHaveProperty("enabled");
    expect(settings).not.toHaveProperty("tokenId");
    expect(settings.routeId).toBe(runtime.routeId);
    expect(settings).not.toHaveProperty("serverId");
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

describe("Codex entries", () => {
  test("a row's entry carries that row's token and URL, not the route credential", async () => {
    const plugin = fakePlugin(withTokens("a", "b"));
    const runtime = await startDiscovery(plugin, fakeOpts());
    runtimes.push(runtime);

    const connection = getCodexConnection(plugin, secretFor("b"), ROW_URL);
    expect(connection.accessToken).toBe(secretFor("b"));
    expect(connection.accessToken).not.toBe(storedSettings(plugin).accessToken);
    const snippet = codexConfigSnippet(connection);
    // The same key as every other client config, with no route ID in it
    expect(snippet.split("\n")[0]).toBe(
      `[mcp_servers.${vaultServerId(plugin.app.vault.getName())}]`,
    );
    expect(snippet.split("\n")[0]).not.toContain(
      runtime.routeId.replace(/-/g, ""),
    );
    expect(snippet).toContain(`url = "${ROW_URL}"`);
    expect(snippet).toContain(`Bearer ${secretFor("b")}`);
    expect(registrations).toHaveLength(1);
  });

  test("a vault without route settings, such as a legacy fixed 27200, gets a direct entry", () => {
    // A fixed BROKER_PORT never starts discovery, so no route settings exist
    const plugin = fakePlugin(withTokens("a"));
    const direct = "http://127.0.0.1:27200/mcp";

    const snippet = codexConfigSnippet(
      getCodexConnection(plugin, secretFor("a"), direct),
    );
    expect(snippet.split("\n")[0]).toBe(
      `[mcp_servers.${vaultServerId(plugin.app.vault.getName())}]`,
    );
    expect(snippet).toContain(`url = "${direct}"`);
    expect(registrations).toHaveLength(0);
  });
});

describe("savedRouteId", () => {
  test("returns the stored route ID, never the credential (ADR-0028 D2)", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const runtime = await startDiscovery(plugin, fakeOpts());
    runtimes.push(runtime);

    const routeId = await savedRouteId(plugin);
    expect(routeId).toBe(runtime.routeId);
    expect(routeId).not.toBe(storedSettings(plugin).accessToken);
  });

  test("returns a route ID that was seeded in the stored settings", async () => {
    const plugin = fakePlugin({
      ...withTokens("a"),
      mcpClientConfig: {
        codexDiscovery: {
          routeId: "123e4567-e89b-42d3-a456-426614174000",
          accessToken: secretFor("broker"),
        },
      },
    });
    expect(await savedRouteId(plugin)).toBe(
      "123e4567-e89b-42d3-a456-426614174000",
    );
  });

  test("returns null when no route was minted", async () => {
    expect(await savedRouteId(fakePlugin(withTokens("a")))).toBeNull();
    expect(await savedRouteId(fakePlugin(null))).toBeNull();
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
  const originalRoute = first.routeId;
  const originalCredential = storedSettings(plugin).accessToken;
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
  expect(moved.routeId).toBe(originalRoute);
  expect(storedSettings(plugin).accessToken).toBe(originalCredential);
  const reset = await replaceWith(
    plugin,
    moved,
    () => resetDiscoveryIdentity(plugin, movedOpts),
    movedOpts,
  );
  runtimes.push(reset);
  expect(storedSettings(plugin).routeId).toBe(reset.routeId);
  expect(reset.routeId).not.toBe(originalRoute);
  expect(storedSettings(plugin).accessToken).not.toBe(originalCredential);
});

test("legacy settings retain route and credential when first bound to a location", async () => {
  const plugin = fakePlugin({
    ...withTokens("a"),
    mcpClientConfig: {
      codexDiscovery: {
        enabled: true,
        routeId: "123e4567-e89b-42d3-a456-426614174000",
        accessToken: secretFor("broker"),
        tokenId: "a",
        serverId: "obsidian_123e4567e89b42d3a456426614174000",
      },
    },
  });
  const runtime = await startDiscovery(plugin, fakeOpts());
  runtimes.push(runtime);
  expect(runtime.routeId).toBe("123e4567-e89b-42d3-a456-426614174000");
  // The route credential stays, and the old Codex keys are kept but ignored
  expect(storedSettings(plugin)).toMatchObject({
    accessToken: secretFor("broker"),
    enabled: true,
    tokenId: "a",
    serverId: "obsidian_123e4567e89b42d3a456426614174000",
  });
  expect(storedSettings(plugin).dataPath).toBeString();
  expect(
    codexConfigSnippet(
      getCodexConnection(plugin, secretFor("a"), ROW_URL),
    ).split("\n")[0],
  ).toBe(`[mcp_servers.${vaultServerId(plugin.app.vault.getName())}]`);
});

test("start through an aliased path keeps the saved location, route and credential", async () => {
  const routeId = "123e4567-e89b-42d3-a456-426614174000";
  const vaultDir = path.join(tempDir, "vault");
  const aliasDir = path.join(tempDir, "vault-alias");
  const pluginDir = path.join(".obsidian", "plugins", PLUGIN_ID);
  await fsp.mkdir(path.join(vaultDir, pluginDir), { recursive: true });
  await fsp.symlink(
    vaultDir,
    aliasDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  const resolvedPath = path.join(
    await fsp.realpath(path.join(vaultDir, pluginDir)),
    "data.json",
  );
  const plugin = fakePlugin({
    ...withTokens("a"),
    mcpClientConfig: {
      codexDiscovery: {
        routeId,
        accessToken: secretFor("broker"),
        dataPath:
          process.platform === "win32"
            ? resolvedPath.toLowerCase()
            : resolvedPath,
      },
    },
  });
  const opts = fakeOpts(
    fakeHost(),
    path.join(aliasDir, pluginDir, "data.json"),
  );
  const runtime = await startDiscovery(plugin, opts);
  runtimes.push(runtime);
  expect(runtime.status.locationChanged).not.toBe(true);
  expect(runtime.routeId).toBe(routeId);
  expect(storedSettings(plugin).accessToken).toBe(secretFor("broker"));
});

/** A vault whose plugin folder links to a checkout, as bun run link leaves it. */
async function linkedPluginFolder(name: string) {
  const checkout = path.join(tempDir, `${name}-checkout`);
  const vaultPlugins = path.join(tempDir, name, ".obsidian", "plugins");
  await fsp.mkdir(checkout, { recursive: true });
  await fsp.mkdir(vaultPlugins, { recursive: true });
  await fsp.symlink(
    checkout,
    path.join(vaultPlugins, PLUGIN_ID),
    process.platform === "win32" ? "junction" : "dir",
  );
  const lower = (file: string) =>
    process.platform === "win32" ? file.toLowerCase() : file;
  return {
    file: path.join(vaultPlugins, PLUGIN_ID, "data.json"),
    // What 2.11 and 2.12 saved: the whole plugin folder resolved to its target
    legacyPath: lower(path.join(await fsp.realpath(checkout), "data.json")),
    // What this version saves: the plugin folder keeps its own name
    currentPath: lower(
      path.join(await fsp.realpath(vaultPlugins), PLUGIN_ID, "data.json"),
    ),
  };
}

function savedRoute(dataPath: string) {
  return fakePlugin({
    ...withTokens("a"),
    mcpClientConfig: {
      codexDiscovery: {
        routeId: "123e4567-e89b-42d3-a456-426614174000",
        accessToken: secretFor("broker"),
        dataPath,
      },
    },
  });
}

test("a location saved by 2.12 for a linked plugin folder is kept and moved to the current form", async () => {
  const linked = await linkedPluginFolder("vault");
  expect(linked.legacyPath).not.toBe(linked.currentPath);
  const plugin = savedRoute(linked.legacyPath);
  const opts = fakeOpts(fakeHost(), linked.file);

  expect(await isLocationUnresolved(plugin, opts)).toBe(false);
  const runtime = await startDiscovery(plugin, opts);
  runtimes.push(runtime);

  expect(runtime.status.locationChanged).not.toBe(true);
  expect(runtime.status.state).toBe("connected");
  expect(runtime.routeId).toBe("123e4567-e89b-42d3-a456-426614174000");
  expect(storedSettings(plugin).accessToken).toBe(secretFor("broker"));
  expect(storedSettings(plugin).dataPath).toBe(linked.currentPath);
  expect(registrations).toHaveLength(1);
  expect(registrations[0]?.registration).toMatchObject({
    dataPath: linked.currentPath,
  });
});

test("a vault whose plugin folder links elsewhere than the saved location is still a copy", async () => {
  const original = await linkedPluginFolder("original");
  const copy = await linkedPluginFolder("copy");
  const plugin = savedRoute(original.legacyPath);
  const opts = fakeOpts(fakeHost(), copy.file);

  expect(await isLocationUnresolved(plugin, opts)).toBe(true);
  const blocked = await startDiscovery(plugin, opts);
  runtimes.push(blocked);

  expect(blocked.status.locationChanged).toBe(true);
  expect(registrations).toHaveLength(0);
  expect(storedSettings(plugin).dataPath).toBe(original.legacyPath);
});

test.each(["move", "reset"])(
  "%s resolves a copied vault that registers nothing until then",
  async (scenario) => {
    const routeId = "123e4567-e89b-42d3-a456-426614174000";
    const plugin = fakePlugin({
      ...withTokens("a"),
      mcpClientConfig: {
        codexDiscovery: {
          routeId,
          accessToken: secretFor("broker"),
          dataPath: "synthetic-original-location/data.json",
        },
      },
    });
    const opts = fakeOpts();
    const blocked = await startDiscovery(plugin, opts);
    expect(blocked.status.locationChanged).toBe(true);
    expect(registrations).toHaveLength(0);
    const resolved = await replaceWith(
      plugin,
      blocked,
      scenario === "move"
        ? () => acceptDiscoveryMove(plugin, opts)
        : () => resetDiscoveryIdentity(plugin, opts),
      opts,
    );
    runtimes.push(resolved);
    expect(resolved.status.state).toBe("connected");
    if (scenario === "move") expect(resolved.routeId).toBe(routeId);
    else expect(resolved.routeId).not.toBe(routeId);
  },
);

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
      expect(runtime.status.state).toBe("unavailable");
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
    const { port, runtime } = await connected();
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

  test("a route forwards client bearers unchanged, even with stored Codex keys", async () => {
    const { port, vault, runtime } = await connected();
    await new SettingsStore(vault.plugin).updateSlice(
      "mcpClientConfig",
      (current) => {
        const slice = current as Record<string, Record<string, unknown>>;
        return {
          ...slice,
          codexDiscovery: {
            ...slice.codexDiscovery,
            enabled: true,
            tokenId: "t1",
          },
        };
      },
    );
    // The route credential is a registration secret, never a client's
    const credential = storedSettings(vault.plugin).accessToken as string;
    expect((await call(port, routeOf(runtime), credential)).status).toBe(401);
    expect(
      JSON.parse((await call(port, routeOf(runtime), secretFor("t2"))).body),
    ).toEqual({
      vault: "a",
      tokenId: "t2",
    });
    expect(runtime.status.state).toBe("connected");
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

describe("Codex entries installed by the plugin", () => {
  type Parsed = { mcp_servers: Record<string, Record<string, unknown>> };

  async function connected() {
    const port = await freePort();
    const vault = await openVault("a", "t1", "t2");
    const runtime = await start(vault, hostOn(port));
    const configPath = path.join(tempDir, "codex-home", "config.toml");
    return { port, vault, runtime, configPath };
  }

  function inputFor(
    vault: Vault,
    runtime: DiscoveryRuntime,
    port: number,
    tokenForm: CodexTokenForm = "literal",
  ): CodexInstallInput {
    return {
      ...codexEntryFor({
        serverId: vaultServerId(vault.plugin.app.vault.getName()),
        url: brokerRouteUrl(runtime.routeId, port),
        token: secretFor("t2"),
        tokenForm,
      }),
      routeId: runtime.routeId,
    };
  }

  async function installInto(
    input: CodexInstallInput,
    configPath: string,
  ): Promise<CodexInstallPreview> {
    const target = { scope: "user" as const, configPath };
    const planned = await inspectCodexInstall(input, target);
    await installCodexConfig(input, target, {
      expectedRevision: planned.revision,
    });
    return planned;
  }

  /** The request a Codex client makes from one parsed entry. */
  function requestFrom(
    entry: Record<string, unknown>,
    env: Record<string, string> = {},
  ) {
    const url = new URL(entry.url as string);
    const headers = entry.http_headers as
      | { Authorization?: string }
      | undefined;
    const envName = entry.bearer_token_env_var as string | undefined;
    const bearer = headers?.Authorization
      ? headers.Authorization.replace(/^Bearer /, "")
      : envName
        ? env[envName]
        : undefined;
    return call(Number(url.port), url.pathname, bearer);
  }

  test("an installed entry reaches the vault as its own token, and gets the vault's 401 once revoked", async () => {
    const { port, vault, runtime, configPath } = await connected();
    await installInto(inputFor(vault, runtime, port), configPath);

    const text = await fsp.readFile(configPath, "utf8");
    const key = vaultServerId(vault.plugin.app.vault.getName());
    const entry = (Bun.TOML.parse(text) as Parsed).mcp_servers[key];
    expect(entry.url).toBe(brokerRouteUrl(runtime.routeId, port));
    expect(text).not.toContain(
      storedSettings(vault.plugin).accessToken as string,
    );

    const served = await requestFrom(entry);
    expect(JSON.parse(served.body)).toEqual({ vault: "a", tokenId: "t2" });

    await revokeToken(vault.plugin, "t2");
    const revoked = await requestFrom(entry);
    expect(revoked.status).toBe(401);
    // The vault answers with no body; a broker refusal would carry JSON
    expect(revoked.body).toBe("");
  });

  test("the environment variable form reaches the vault as its own token and holds no secret", async () => {
    const { port, vault, runtime, configPath } = await connected();
    await installInto(inputFor(vault, runtime, port, "env"), configPath);

    const text = await fsp.readFile(configPath, "utf8");
    const key = vaultServerId(vault.plugin.app.vault.getName());
    const entry = (Bun.TOML.parse(text) as Parsed).mcp_servers[key];
    expect(entry.bearer_token_env_var).toBe("OBSIDIAN_MCP_TOKEN");
    expect(entry).not.toHaveProperty("http_headers");
    expect(text).not.toContain(secretFor("t2"));
    expect(text).not.toContain(
      storedSettings(vault.plugin).accessToken as string,
    );

    const env = { OBSIDIAN_MCP_TOKEN: secretFor("t2") };
    expect(JSON.parse((await requestFrom(entry, env)).body)).toEqual({
      vault: "a",
      tokenId: "t2",
    });
    await revokeToken(vault.plugin, "t2");
    expect((await requestFrom(entry, env)).status).toBe(401);
  });

  test.each([
    ["a UUID-only key", (hex: string) => `obsidian_${hex}`],
    [
      "a name plus the route hex",
      (hex: string) => `obsidian_neon_hades_2_${hex}`,
    ],
  ])(
    "an entry from an earlier version (%s) is migrated and no longer carries the route credential",
    async (_label, legacyKey) => {
      const { port, vault, runtime, configPath } = await connected();
      const credential = storedSettings(vault.plugin).accessToken as string;
      const hex = runtime.routeId.replace(/-/g, "");
      const old = legacyKey(hex);
      const legacyUrl = `http://127.0.0.1:27206/v1/${runtime.routeId}/mcp`;
      await fsp.mkdir(path.dirname(configPath), { recursive: true });
      await fsp.writeFile(
        configPath,
        [
          `[mcp_servers.${old}]`,
          `url = "${legacyUrl}"`,
          `http_headers = { Authorization = "Bearer ${credential}" }`,
          "enabled = true",
          'default_tools_approval_mode = "approve"',
          "",
        ].join("\n"),
        "utf8",
      );

      // The route credential in the legacy entry is no client bearer: the
      // route answers it with the vault's 401
      expect(
        (await call(port, `/v1/${runtime.routeId}/mcp`, credential)).status,
      ).toBe(401);

      const planned = await installInto(
        inputFor(vault, runtime, port),
        configPath,
      );
      expect(planned.action).toBe("migrate");
      expect(planned.previousServerId).toBe(old);

      const text = await fsp.readFile(configPath, "utf8");
      expect(text).not.toContain(credential);
      const servers = (Bun.TOML.parse(text) as Parsed).mcp_servers;
      const key = vaultServerId(vault.plugin.app.vault.getName());
      expect(Object.keys(servers)).toEqual([key]);
      expect(servers[key].default_tools_approval_mode).toBe("approve");
      expect(JSON.parse((await requestFrom(servers[key])).body)).toEqual({
        vault: "a",
        tokenId: "t2",
      });
    },
  );

  test("legacy Codex keys stay in the stored settings, the install uses the plain key and the route stays connected", async () => {
    const { port, vault, runtime, configPath } = await connected();
    await new SettingsStore(vault.plugin).updateSlice(
      "mcpClientConfig",
      (current) => {
        const slice = current as Record<string, Record<string, unknown>>;
        return {
          ...slice,
          codexDiscovery: {
            ...slice.codexDiscovery,
            enabled: true,
            tokenId: "t1",
            serverId: "obsidian_saved_legacy_name",
          },
        };
      },
    );
    const before = structuredClone(storedSettings(vault.plugin));

    await installInto(inputFor(vault, runtime, port), configPath);

    expect(storedSettings(vault.plugin)).toEqual(before);
    expect(before).toMatchObject({
      enabled: true,
      tokenId: "t1",
      serverId: "obsidian_saved_legacy_name",
    });
    const servers = (
      Bun.TOML.parse(await fsp.readFile(configPath, "utf8")) as Parsed
    ).mcp_servers;
    expect(Object.keys(servers)).toEqual([
      vaultServerId(vault.plugin.app.vault.getName()),
    ]);
    expect(runtime.status.state).toBe("connected");
    // The route still serves the row token it was installed with
    const entry = Object.values(servers)[0];
    expect(JSON.parse((await requestFrom(entry)).body)).toEqual({
      vault: "a",
      tokenId: "t2",
    });
  });
});

describe("registration with a real broker", () => {
  /**
   * A real broker host whose retries each wait for one `allowRetry()`, so
   * a test changes the vault's data file between attempts without racing
   * the backoff. The first election runs at once, and `open()` lets every
   * later one through. `failNextRetry()` makes the next allowed retry
   * fail like a dropped connection, and `retryWaits()` resolves once a
   * later retry waits at the gate, so the failure before it was recorded.
   */
  function gatedHost(port: number) {
    const inner = hostOn(port);
    let elections = 0;
    let allowed = 0;
    let failNext = false;
    let wake: (() => void) | undefined;
    let waiting: (() => void) | undefined;
    const host: BrokerHost = {
      get port() {
        return inner.port;
      },
      get hosting() {
        return inner.hosting;
      },
      async ensure() {
        if (elections++ > 0) {
          while (allowed === 0)
            await new Promise<void>((resolve) => {
              wake = resolve;
              waiting?.();
              waiting = undefined;
            });
          allowed -= 1;
          if (failNext) {
            failNext = false;
            throw new Error("socket hang up");
          }
        }
        return inner.ensure();
      },
      close: () => inner.close(),
    };
    const allow = (count: number) => {
      allowed += count;
      wake?.();
    };
    return {
      host,
      allowRetry: () => allow(1),
      open: () => allow(Number.POSITIVE_INFINITY),
      failNextRetry: () => {
        failNext = true;
      },
      retryWaits: () => new Promise<void>((resolve) => (waiting = resolve)),
    };
  }

  /** Resolves on the first status published after this call. */
  function nextStatus(runtime: DiscoveryRuntime): Promise<DiscoveryStatus> {
    let published = false;
    const next = untilStatus(runtime, () => published);
    published = true;
    return next;
  }

  /** The data file path the vault registered, saved with its route. */
  const registeredPath = (vault: Vault) =>
    storedSettings(vault.plugin).dataPath as string;

  test("a linked plugin folder registers under its own name, not its target's", async () => {
    const port = await freePort();
    const vault = await openVault("a", "a1");
    // What bun run link leaves: The plugin folder links to a checkout
    const checkout = path.join(tempDir, "checkout");
    await fsp.rename(path.dirname(vault.file), checkout);
    await fsp.symlink(
      checkout,
      path.dirname(vault.file),
      process.platform === "win32" ? "junction" : "dir",
    );
    const runtime = await start(vault, hostOn(port));

    expect(runtime.status.state).toBe("connected");
    const expected = path.join(
      await fsp.realpath(path.dirname(path.dirname(vault.file))),
      PLUGIN_ID,
      "data.json",
    );
    expect(registeredPath(vault)).toBe(
      process.platform === "win32" ? expected.toLowerCase() : expected,
    );
    expect(
      JSON.parse((await call(port, routeOf(runtime), secretFor("a1"))).body),
    ).toEqual({ vault: "a", tokenId: "a1" });
    expect(notices).toEqual([]);
  });

  /**
   * Break the vault's data file, start its route, then fix the file: The
   * refusal names its cause once and the route recovers on a later retry.
   */
  async function refusedUntilFixed(
    breakFile: (vault: Vault) => Promise<void>,
    fixFile: (vault: Vault) => Promise<void>,
    reason: (file: string) => string,
  ) {
    const port = await freePort();
    const vault = await openVault("a", "a1");
    await breakFile(vault);
    const { host, allowRetry, open } = gatedHost(port);
    try {
      const runtime = await start(vault, host);
      expect(runtime.status.state).toBe("rejected");
      const message = runtime.status.message ?? "";
      expect(message).toContain(reason(registeredPath(vault)));
      expect(message).toContain(
        "the copy buttons in Access Control give its direct address",
      );
      expect(notices).toEqual([message]);
      // The direct address the copy buttons fall back to
      expect(runtime.transportPort).toBe(vault.port);

      // Still broken: the status keeps the reason, no second Notice
      const refusedAgain = nextStatus(runtime);
      allowRetry();
      expect(await refusedAgain).toEqual({ state: "rejected", message });
      expect(notices).toHaveLength(1);

      await fixFile(vault);
      const recovered = untilStatus(
        runtime,
        (status) => status.state === "connected",
      );
      allowRetry();
      await recovered;
      expect(
        JSON.parse((await call(port, routeOf(runtime), secretFor("a1"))).body),
      ).toEqual({ vault: "a", tokenId: "a1" });
      expect(notices).toHaveLength(1);
    } finally {
      open();
    }
  }

  // Through the plugin's own settings store, like any setting
  const padding = (value: string | undefined) => (vault: Vault) =>
    new SettingsStore(vault.plugin)
      .updateSlice("padding", () => value)
      .then(() => undefined);

  test("a data file over 1 MB is named, shown once and recovers once it shrinks", async () => {
    await refusedUntilFixed(
      padding("x".repeat(1024 * 1024)),
      padding(undefined),
      (file) =>
        `The shared broker refused this vault's route: The data file ${file} is larger than 1 MB, the most the shared broker reads`,
    );
  });

  test("a transient failure while refused keeps the refusal until a registration succeeds", async () => {
    const port = await freePort();
    const vault = await openVault("a", "a1");
    await padding("x".repeat(1024 * 1024))(vault);
    const { host, allowRetry, open, failNextRetry, retryWaits } =
      gatedHost(port);
    try {
      const runtime = await start(vault, host);
      expect(runtime.status.state).toBe("rejected");
      const message = runtime.status.message ?? "";
      const states: string[] = [];
      const unsubscribe = runtime.subscribe((status) =>
        states.push(status.state),
      );

      // A retry dropped mid-election, while the file is still too large
      const waited = retryWaits();
      failNextRetry();
      allowRetry();
      await waited;
      unsubscribe();
      expect(states).toEqual(["rejected"]);
      expect(runtime.status).toEqual({ state: "rejected", message });
      expect(notices).toEqual([message]);

      await padding(undefined)(vault);
      const recovered = untilStatus(
        runtime,
        (status) => status.state === "connected",
      );
      allowRetry();
      await recovered;
      expect(
        JSON.parse((await call(port, routeOf(runtime), secretFor("a1"))).body),
      ).toEqual({ vault: "a", tokenId: "a1" });
      expect(notices).toHaveLength(1);
    } finally {
      open();
    }
  });

  test.skipIf(process.platform === "win32")(
    "a data file every user can write is named, shown once and recovers once fixed",
    async () => {
      await refusedUntilFixed(
        async (vault) => {
          // Written once so the mode sticks, the vault keeps it on save
          await vault.plugin.saveData(vault.plugin._data);
          await fsp.chmod(vault.file, 0o666);
        },
        (vault) => fsp.chmod(vault.file, 0o600),
        (file) =>
          `Every user on this computer can write to the data file ${file}. Remove that write access, for example with chmod o-w`,
      );
    },
  );

  test("a refusal the vault cannot explain still says so once", async () => {
    const port = await freePort();
    const vault = await openVault("a", "a1");
    // A host whose plugin ID differs refuses a file this vault finds valid
    const host = createBrokerHost({ port, pluginId: "another-plugin" });
    hosts.push(host);
    const runtime = await start(vault, host);
    expect(runtime.status.state).toBe("rejected");
    expect(runtime.status.message).toContain(
      "The shared broker refused this vault's route with HTTP 401, for a reason this vault cannot check",
    );
    expect(notices).toEqual([runtime.status.message!]);
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
