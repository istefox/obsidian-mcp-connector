import { describe, expect, test } from "bun:test";
import type {
  McpTransportState,
  SetupResult,
} from "$/features/mcp-transport/services/setup";
import type { DiscoveryRuntime } from "./discoveryBroker";
import {
  createRouteQueue,
  replaceRoute,
  restartTransport,
  RouteQueueClosed,
} from "./routeLifecycle";

/** Everything the steps did, in order, by name. */
type Log = string[];

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const names = new Map<McpTransportState, string>();

function transport(name: string, port: number): McpTransportState {
  const state = { server: { port } } as McpTransportState;
  names.set(state, name);
  return state;
}

function runtime(name: string, log: Log): DiscoveryRuntime {
  let stopped = false;
  return {
    routeId: name,
    transportPort: 27201,
    get status() {
      return { state: stopped ? ("stopped" as const) : ("connected" as const) };
    },
    subscribe: () => () => undefined,
    async stop() {
      stopped = true;
      log.push(`stop route ${name}`);
    },
  };
}

function holder(log: Log, port = 27201) {
  const initial = transport("initial", port);
  return {
    routeQueue: createRouteQueue(),
    mcpTransportState: initial as McpTransportState | undefined,
    discoveryState: runtime("initial", log) as DiscoveryRuntime | undefined,
  };
}

/** Restart steps that log, with `setup` deciding the outcome. */
function steps(
  name: string,
  log: Log,
  setup: () => Promise<SetupResult>,
  startRoute: () => Promise<DiscoveryRuntime> = async () => runtime(name, log),
) {
  return {
    setup: async () => {
      log.push(`setup ${name}`);
      return setup();
    },
    teardown: async (state: McpTransportState) => {
      log.push(`teardown ${names.get(state)}`);
    },
    startRoute: async (port: number) => {
      log.push(`start route ${name} on ${port}`);
      return startRoute();
    },
  };
}

