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
import { captureLogLines } from "$/shared/log/logCapture";
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
import {
  classifyLocation,
  DEVICE_LOCATIONS_KEY,
  pathStyle,
  windowLocationStore,
  type DeviceLocationStore,
  type LocationVerdict,
} from "./deviceLocations";
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

/** A device record in memory that counts how often it was written. */
function memoryStore(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    writes: 0,
    get(routeId: string): string | null {
      return entries.get(routeId) ?? null;
    },
    set(routeId: string, file: string): void {
      this.writes += 1;
      entries.set(routeId, file);
    },
  };
}

/** A device record whose reads, writes or both throw, like a broken localStorage. */
function throwingStore(
  broken: { get?: boolean; set?: boolean },
  initial: Record<string, string> = {},
) {
  const inner = memoryStore(initial);
  return {
    entries: inner.entries,
    get(routeId: string): string | null {
      if (broken.get) throw new Error("storage unavailable");
      return inner.get(routeId);
    },
    set(routeId: string, file: string): void {
      if (broken.set) throw new Error("storage unavailable");
      inner.set(routeId, file);
    },
  } satisfies DeviceLocationStore & { entries: Map<string, string> };
}

/**
 * The path the broker service canonicalises `file` to, written out here so the
 * tests do not lean on the code under test. The plugin folder keeps its own
 * name, every folder above it is resolved.
 */
async function canonical(file: string): Promise<string> {
  const pluginDir = path.dirname(file);
  const resolved = path.join(
    await fsp.realpath(path.dirname(pluginDir)),
    path.basename(pluginDir),
    path.basename(file),
  );
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const ROW_URL = "http://127.0.0.1:27200/v1/synthetic-route/mcp";

let tempDir = "";
let dataPath = "";
/** The device record of the running test: one device, so one store. */
let locations = memoryStore();
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
  _signal?: AbortSignal,
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
    locations,
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
  locations = memoryStore();
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

  test("stop() aborts a reconnection still connecting instead of waiting for it", async () => {
    const plugin = fakePlugin(withTokens("a"));
    let callCount = 0;
    let secondRequested!: () => void;
    const secondCalled = new Promise<void>((resolve) => {
      secondRequested = resolve;
    });
    let secondSignal: AbortSignal | undefined;
    const hangingConnect: typeof connectRegistration = async (
      port,
      routeIdArg,
      token,
      lease,
      registration,
      signal,
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
      // A registration that never answers: only the abort ends it, as it
      // does for a real request whose broker went silent.
      secondSignal = signal;
      secondRequested();
      return new Promise<TestControl>((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new Error("Broker registration aborted")),
        );
      });
    };

    const runtime = await startDiscovery(plugin, {
      ...fakeOpts(),
      connectRegistration: hangingConnect,
    });
    controls[0].disconnect();
    await secondCalled;
    expect(secondSignal).toBeDefined();

    await runtime.stop();
    expect(secondSignal!.aborted).toBe(true);
    expect(runtime.status.state).toBe("stopped");
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
  // The path is saved in the device record, never in the synced settings
  expect(storedSettings(plugin).dataPath).toBeUndefined();
  expect(locations.get(runtime.routeId)).toBe(await canonical(dataPath));
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
  // The synced legacy value stays as it was, the device record gets the form
  expect(storedSettings(plugin).dataPath).toBe(linked.legacyPath);
  expect(locations.get(runtime.routeId)).toBe(linked.currentPath);
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

/**
 * Ports this file has listened on or handed out. The OS can return a port
 * it just released, so two calls in one test (a broker port, then a
 * vault's transport port) could get the same number, and the broker would
 * find its port taken by the vault (#637).
 */
const handedOut = new Set<number>();

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const bound = (server.address() as { port: number }).port;
      handedOut.add(bound);
      resolve(bound);
    });
  });
}

/**
 * A port nothing listens on right now and this file has not used. Small
 * TOCTOU window against other processes, the same trade-off
 * httpServer.test.ts and port.test.ts accept.
 */

