/**
 * Issue #669: explicit activate_tool / activate_tools must also publish
 * through the modern-era fan-out (`notifyToolsChanged`), because a
 * conformant 2026-07-28 client only hears `list_changed` on a
 * `subscriptions/listen` stream it opened, never on the caller's POST stream.
 */
import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { activateToolHandler } from "./activateTool";
import { activateToolsHandler } from "./activateTools";
import { SessionPromotions } from "$/features/adaptive-tool-loading/sessionPromotions";
import { resolveToolScope } from "$/features/adaptive-tool-loading/resolveToolScope";
import type { TokenPolicy } from "$/features/adaptive-tool-loading/tokenPolicyStore";

const ENTRIES = [
  { name: "search_vault", enabled: true, userDisabled: false },
  { name: "find_broken_links", enabled: false, userDisabled: false },
  { name: "rename_vault_file", enabled: false, userDisabled: false },
  { name: "delete_vault_file", enabled: false, userDisabled: true },
];

const registry = {
  listAll: () =>
    ENTRIES.map((e) => ({ ...e, description: `${e.name} description` })),
};

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

describe("activate_tool modern-era fan-out (#669)", () => {
  test("a successful activation publishes once and still sends on the POST stream", async () => {
    const { server } = makeServer();
    const posted: string[] = [];
    let fanouts = 0;
    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry,
      plugin: makePlugin(),
      server,
      enableInRegistry: () => true,
      sendNotification: async (n) => {
        posted.push(n.method);
      },
      notifyToolsChanged: () => {
        fanouts++;
      },
    });
    expect(result.isError).toBeUndefined();
    expect(fanouts).toBe(1);
    expect(posted).toEqual(["notifications/tools/list_changed"]);
  });

  test("persist: true fans out only after the promotion is written", async () => {
    const plugin = makePlugin();
    const { server } = makeServer();
    let storedAtFanout: unknown;
    await activateToolHandler({
      arguments: { name: "find_broken_links", persist: true },
      registry,
      plugin,
      server,
      enableInRegistry: () => true,
      notifyToolsChanged: () => {
        storedAtFanout = plugin._store().toolLoading;
      },
    });
    expect(storedAtFanout).toBeDefined();
  });

  test("a scoped in-memory activation fans out", async () => {
    const { server } = makeServer();
    const session = new SessionPromotions();
    const policy: TokenPolicy = {
      profile: "core",
      promoted: [],
      allowed: null,
    };
    const scope = resolveToolScope(
      "tok-a",
      policy,
      ENTRIES.map((e) => e.name),
      session.get("tok-a"),
    );
    let fanouts = 0;
    await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry,
      plugin: makePlugin(),
      server,
      promoteInSession: (id, n) => session.promote(id, n),
      scope,
      notifyToolsChanged: () => {
        fanouts++;
      },
    });
    expect(fanouts).toBe(1);
  });

  test.each([
    ["unknown tool", "nonexistent"],
    ["already active", "search_vault"],
    ["user-disabled", "delete_vault_file"],
  ])("no fan-out when the set did not change (%s)", async (_label, name) => {
    const { server } = makeServer();
    let fanouts = 0;
    await activateToolHandler({
      arguments: { name },
      registry,
      plugin: makePlugin(),
      server,
      enableInRegistry: () => true,
      notifyToolsChanged: () => {
        fanouts++;
      },
    });
    expect(fanouts).toBe(0);
  });

  test("a throwing fan-out does not fail the activation", async () => {
    const { server } = makeServer();
    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry,
      plugin: makePlugin(),
      server,
      enableInRegistry: () => true,
      notifyToolsChanged: () => {
        throw new Error("bus closed");
      },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("activated");
  });

  test("legacy callers (no notifyToolsChanged) behave exactly as before", async () => {
    const { server, notifications } = makeServer();
    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry,
      plugin: makePlugin(),
      server,
      enableInRegistry: () => true,
    });
    expect(result.isError).toBeUndefined();
    expect(notifications).toEqual(["notifications/tools/list_changed"]);
  });
});

describe("activate_tools modern-era fan-out (#669)", () => {
  test("a batch that activates something publishes once and sends once on the POST stream", async () => {
    const { server } = makeServer();
    const posted: string[] = [];
    let fanouts = 0;
    await activateToolsHandler({
      arguments: { names: ["find_broken_links", "rename_vault_file"] },
      registry,
      plugin: makePlugin(),
      server,
      enableInRegistry: () => true,
      sendNotification: async (n) => {
        posted.push(n.method);
      },
      notifyToolsChanged: () => {
        fanouts++;
      },
    });
    expect(fanouts).toBe(1);
    expect(posted).toEqual(["notifications/tools/list_changed"]);
  });

  test("persist: true fans out only after the promotions are written", async () => {
    const plugin = makePlugin();
    const { server } = makeServer();
    let storedAtFanout: unknown;
    await activateToolsHandler({
      arguments: { names: ["find_broken_links"], persist: true },
      registry,
      plugin,
      server,
      enableInRegistry: () => true,
      notifyToolsChanged: () => {
        storedAtFanout = plugin._store().toolLoading;
      },
    });
    expect(storedAtFanout).toBeDefined();
  });

  test("no fan-out when nothing changed", async () => {
    const { server } = makeServer();
    let fanouts = 0;
    await activateToolsHandler({
      arguments: {
        names: ["search_vault", "nonexistent", "delete_vault_file"],
      },
      registry,
      plugin: makePlugin(),
      server,
      enableInRegistry: () => true,
      notifyToolsChanged: () => {
        fanouts++;
      },
    });
    expect(fanouts).toBe(0);
  });

  test("a throwing fan-out does not fail the batch", async () => {
    const { server } = makeServer();
    const result = await activateToolsHandler({
      arguments: { names: ["find_broken_links"] },
      registry,
      plugin: makePlugin(),
      server,
      enableInRegistry: () => true,
      notifyToolsChanged: () => {
        throw new Error("bus closed");
      },
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).activated).toBe(1);
  });

  test("legacy callers (no notifyToolsChanged) behave exactly as before", async () => {
    const { server, notifications } = makeServer();
    await activateToolsHandler({
      arguments: { names: ["find_broken_links"] },
      registry,
      plugin: makePlugin(),
      server,
      enableInRegistry: () => true,
    });
    expect(notifications).toEqual(["notifications/tools/list_changed"]);
  });
});
