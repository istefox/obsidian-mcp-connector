import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { activateToolHandler } from "./activateTool";

function makeRegistry(
  entries: { name: string; enabled: boolean }[],
): Parameters<typeof activateToolHandler>[0]["registry"] {
  return {
    listAll: () =>
      entries.map((e) => ({
        name: e.name,
        description: `${e.name} description`,
        enabled: e.enabled,
      })),
  };
}

function makePlugin() {
  let store: Record<string, unknown> = {};
  return {
    loadData: async () => ({ ...store }),
    saveData: async (d: unknown) => {
      store = { ...(d as Record<string, unknown>) };
    },
    _store: () => store,
  };
}

function makeServer(): { server: McpServer; notifications: string[] } {
  const notifications: string[] = [];
  const server = {
    server: {
      notification: async (n: { method: string }) => {
        notifications.push(n.method);
      },
    },
  } as unknown as McpServer;
  return { server, notifications };
}

const ENTRIES = [
  { name: "search_vault", enabled: true },
  { name: "find_broken_links", enabled: false },
];

describe("activateToolHandler", () => {
  test("unknown tool returns isError without side effects", async () => {
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server } = makeServer();
    const result = await activateToolHandler({
      arguments: { name: "nonexistent" },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    expect(result.isError).toBe(true);
    expect(enabled).toHaveLength(0);
    expect(plugin._store().toolLoading).toBeUndefined();
  });

  test("already-active tool returns early without side effects", async () => {
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server } = makeServer();
    const result = await activateToolHandler({
      arguments: { name: "search_vault" },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("already active");
    expect(enabled).toHaveLength(0);
    expect(plugin._store().toolLoading).toBeUndefined();
  });

  test("persist=false enables in registry and does NOT write data.json", async () => {
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server, notifications } = makeServer();
    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    expect(enabled).toEqual(["find_broken_links"]);
    expect(plugin._store().toolLoading).toBeUndefined();
    expect(notifications).toContain("notifications/tools/list_changed");
    expect(result.content[0].text).toContain("until the plugin reloads");
  });

  test("persist=true enables in registry AND writes data.json", async () => {
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server } = makeServer();
    const result = await activateToolHandler({
      arguments: { name: "find_broken_links", persist: true },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    expect(enabled).toEqual(["find_broken_links"]);
    const state = plugin._store().toolLoading as { promoted: string[] };
    expect(state.promoted).toContain("find_broken_links");
    expect(result.content[0].text).toContain("survives plugin reloads");
  });

  test("onActivated fires on activation, not on early returns", async () => {
    const plugin = makePlugin();
    const activated: string[] = [];
    const { server } = makeServer();
    const opts = {
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      onActivated: (n: string) => activated.push(n),
    };
    await activateToolHandler({ arguments: { name: "nonexistent" }, ...opts });
    await activateToolHandler({ arguments: { name: "search_vault" }, ...opts });
    expect(activated).toHaveLength(0);
    await activateToolHandler({
      arguments: { name: "find_broken_links" },
      ...opts,
    });
    expect(activated).toEqual(["find_broken_links"]);
  });

  test("uses request-scoped sendNotification when provided, not the raw fallback", async () => {
    const plugin = makePlugin();
    const { server, notifications } = makeServer();
    const scoped: string[] = [];
    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: () => true,
      sendNotification: async (n) => {
        scoped.push(n.method);
      },
    });
    expect(result.isError).toBeUndefined();
    // The scoped sender (relatedRequestId-tagged) is used...
    expect(scoped).toEqual(["notifications/tools/list_changed"]);
    // ...and the raw server.notification fallback is NOT.
    expect(notifications).toHaveLength(0);
  });

  test("notification failure is swallowed and activation still succeeds", async () => {
    const plugin = makePlugin();
    const server = {
      server: {
        notification: async () => {
          throw new Error("stateless transport");
        },
      },
    } as unknown as McpServer;
    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Tool activated");
  });
});