async function freePort(): Promise<number> {
  for (;;) {
    const server = http.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as { port: number }).port),
      );
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
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
    locations,
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
      locations,
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
    [
      // (coverage) the release before ADR-0035 still compares a saved dataPath
      "a broker of the previous protocol version 3",
      (_req: http.IncomingMessage, res: http.ServerResponse) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: BROKER_NAME, version: 3 }));
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

  /** The data file path the vault registered, saved in the device record. */
  const registeredPath = (vault: Vault) =>
    locations.get(storedSettings(vault.plugin).routeId as string) as string;

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
    // The same device as the original, so the same record
    locations,
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

/**
 * R-09 and R-05: a successful registration is logged, and the line never
 * carries the route id or the access token. Read back from an in-memory
 * file system the logger is configured onto, so it is what is actually
 * written, after redaction.
 */
describe("diagnostic log — broker route registered", () => {
  const REGISTERED = "Broker route registered";
  const { lines, has, named, written } = captureLogLines();

  test("a successful registration writes `Broker route registered` {brokerPort, transportPort} and neither the route id nor the access token", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const host = fakeHost();
    host.port = 27200;
    const runtime = await startDiscovery(plugin, fakeOpts(host));
    runtimes.push(runtime);
    expect(runtime.status.state).toBe("connected");

    const registered = named(
      await lines((a) => has(a, REGISTERED)),
      REGISTERED,
    );
    const text = written();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.level).toBe("INFO");
    expect(registered[0]?.fields).toEqual({
      brokerPort: 27200,
      transportPort: 27201,
    });

    const settings = storedSettings(plugin);
    expect(text).not.toContain(runtime.routeId);
    expect(text).not.toContain(settings.accessToken as string);
    expect(text).not.toContain(secretFor("a"));
  });
});

// ---------------------------------------------------------------------------
// ADR-0035: where this device bound each route, kept per device
// ---------------------------------------------------------------------------