describe("restartTransport", () => {
  test("overlapping restarts run one at a time, so a later failure leaves no route behind", async () => {
    const log: Log = [];
    const plugin = holder(log);
    const inSetup = gate();
    const portSaved = gate();
    // A saved fixed port, then a saved server name whose restart fails
    const first = restartTransport(
      plugin,
      steps("port", log, async () => {
        inSetup.open();
        await portSaved.opened;
        return { success: true, state: transport("port", 27210) };
      }),
    );
    const second = restartTransport(
      plugin,
      steps("name", log, async () => ({
        success: false,
        error: "Port 27210 is in use — the MCP server did not start.",
      })),
    );
    // The second restart waits instead of tearing down the first's transport
    await inSetup.opened;
    expect(log).toEqual([
      "stop route initial",
      "teardown initial",
      "setup port",
    ]);

    portSaved.open();
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(false);
    expect(log).toEqual([
      "stop route initial",
      "teardown initial",
      "setup port",
      // The new transport's port, not the one torn down
      "start route port on 27210",
      "stop route port",
      "teardown port",
      "setup name",
    ]);
    expect(plugin.discoveryState).toBeUndefined();
    expect(plugin.mcpTransportState).toBeUndefined();
  });

  test("an operation queued at unload never runs", async () => {
    const log: Log = [];
    const plugin = holder(log);
    const inSetup = gate();
    const setUp = gate();
    const running = restartTransport(
      plugin,
      steps("running", log, async () => {
        inSetup.open();
        await setUp.opened;
        return { success: true, state: transport("running", 27210) };
      }),
    );
    await inSetup.opened;
    const queued = restartTransport(
      plugin,
      steps("queued", log, async () => ({
        success: true,
        state: transport("queued", 27211),
      })),
    );
    const routeChange = replaceRoute(plugin, {
      update: async () => {
        log.push("update");
      },
      startRoute: async () => runtime("moved", log),
    });
    plugin.routeQueue.close();
    setUp.open();

    await expect(running).rejects.toBeInstanceOf(RouteQueueClosed);
    await expect(queued).rejects.toBeInstanceOf(RouteQueueClosed);
    await expect(routeChange).rejects.toBeInstanceOf(RouteQueueClosed);
    expect(log).toEqual([
      "stop route initial",
      "teardown initial",
      "setup running",
      // Set up after unload, so torn down instead of installed
      "teardown running",
    ]);
    expect(plugin.mcpTransportState).toBeUndefined();
    expect(plugin.discoveryState).toBeUndefined();
  });

  test("a route that starts after unload is stopped instead of installed", async () => {
    const log: Log = [];
    const plugin = holder(log);
    const starting = gate();
    const started = gate();
    const restart = restartTransport(
      plugin,
      steps(
        "port",
        log,
        async () => ({ success: true, state: transport("port", 27210) }),
        async () => {
          starting.open();
          await started.opened;
          return runtime("port", log);
        },
      ),
    );
    await starting.opened;
    plugin.routeQueue.close();
    started.open();

    await expect(restart).rejects.toBeInstanceOf(RouteQueueClosed);
    expect(log.at(-1)).toBe("stop route port");
    expect(plugin.discoveryState).toBeUndefined();
    // Installed before unload, so onunload tears it down
    expect(names.get(plugin.mcpTransportState!)).toBe("port");
  });

  test("idle settles only after a route registering at unload has stopped", async () => {
    const log: Log = [];
    const plugin = holder(log);
    const starting = gate();
    const started = gate();
    const restart = restartTransport(
      plugin,
      steps(
        "port",
        log,
        async () => ({ success: true, state: transport("port", 27210) }),
        async () => {
          starting.open();
          await started.opened;
          return runtime("port", log);
        },
      ),
    );
    await starting.opened;
    // onunload: close the queue, then wait before releasing the transport
    plugin.routeQueue.close();
    let idle = false;
    const settled = plugin.routeQueue.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    started.open();
    await settled;
    expect(log.at(-1)).toBe("stop route port");
    await expect(restart).rejects.toBeInstanceOf(RouteQueueClosed);
  });

  test("a failed route start keeps the new transport and leaves the route down", async () => {
    const log: Log = [];
    const plugin = holder(log);
    const result = await restartTransport(
      plugin,
      steps(
        "port",
        log,
        async () => ({ success: true, state: transport("port", 27210) }),
        () =>
          Promise.reject(
            new Error("The shared broker requires a desktop vault."),
          ),
      ),
    );
    expect(result.success).toBe(true);
    expect(names.get(plugin.mcpTransportState!)).toBe("port");
    expect(plugin.discoveryState).toBeUndefined();
  });

  test("a legacy fixed 27200 starts its transport without a route", async () => {
    const log: Log = [];
    const plugin = holder(log);
    const result = await restartTransport(
      plugin,
      steps("legacy", log, async () => ({
        success: true,
        state: transport("legacy", 27200),
      })),
    );
    expect(result.success).toBe(true);
    expect(log.some((entry) => entry.startsWith("start route"))).toBe(false);
    expect(plugin.discoveryState).toBeUndefined();
  });
});

describe("replaceRoute", () => {
  test("stops the route, applies the update, then starts the route again", async () => {
    const log: Log = [];
    const plugin = holder(log, 27207);
    const started = await replaceRoute(plugin, {
      update: async () => {
        log.push("update");
      },
      startRoute: async (port) => {
        log.push(`start route moved on ${port}`);
        return runtime("moved", log);
      },
    });
    expect(started).toBe(true);
    // Registers the running transport's port
    expect(log).toEqual([
      "stop route initial",
      "update",
      "start route moved on 27207",
    ]);
    expect(plugin.discoveryState?.routeId).toBe("moved");
  });

  test.each([
    ["no transport runs", undefined],
    ["the transport holds the broker port", 27200],
  ])(
    "applies the update but starts no route while %s",
    async (_label, port) => {
      const log: Log = [];
      const plugin = holder(log);
      plugin.mcpTransportState =
        port === undefined ? undefined : transport("legacy", port);
      const started = await replaceRoute(plugin, {
        update: async () => {
          log.push("update");
        },
        startRoute: async () => {
          log.push("start route moved");
          return runtime("moved", log);
        },
      });
      expect(started).toBe(false);
      expect(log).toEqual(["stop route initial", "update"]);
      expect(plugin.discoveryState).toBeUndefined();
    },
  );

  test("a failed start leaves the route stopped, never a dead handle", async () => {
    const log: Log = [];
    const plugin = holder(log);
    await expect(
      replaceRoute(plugin, {
        startRoute: () => Promise.reject(new Error("settings write failed")),
      }),
    ).rejects.toThrow("settings write failed");
    expect(log).toEqual(["stop route initial"]);
    expect(plugin.discoveryState).toBeUndefined();
    // The queue keeps serving later operations
    expect(
      await replaceRoute(plugin, {
        startRoute: async () => runtime("retry", log),
      }),
    ).toBe(true);
  });
});
