import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { activateToolsHandler } from "./activateTools";

function makeRegistry(
  entries: { name: string; enabled: boolean }[],
): Parameters<typeof activateToolsHandler>[0]["registry"] {
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
  { name: "rename_vault_file", enabled: false },
];

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as {
    requested: number;
    activated: number;
    outcomes: Record<string, string>;
    persisted?: boolean;
  };
}

describe("activateToolsHandler", () => {
  test("activates several inactive tools with a SINGLE notification", async () => {
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server, notifications } = makeServer();
    const result = await activateToolsHandler({
      arguments: { names: ["find_broken_links", "rename_vault_file"] },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    const out = parse(result);
    expect(out.activated).toBe(2);
    expect(out.outcomes).toEqual({
      find_broken_links: "activated",
      rename_vault_file: "activated",
    });
    expect(enabled).toEqual(["find_broken_links", "rename_vault_file"]);
    // Exactly one list_changed for the whole batch.
    expect(notifications).toEqual(["notifications/tools/list_changed"]);
  });

  test("reports already_active and not_found per name", async () => {
    const plugin = makePlugin();
    const { server } = makeServer();
    const result = await activateToolsHandler({
      arguments: {
        names: ["search_vault", "find_broken_links", "does_not_exist"],
      },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: () => true,
    });
    const out = parse(result);
    expect(out.outcomes).toEqual({
      search_vault: "already_active",
      find_broken_links: "activated",
      does_not_exist: "not_found",
    });
    expect(out.activated).toBe(1);
  });

  test("no-op batch fires no notification and writes nothing", async () => {
    const plugin = makePlugin();
    const { server, notifications } = makeServer();
    const result = await activateToolsHandler({
      arguments: { names: ["search_vault"], persist: true },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: () => true,
    });
    expect(parse(result).activated).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(plugin._store().toolLoading).toBeUndefined();
  });

  test("persist=true writes all newly-activated names in one slice", async () => {
    const plugin = makePlugin();
    const { server } = makeServer();
    await activateToolsHandler({
      arguments: {
        names: ["find_broken_links", "rename_vault_file"],
        persist: true,
      },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: () => true,
    });
    const state = plugin._store().toolLoading as { promoted: string[] };
    expect(state.promoted).toEqual(["find_broken_links", "rename_vault_file"]);
  });

  test("uses request-scoped sendNotification once, not the raw fallback", async () => {
    const plugin = makePlugin();
    const { server, notifications } = makeServer();
    const scoped: string[] = [];
    await activateToolsHandler({
      arguments: { names: ["find_broken_links", "rename_vault_file"] },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: () => true,
      sendNotification: async (n) => {
        scoped.push(n.method);
      },
    });
    expect(scoped).toEqual(["notifications/tools/list_changed"]);
    expect(notifications).toHaveLength(0);
  });

  test("dedupes repeated names in the input", async () => {
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server } = makeServer();
    const result = await activateToolsHandler({
      arguments: {
        names: ["find_broken_links", "find_broken_links"],
      },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    expect(parse(result).activated).toBe(1);
    expect(enabled).toEqual(["find_broken_links"]);
  });
});
