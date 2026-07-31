import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { activateToolHandler } from "./activateTool";
import type { ToolScope } from "$/shared/types";
import { SessionPromotions } from "$/features/adaptive-tool-loading/sessionPromotions";
import { resolveToolScope } from "$/features/adaptive-tool-loading/resolveToolScope";
import type { TokenPolicy } from "$/features/adaptive-tool-loading/tokenPolicyStore";

function makeRegistry(
  entries: { name: string; enabled: boolean; userDisabled?: boolean }[],
): Parameters<typeof activateToolHandler>[0]["registry"] {
  return {
    listAll: () =>
      entries.map((e) => ({
        name: e.name,
        description: `${e.name} description`,
        enabled: e.enabled,
        userDisabled: e.userDisabled ?? false,
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
  { name: "delete_vault_file", enabled: false, userDisabled: true },
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

  test("user-disabled tool returns isError without side effects", async () => {
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server, notifications } = makeServer();
    const result = await activateToolHandler({
      arguments: { name: "delete_vault_file" },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain("disabled");
    expect(enabled).toHaveLength(0);
    expect(plugin._store().toolLoading).toBeUndefined();
    expect(notifications).toHaveLength(0);
  });

  test("user-disabled tool never invokes sendNotification either", async () => {
    const plugin = makePlugin();
    const { server } = makeServer();
    const scoped: string[] = [];
    const result = await activateToolHandler({
      arguments: { name: "delete_vault_file" },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: () => true,
      sendNotification: async (n) => {
        scoped.push(n.method);
      },
    });
    expect(result.isError).toBe(true);
    expect(scoped).toHaveLength(0);
  });

  test("user-disabled AND adaptive-inactive tool still resolves to not-allowed, not activation", async () => {
    // ENTRIES' delete_vault_file fixture already models "both flags set"
    // (enabled: false, userDisabled: true) — confirms the userDisabled
    // check runs before the "activate" branch, not after.
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server } = makeServer();
    const result = await activateToolHandler({
      arguments: { name: "delete_vault_file", persist: true },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    expect(result.isError).toBe(true);
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

/** Plugin pre-seeded with two live tokens, so the mirror (`tokens[0]`,
 * id "default") is distinguishable from a non-first token ("claude"). */
function makeTokenedPlugin() {
  let store: Record<string, unknown> = {
    mcpTransport: {
      bearerToken: "d".repeat(32),
      tokens: [
        {
          id: "default",
          label: "Default",
          token: "d".repeat(32),
          createdAt: 1,
        },
        {
          id: "claude",
          label: "claude.ai",
          token: "c".repeat(32),
          createdAt: 2,
        },
      ],
    },
    toolLoading: {
      profile: "all",
      promoted: [],
      counters: {},
      profiles: {
        default: { profile: "all", promoted: [], allowed: null },
        claude: { profile: "core", promoted: [], allowed: null },
      },
    },
  };
  return {
    loadData: async () => ({ ...store }),
    saveData: async (d: unknown) => {
      store = { ...(d as Record<string, unknown>) };
    },
    _store: () => store,
  };
}

describe("activateToolHandler — per-token scope (ADR-0014, Task 6)", () => {
  test("activate_tool under scope A promotes only in A; a second scope's resolved active set is unchanged (R-05)", async () => {
    const plugin = makeTokenedPlugin();
    const { server } = makeServer();
    const session = new SessionPromotions();
    const policy: TokenPolicy = {
      profile: "core",
      promoted: [],
      allowed: null,
    };
    const allNames = ["search_vault", "find_broken_links", "rename_vault_file"];

    const scopeFor = (tokenId: string): ToolScope =>
      resolveToolScope(tokenId, policy, allNames, session.get(tokenId));

    const scopeABefore = scopeFor("A");
    expect(scopeABefore.active.has("find_broken_links")).toBe(false);

    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry: makeRegistry([{ name: "find_broken_links", enabled: false }]),
      plugin,
      server,
      scope: scopeABefore,
      promoteInSession: (tokenId, name) => session.promote(tokenId, name),
    });
    expect(result.isError).toBeUndefined();

    const scopeAAfter = scopeFor("A");
    const scopeBAfter = scopeFor("B");
    expect(scopeAAfter.active.has("find_broken_links")).toBe(true);
    expect(scopeBAfter.active.has("find_broken_links")).toBe(false);
  });

  test("persist: true writes profiles[A].promoted, never toolLoading.promoted except through the mirror when A is tokens[0]", async () => {
    const plugin = makeTokenedPlugin();
    const { server } = makeServer();
    const scope: ToolScope = {
      id: "claude",
      active: new Set([
        "find_broken_links",
        "tool_catalog",
        "activate_tool",
        "activate_tools",
      ]),
      allowed: null,
    };

    const result = await activateToolHandler({
      arguments: { name: "find_broken_links", persist: true },
      registry: makeRegistry([{ name: "find_broken_links", enabled: false }]),
      plugin,
      server,
      scope,
      promoteInSession: () => {},
    });

    expect(result.isError).toBeUndefined();
    const toolLoading = plugin._store().toolLoading as {
      promoted: string[];
      profiles: Record<string, { promoted: string[] }>;
    };
    // "claude" is not tokens[0] ("default"), so the write must land only
    // in its own policy entry, never in the legacy mirror.
    expect(toolLoading.profiles.claude.promoted).toContain("find_broken_links");
    expect(toolLoading.promoted).not.toContain("find_broken_links");
  });

  test("with `allowed` set and the tool outside it, the outcome is not_allowed with a message naming the token's limit (R-06)", async () => {
    const plugin = makeTokenedPlugin();
    const { server } = makeServer();
    const scope: ToolScope = {
      id: "claude",
      active: new Set(["tool_catalog", "activate_tool", "activate_tools"]),
      allowed: new Set(["search_vault"]),
    };

    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry: makeRegistry([{ name: "find_broken_links", enabled: false }]),
      plugin,
      server,
      scope,
      promoteInSession: () => {},
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text.toLowerCase();
    expect(text).toContain("allowed");
    expect(text).toContain("find_broken_links");
  });

  test("with `allowed: null`, activation with a scope behaves exactly as the no-scope 0.28.2 path (R-07 regression guard)", async () => {
    const plugin = makeTokenedPlugin();
    const { server } = makeServer();
    const scope: ToolScope = {
      id: "claude",
      active: new Set([
        "find_broken_links",
        "tool_catalog",
        "activate_tool",
        "activate_tools",
      ]),
      allowed: null,
    };

    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry: makeRegistry([{ name: "find_broken_links", enabled: false }]),
      plugin,
      server,
      scope,
      promoteInSession: () => {},
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("until the plugin reloads");
  });

  test("no scope passed ⇒ current global behaviour (unit-test ergonomics; the settings UI path)", async () => {
    // Deliberately omits `scope`: the pre-Task-6 assertions in the
    // `activateToolHandler` describe block above already lock this in
    // (they call the handler with no scope argument at all and still
    // pass), so this test only documents the intent explicitly rather
    // than re-asserting duplicate behaviour.
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server } = makeServer();
    const result = await activateToolHandler({
      arguments: { name: "find_broken_links" },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    expect(result.isError).toBeUndefined();
    expect(enabled).toEqual(["find_broken_links"]);
  });
});