describe("per-device location record", () => {
  const { lines, written } = captureLogLines();
  const ROUTE = "123e4567-e89b-42d3-a456-426614174000";
  const WIN = process.platform === "win32";

  /** A path in the style of the other platform, whatever this one is. */
  const foreignStyle = WIN
    ? "/Users/someone/vault/.obsidian/plugins/mcp-tools-istefox/data.json"
    : "c:\\users\\someone\\vault\\.obsidian\\plugins\\mcp-tools-istefox\\data.json";
  /** A path in this platform's style that names another location. */
  const elsewhere = WIN
    ? "c:\\elsewhere\\vault\\.obsidian\\plugins\\mcp-tools-istefox\\data.json"
    : "/elsewhere/vault/.obsidian/plugins/mcp-tools-istefox/data.json";

  /** A vault with a saved route, and a legacy synced `dataPath` when given. */
  function routed(legacy?: string) {
    return fakePlugin({
      ...withTokens("a"),
      mcpClientConfig: {
        codexDiscovery: {
          routeId: ROUTE,
          accessToken: secretFor("broker"),
          ...(legacy === undefined ? {} : { dataPath: legacy }),
        },
      },
    });
  }

  /** Every combination of device record and legacy value the SPEC names. */
  type Case = {
    label: string;
    /** `current` is this vault's canonical path. */
    local: (current: string) => string | null;
    legacy: (current: string) => string | undefined;
    changed: boolean;
  };
  const same = (current: string) => current;
  const CASES: Case[] = [
    // R-01
    {
      label: "R-01 no entry, no legacy value",
      local: () => null,
      legacy: () => undefined,
      changed: false,
    },
    // R-02
    {
      label: "R-02 no entry, legacy value of the other platform's style",
      local: () => null,
      legacy: () => foreignStyle,
      changed: false,
    },
    // R-03
    {
      label: "R-03 no entry, legacy value of this style that differs",
      local: () => null,
      legacy: () => elsewhere,
      changed: true,
    },
    {
      label: "R-03 no entry, legacy value of no known style that differs",
      local: () => null,
      legacy: () => "synthetic-original-location/data.json",
      changed: true,
    },
    {
      label: "no entry, legacy value equal to the current path",
      local: () => null,
      legacy: same,
      changed: false,
    },
    // R-04
    {
      label: "R-04 entry equal, no legacy value",
      local: same,
      legacy: () => undefined,
      changed: false,
    },
    {
      label: "R-04 entry equal, legacy value equal",
      local: same,
      legacy: same,
      changed: false,
    },
    {
      label: "R-04 entry equal, legacy value of the other style",
      local: same,
      legacy: () => foreignStyle,
      changed: false,
    },
    {
      label: "R-04 entry equal, legacy value of this style that differs",
      local: same,
      legacy: () => elsewhere,
      changed: false,
    },
    // R-05
    {
      label: "R-05 entry differs, no legacy value",
      local: () => elsewhere,
      legacy: () => undefined,
      changed: true,
    },
    {
      label: "R-05 entry differs, legacy value equal to the current path",
      local: () => elsewhere,
      legacy: same,
      changed: true,
    },
    {
      label: "R-05 entry differs, legacy value of the other style",
      local: () => elsewhere,
      legacy: () => foreignStyle,
      changed: true,
    },
  ];

  /** Options with the record `initial` instead of the test's empty one. */
  function withRecord(initial: Record<string, string>) {
    locations = memoryStore(initial);
    return fakeOpts();
  }

  /** The case's plugin and options, seeded for this vault's own path. */
  async function seeded(c: Case) {
    const current = await canonical(dataPath);
    const local = c.local(current);
    const opts = withRecord(local === null ? {} : { [ROUTE]: local });
    return { plugin: routed(c.legacy(current)), opts, current };
  }

  describe("pathStyle", () => {
    test.each([
      ["C:\\Users\\me\\data.json", "windows"],
      ["c:/users/me/data.json", "windows"],
      ["c:\\users\\me\\data.json", "windows"],
      ["Z:/vault/data.json", "windows"],
      ["\\\\host\\share\\vault\\data.json", "windows"],
      ["/Users/me/vault/data.json", "posix"],
      ["/", "posix"],
      ["vault/data.json", "other"],
      ["data.json", "other"],
      ["~/vault/data.json", "other"],
      ["c:data.json", "other"],
      ["", "other"],
    ])("%p is %s", (file, expected) => {
      expect(pathStyle(file)).toBe(expected as ReturnType<typeof pathStyle>);
    });
  });

  describe("classifyLocation", () => {
    const POSIX = "/vault/.obsidian/plugins/mcp-tools-istefox/data.json";
    const OTHER_POSIX = "/old/.obsidian/plugins/mcp-tools-istefox/data.json";
    const WINDOWS =
      "c:\\vault\\.obsidian\\plugins\\mcp-tools-istefox\\data.json";
    const OTHER_WINDOWS =
      "c:\\old\\.obsidian\\plugins\\mcp-tools-istefox\\data.json";
    const UNC = "\\\\host\\share\\vault\\data.json";
    const RELATIVE = "synthetic-original-location/data.json";

    type Row = [
      string,
      {
        local: string | null;
        legacy: string | undefined;
        current: string;
        legacyIsOwnFile: boolean;
      },
      LocationVerdict,
    ];
    const row = (
      label: string,
      local: string | null,
      legacy: string | undefined,
      current: string,
      verdict: LocationVerdict,
      legacyIsOwnFile = false,
    ): Row => [label, { local, legacy, current, legacyIsOwnFile }, verdict];

    test.each([
      // No entry: the legacy value decides, once
      row("no entry, no legacy value", null, undefined, POSIX, "bind"),
      row("no entry, legacy equal", null, POSIX, POSIX, "bind"),
      row("no entry, legacy of the other style", null, WINDOWS, POSIX, "bind"),
      row(
        "no entry, UNC legacy against a POSIX path",
        null,
        UNC,
        POSIX,
        "bind",
      ),
      row(
        "no entry, POSIX legacy against a Windows path",
        null,
        POSIX,
        WINDOWS,
        "bind",
      ),
      row(
        "no entry, same style POSIX that differs",
        null,
        OTHER_POSIX,
        POSIX,
        "changed",
      ),
      row(
        "no entry, same style Windows that differs",
        null,
        OTHER_WINDOWS,
        WINDOWS,
        "changed",
      ),
      row(
        "no entry, legacy of no known style that differs",
        null,
        RELATIVE,
        POSIX,
        "changed",
      ),
      row(
        "no entry, current path of no known style, legacy Windows",
        null,
        WINDOWS,
        RELATIVE,
        "changed",
      ),
      row(
        "no entry, own file in the older form",
        null,
        OTHER_POSIX,
        POSIX,
        "bind",
        true,
      ),
      row(
        "no entry, own file in the older form, Windows",
        null,
        OTHER_WINDOWS,
        WINDOWS,
        "bind",
        true,
      ),
      row(
        "no entry, own file in the older form, no known style",
        null,
        RELATIVE,
        POSIX,
        "bind",
        true,
      ),
      // An entry decides alone
      row("entry equal, no legacy value", POSIX, undefined, POSIX, "same"),
      row("entry equal, legacy equal", POSIX, POSIX, POSIX, "same"),
      row(
        "entry equal, legacy of the other style",
        POSIX,
        WINDOWS,
        POSIX,
        "same",
      ),
      row(
        "entry equal, legacy that differs",
        POSIX,
        OTHER_POSIX,
        POSIX,
        "same",
      ),
      row(
        "entry equal, legacy of no known style",
        POSIX,
        RELATIVE,
        POSIX,
        "same",
      ),
      row(
        "entry equal, legacy is own file",
        POSIX,
        OTHER_POSIX,
        POSIX,
        "same",
        true,
      ),
      row(
        "entry differs, no legacy value",
        OTHER_POSIX,
        undefined,
        POSIX,
        "changed",
      ),
      row(
        "entry differs, legacy equal to the current path",
        OTHER_POSIX,
        POSIX,
        POSIX,
        "changed",
      ),
      row(
        "entry differs, legacy of the other style",
        OTHER_POSIX,
        WINDOWS,
        POSIX,
        "changed",
      ),
      row(
        "entry differs, legacy is own file",
        OTHER_POSIX,
        POSIX,
        POSIX,
        "changed",
        true,
      ),
      row("entry of the other style", WINDOWS, undefined, POSIX, "changed"),
    ])("%s", (_label, input, verdict) => {
      expect(classifyLocation(input)).toBe(verdict);
    });
  });

  describe("start", () => {
    test("R-01 a vault with no entry and no legacy value binds silently and saves no dataPath", async () => {
      const plugin = fakePlugin(withTokens("a"));
      const runtime = await startDiscovery(plugin, fakeOpts());
      runtimes.push(runtime);
      expect(runtime.status.state).toBe("connected");
      expect(runtime.status.locationChanged).not.toBe(true);
      expect(locations.get(runtime.routeId)).toBe(await canonical(dataPath));
      expect(storedSettings(plugin).dataPath).toBeUndefined();
      expect(notices).toEqual([]);
      expect(registrations).toHaveLength(1);
    });

    test("R-02 a legacy value of the other platform's style is ignored, bound silently and left alone", async () => {
      const plugin = routed(foreignStyle);
      const runtime = await startDiscovery(plugin, fakeOpts());
      runtimes.push(runtime);
      expect(runtime.status.state).toBe("connected");
      expect(runtime.status.locationChanged).not.toBe(true);
      expect(notices).toEqual([]);
      expect(locations.get(ROUTE)).toBe(await canonical(dataPath));
      expect(locations.writes).toBe(1);
      expect(storedSettings(plugin).dataPath).toBe(foreignStyle);
    });

    test("R-03 a legacy value of this style that differs prompts once, and a confirmed move records the path on this device only", async () => {
      const plugin = routed(elsewhere);
      const opts = fakeOpts();
      const blocked = await startDiscovery(plugin, opts);
      expect(blocked.status.locationChanged).toBe(true);
      expect(blocked.status.state).toBe("conflict");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("Vault location changed");
      expect(registrations).toHaveLength(0);
      expect(locations.get(ROUTE)).toBeNull();

      const moved = await replaceWith(
        plugin,
        blocked,
        () => acceptDiscoveryMove(plugin, opts),
        opts,
      );
      expect(moved.status.state).toBe("connected");
      expect(moved.routeId).toBe(ROUTE);
      expect(locations.get(ROUTE)).toBe(await canonical(dataPath));
      expect(storedSettings(plugin).dataPath).toBe(elsewhere);

      // Started again, as after a reload: silent, nothing new to confirm
      await moved.stop();
      const again = await startDiscovery(plugin, opts);
      runtimes.push(again);
      expect(again.status.state).toBe("connected");
      expect(again.status.locationChanged).not.toBe(true);
      expect(notices).toHaveLength(1);
    });

    test.each([
      ["absent", () => undefined],
      ["equal", (current: string) => current],
      ["of the other style", () => foreignStyle],
      ["of this style and differing", () => elsewhere],
    ])(
      "R-04 an entry equal to the current path starts silently with a legacy value %s",
      async (_label, legacy) => {
        const current = await canonical(dataPath);
        const opts = withRecord({ [ROUTE]: current });
        const plugin = routed(legacy(current));
        const runtime = await startDiscovery(plugin, opts);
        runtimes.push(runtime);
        expect(runtime.status.state).toBe("connected");
        expect(runtime.status.locationChanged).not.toBe(true);
        expect(notices).toEqual([]);
        expect(locations.writes).toBe(0);
        expect(storedSettings(plugin).dataPath).toBe(legacy(current));
      },
    );

    test("R-05 an entry that differs for the same route prompts once and registers nothing", async () => {
      const opts = withRecord({ [ROUTE]: elsewhere });
      const plugin = routed();
      const blocked = await startDiscovery(plugin, opts);
      runtimes.push(blocked);
      expect(blocked.status.locationChanged).toBe(true);
      expect(blocked.routeId).toBe(ROUTE);
      expect(notices).toHaveLength(1);
      expect(registrations).toHaveLength(0);
      expect(locations.get(ROUTE)).toBe(elsewhere);
      expect(locations.writes).toBe(0);
    });

    test.each(CASES.map((c) => [c.label, c] as const))(
      "%s writes the record only when it binds",
      async (_label, c) => {
        const { plugin, opts, current } = await seeded(c);
        const before = c.legacy(current);
        const runtime = await startDiscovery(plugin, opts);
        runtimes.push(runtime);
        expect(runtime.status.locationChanged === true).toBe(c.changed);
        expect(notices).toHaveLength(c.changed ? 1 : 0);
        expect(storedSettings(plugin).dataPath).toBe(before);
        if (!c.changed) expect(locations.get(ROUTE)).toBe(current);
      },
    );
  });

  describe("R-06 the synced dataPath is never written", () => {
    test("a first bind, a confirmed move and a reset leave no dataPath where there was none", async () => {
      const plugin = fakePlugin(withTokens("a"));
      const opts = fakeOpts();
      const first = await startDiscovery(plugin, opts);
      expect(storedSettings(plugin).dataPath).toBeUndefined();

      const movedOpts = {
        ...opts,
        dataPath: path.join(tempDir, "copy", "data.json"),
      };
      await fsp.mkdir(path.dirname(movedOpts.dataPath));
      await first.stop();
      const blocked = await startDiscovery(plugin, movedOpts);
      expect(blocked.status.locationChanged).toBe(true);
      const moved = await replaceWith(
        plugin,
        blocked,
        () => acceptDiscoveryMove(plugin, movedOpts),
        movedOpts,
      );
      expect(storedSettings(plugin).dataPath).toBeUndefined();

      const reset = await replaceWith(
        plugin,
        moved,
        () => resetDiscoveryIdentity(plugin, movedOpts),
        movedOpts,
      );
      runtimes.push(reset);
      expect(storedSettings(plugin).dataPath).toBeUndefined();
    });

    test("R-03 a confirmed move does not rewrite the synced data when the route exists", async () => {
      const plugin = routed(elsewhere);
      const opts = fakeOpts();
      const save = plugin.saveData.bind(plugin);
      let saves = 0;
      plugin.saveData = async (next: unknown) => {
        saves += 1;
        await save(next);
      };
      await acceptDiscoveryMove(plugin, opts);
      expect(saves).toBe(0);
    });

    test("a seeded legacy value survives a bind, a confirmed move and a reset byte for byte", async () => {
      const plugin = routed(elsewhere);
      const opts = fakeOpts();
      const blocked = await startDiscovery(plugin, opts);
      expect(storedSettings(plugin).dataPath).toBe(elsewhere);
      const moved = await replaceWith(
        plugin,
        blocked,
        () => acceptDiscoveryMove(plugin, opts),
        opts,
      );
      expect(storedSettings(plugin).dataPath).toBe(elsewhere);
      const reset = await replaceWith(
        plugin,
        moved,
        () => resetDiscoveryIdentity(plugin, opts),
        opts,
      );
      runtimes.push(reset);
      expect(storedSettings(plugin).dataPath).toBe(elsewhere);
    });

    test("a legacy value of the other style survives the bind it is ignored for", async () => {
      const plugin = routed(foreignStyle);
      const runtime = await startDiscovery(plugin, fakeOpts());
      runtimes.push(runtime);
      expect(storedSettings(plugin).dataPath).toBe(foreignStyle);
    });
  });

  describe("R-07 identity", () => {
    test("a confirmed move keeps the route ID and the route credential", async () => {
      const opts = withRecord({ [ROUTE]: elsewhere });
      const plugin = routed();
      const blocked = await startDiscovery(plugin, opts);
      expect(blocked.status.locationChanged).toBe(true);
      const moved = await replaceWith(
        plugin,
        blocked,
        () => acceptDiscoveryMove(plugin, opts),
        opts,
      );
      runtimes.push(moved);
      expect(moved.routeId).toBe(ROUTE);
      expect(storedSettings(plugin).routeId).toBe(ROUTE);
      expect(storedSettings(plugin).accessToken).toBe(secretFor("broker"));
      expect(locations.get(ROUTE)).toBe(await canonical(dataPath));
    });

    test("a reset mints a new route ID and credential, records the new route and keeps the old entry", async () => {
      const opts = withRecord({ [ROUTE]: elsewhere });
      const plugin = routed();
      const blocked = await startDiscovery(plugin, opts);
      expect(blocked.status.locationChanged).toBe(true);
      const reset = await replaceWith(
        plugin,
        blocked,
        () => resetDiscoveryIdentity(plugin, opts),
        opts,
      );
      runtimes.push(reset);
      expect(reset.status.state).toBe("connected");
      expect(reset.routeId).not.toBe(ROUTE);
      expect(storedSettings(plugin).routeId).toBe(reset.routeId);
      expect(storedSettings(plugin).accessToken).not.toBe(secretFor("broker"));
      expect(locations.get(reset.routeId)).toBe(await canonical(dataPath));
      expect(locations.get(ROUTE)).toBe(elsewhere);
    });

    test("a confirmed move on a vault with no saved route mints one and records it", async () => {
      const plugin = fakePlugin(withTokens("a"));
      await acceptDiscoveryMove(plugin, fakeOpts());
      const routeId = storedSettings(plugin).routeId as string;
      expect(locations.get(routeId)).toBe(await canonical(dataPath));
      expect(storedSettings(plugin).dataPath).toBeUndefined();
    });
  });

  describe("R-08 the check agrees with the start", () => {
    test.each(CASES.map((c) => [c.label, c] as const))(
      "%s",
      async (_label, c) => {
        const { plugin, opts } = await seeded(c);
        const unresolved = await isLocationUnresolved(plugin, opts);
        const runtime = await startDiscovery(plugin, opts);
        runtimes.push(runtime);
        expect(unresolved).toBe(c.changed);
        expect(unresolved).toBe(runtime.status.locationChanged === true);
      },
    );

    test("the check never writes the record", async () => {
      const opts = withRecord({});
      await isLocationUnresolved(routed(), opts);
      await isLocationUnresolved(routed(foreignStyle), opts);
      expect(locations.writes).toBe(0);
    });

    // The path cannot be read: its parent folder does not exist
    const unreadable = () => ({
      dataPath: path.join(tempDir, "missing", "plugins", "data.json"),
    });

    test.each([
      ["an entry", () => routed(), { [ROUTE]: elsewhere }],
      ["a legacy value", () => routed(elsewhere), {}],
      ["both", () => routed(elsewhere), { [ROUTE]: elsewhere }],
    ])(
      "a route with %s and an unreadable location is unresolved",
      async (_label, plugin, initial) => {
        const opts = { ...withRecord(initial), ...unreadable() };
        expect(await isLocationUnresolved(plugin(), opts)).toBe(true);
      },
    );

    test("a saved route that was never bound is resolved without reading the path", async () => {
      const opts = { ...withRecord({}), ...unreadable() };
      expect(await isLocationUnresolved(routed(), opts)).toBe(false);
    });

    test("a vault with no saved route is resolved", async () => {
      const opts = withRecord({ [ROUTE]: elsewhere });
      expect(
        await isLocationUnresolved(fakePlugin(withTokens("a")), opts),
      ).toBe(false);
    });
  });

  describe("R-09 a record that cannot be read or written", () => {
    function warnings(all: Awaited<ReturnType<typeof lines>>) {
      return all.filter((line) => line.level === "WARN");
    }

    /** What a log line must never carry: a path or a route ID. */
    function expectNoPathOrRoute(text: string, routeId: string) {
      expect(text).not.toContain(routeId);
      expect(text).not.toContain(tempDir);
      expect(text).not.toContain(path.basename(tempDir));
    }

    test("a store whose get throws reads as empty and logs one warning with no path or route ID", async () => {
      locations = throwingStore({ get: true }) as unknown as ReturnType<
        typeof memoryStore
      >;
      const plugin = routed();
      const runtime = await startDiscovery(plugin, fakeOpts());
      runtimes.push(runtime);
      // Empty record and no legacy value: a first bind, never a prompt
      expect(runtime.status.state).toBe("connected");
      expect(runtime.status.locationChanged).not.toBe(true);
      expect(notices).toEqual([]);
      const all = await lines(() => true);
      expect(warnings(all)).toHaveLength(1);
      expectNoPathOrRoute(written(), ROUTE);
    });

    test("a store whose get throws does not hide a legacy value that differs", async () => {
      locations = throwingStore({ get: true }) as unknown as ReturnType<
        typeof memoryStore
      >;
      const runtime = await startDiscovery(routed(elsewhere), fakeOpts());
      runtimes.push(runtime);
      expect(runtime.status.locationChanged).toBe(true);
    });

    test("a store whose set throws still ends connected and logs the failed write without path or route ID", async () => {
      locations = throwingStore({ set: true }) as unknown as ReturnType<
        typeof memoryStore
      >;
      const plugin = routed();
      const runtime = await startDiscovery(plugin, fakeOpts());
      runtimes.push(runtime);
      expect(runtime.status.state).toBe("connected");
      expect(notices).toEqual([]);
      expect(registrations).toHaveLength(1);
      const all = await lines(() => true);
      expect(warnings(all)).toHaveLength(1);
      expectNoPathOrRoute(written(), ROUTE);
    });

    test.each(["move", "reset"])(
      "a confirmed %s with a store whose set throws does not throw",
      async (scenario) => {
        locations = throwingStore({ set: true }) as unknown as ReturnType<
          typeof memoryStore
        >;
        const opts = fakeOpts();
        const plugin = routed(elsewhere);
        const run =
          scenario === "move"
            ? acceptDiscoveryMove(plugin, opts)
            : resetDiscoveryIdentity(plugin, opts);
        await expect(run).resolves.toBeUndefined();
      },
    );

    describe("windowLocationStore over window.localStorage", () => {
      const original = Object.getOwnPropertyDescriptor(window, "localStorage");

      function installStorage(descriptor: PropertyDescriptor) {
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          ...descriptor,
        });
      }

      /** The call throws, and not with the unfinished stub's own error. */
      function expectStorageError(call: () => unknown) {
        let message: string | null = null;
        try {
          call();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).not.toBeNull();
        expect(message).not.toBe("not implemented");
      }

      beforeEach(() => {
        window.localStorage.clear();
      });

      afterEach(() => {
        if (original) Object.defineProperty(window, "localStorage", original);
        window.localStorage.clear();
      });

      test("keeps one entry per route under the shared key", () => {
        const store = windowLocationStore();
        expect(store.get(ROUTE)).toBeNull();
        store.set(ROUTE, "/one/data.json");
        store.set("another-route", "/two/data.json");
        expect(store.get(ROUTE)).toBe("/one/data.json");
        expect(store.get("another-route")).toBe("/two/data.json");
        expect(
          JSON.parse(window.localStorage.getItem(DEVICE_LOCATIONS_KEY)!),
        ).toEqual({
          [ROUTE]: "/one/data.json",
          "another-route": "/two/data.json",
        });
      });

      test("is read on every call, so a later storage is seen", () => {
        const store = windowLocationStore();
        store.set(ROUTE, "/one/data.json");
        window.localStorage.setItem(
          DEVICE_LOCATIONS_KEY,
          JSON.stringify({ [ROUTE]: "/two/data.json" }),
        );
        expect(store.get(ROUTE)).toBe("/two/data.json");
      });

      test("a start with no injected record binds into window.localStorage", async () => {
        const { locations: _unused, ...opts } = fakeOpts();
        const runtime = await startDiscovery(fakePlugin(withTokens("a")), opts);
        runtimes.push(runtime);
        expect(runtime.status.state).toBe("connected");
        expect(
          JSON.parse(window.localStorage.getItem(DEVICE_LOCATIONS_KEY)!),
        ).toEqual({ [runtime.routeId]: await canonical(dataPath) });
      });

      /** The three ways the storage can be unusable, plus a corrupt value. */
      const BROKEN: Array<[string, () => void]> = [
        [
          "throws on access",
          () =>
            installStorage({
              get: () => {
                throw new Error("SecurityError");
              },
            }),
        ],
        ["is missing", () => installStorage({ value: undefined })],
        ["has no getItem and setItem", () => installStorage({ value: {} })],
        [
          "holds invalid JSON under the key",
          () => window.localStorage.setItem(DEVICE_LOCATIONS_KEY, "{not json"),
        ],
      ];

      test.each(BROKEN)("get throws when the storage %s", (_label, break_) => {
        break_();
        expectStorageError(() => windowLocationStore().get(ROUTE));
      });

      test.each(BROKEN.slice(0, 3))(
        "set throws when the storage %s",
        (_label, break_) => {
          break_();
          expectStorageError(() =>
            windowLocationStore().set(ROUTE, "/one/data.json"),
          );
        },
      );

      test.each(BROKEN)(
        "a start over a storage that %s behaves as an empty record and still connects",
        async (_label, break_) => {
          break_();
          const { locations: _unused, ...opts } = fakeOpts();
          const runtime = await startDiscovery(routed(), opts);
          runtimes.push(runtime);
          expect(runtime.status.state).toBe("connected");
          expect(runtime.status.locationChanged).not.toBe(true);
          expect(notices).toEqual([]);
          const all = await lines(() => true);
          expect(warnings(all).length).toBeGreaterThanOrEqual(1);
          expectNoPathOrRoute(written(), ROUTE);
        },
      );

      // (coverage) valid JSON that is not a route map is as invalid as text
      // that does not parse: get throws and a set replaces it
      test.each([["[]"], ["null"], ["42"], ['"text"']])(
        "(coverage) %s under the key is invalid: get throws and a set replaces it",
        (raw) => {
          window.localStorage.setItem(DEVICE_LOCATIONS_KEY, raw);
          const store = windowLocationStore();
          expectStorageError(() => store.get(ROUTE));
          store.set(ROUTE, "/one/data.json");
          expect(
            JSON.parse(window.localStorage.getItem(DEVICE_LOCATIONS_KEY)!),
          ).toEqual({ [ROUTE]: "/one/data.json" });
        },
      );

      test("a set replaces invalid JSON under the key with a valid map", () => {
        window.localStorage.setItem(DEVICE_LOCATIONS_KEY, "{not json");
        const store = windowLocationStore();
        store.set(ROUTE, "/one/data.json");
        expect(
          JSON.parse(window.localStorage.getItem(DEVICE_LOCATIONS_KEY)!),
        ).toEqual({ [ROUTE]: "/one/data.json" });
        expect(store.get(ROUTE)).toBe("/one/data.json");
      });
    });
  });
});
