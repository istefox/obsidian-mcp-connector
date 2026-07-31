import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { activateToolsHandler } from "./activateTools";
import type { ToolScope } from "$/shared/types";
import { SessionPromotions } from "$/features/adaptive-tool-loading/sessionPromotions";
import { resolveToolScope } from "$/features/adaptive-tool-loading/resolveToolScope";
import type { TokenPolicy } from "$/features/adaptive-tool-loading/tokenPolicyStore";

function makeRegistry(
  entries: { name: string; enabled: boolean; userDisabled?: boolean }[],
): Parameters<typeof activateToolsHandler>[0]["registry"] {
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
  { name: "rename_vault_file", enabled: false },
  { name: "delete_vault_file", enabled: false, userDisabled: true },
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

  test("single-name batch on a user-disabled tool reports not_allowed", async () => {
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server, notifications } = makeServer();
    const result = await activateToolsHandler({
      arguments: { names: ["delete_vault_file"], persist: true },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    const out = parse(result);
    expect(out.outcomes).toEqual({ delete_vault_file: "not_allowed" });
    expect(out.activated).toBe(0);
    expect(enabled).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(plugin._store().toolLoading).toBeUndefined();
  });

  test("mixed batch reports the correct outcome per name and enables only the adaptive-inactive one (SPEC success criterion)", async () => {
    const plugin = makePlugin();
    const enabled: string[] = [];
    const { server, notifications } = makeServer();
    const result = await activateToolsHandler({
      arguments: {
        names: [
          "does_not_exist",
          "search_vault",
          "find_broken_links",
          "delete_vault_file",
        ],
      },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: (n) => (enabled.push(n), true),
    });
    const out = parse(result);
    expect(out.outcomes).toEqual({
      does_not_exist: "not_found",
      search_vault: "already_active",
      find_broken_links: "activated",
      delete_vault_file: "not_allowed",
    });
    expect(enabled).toEqual(["find_broken_links"]);
    // Real activation happened alongside a not_allowed name — the
    // single-notification-per-batch behavior must not regress.
    expect(notifications).toEqual(["notifications/tools/list_changed"]);
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

describe("activateToolsHandler — per-token scope (ADR-0014, Task 6)", () => {
  test("activate_tools under scope A promotes only in A; a second scope's resolved active set is unchanged (R-05)", async () => {
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

    const scopeA = scopeFor("A");
    await activateToolsHandler({
      arguments: { names: ["find_broken_links", "rename_vault_file"] },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      scope: scopeA,
      promoteInSession: (tokenId, name) => session.promote(tokenId, name),
    });

    const scopeAAfter = scopeFor("A");
    const scopeBAfter = scopeFor("B");
    expect(scopeAAfter.active.has("find_broken_links")).toBe(true);
    expect(scopeAAfter.active.has("rename_vault_file")).toBe(true);
    expect(scopeBAfter.active.has("find_broken_links")).toBe(false);
    expect(scopeBAfter.active.has("rename_vault_file")).toBe(false);
  });

  test("persist: true writes profiles[A].promoted only, never the mirror, when A is not tokens[0]", async () => {
    const plugin = makeTokenedPlugin();
    const { server } = makeServer();
    const scope: ToolScope = {
      id: "claude",
      active: new Set([
        "find_broken_links",
        "rename_vault_file",
        "tool_catalog",
        "activate_tool",
        "activate_tools",
      ]),
      allowed: null,
    };

    await activateToolsHandler({
      arguments: {
        names: ["find_broken_links", "rename_vault_file"],
        persist: true,
      },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      scope,
      promoteInSession: () => {},
    });

    const toolLoading = plugin._store().toolLoading as {
      promoted: string[];
      profiles: Record<string, { promoted: string[] }>;
    };
    expect(toolLoading.profiles.claude.promoted).toEqual(
      expect.arrayContaining(["find_broken_links", "rename_vault_file"]),
    );
    expect(toolLoading.promoted).not.toContain("find_broken_links");
    expect(toolLoading.promoted).not.toContain("rename_vault_file");
  });

  test("with `allowed` set and a requested tool outside it, the outcome is not_allowed for both the single and the mixed batch (R-06)", async () => {
    const plugin = makeTokenedPlugin();
    const { server } = makeServer();
    const scope: ToolScope = {
      id: "claude",
      active: new Set([
        "search_vault",
        "tool_catalog",
        "activate_tool",
        "activate_tools",
      ]),
      allowed: new Set(["search_vault"]),
    };

    const single = await activateToolsHandler({
      arguments: { names: ["find_broken_links"] },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      scope,
      promoteInSession: () => {},
    });
    expect(parse(single).outcomes).toEqual({
      find_broken_links: "not_allowed",
    });
    expect(parse(single).activated).toBe(0);

    const batch = await activateToolsHandler({
      arguments: { names: ["search_vault", "find_broken_links"] },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      scope,
      promoteInSession: () => {},
    });
    expect(parse(batch).outcomes).toEqual({
      search_vault: "already_active",
      find_broken_links: "not_allowed",
    });
  });

  test("with `allowed: null`, a batch with a scope behaves exactly as the no-scope 0.28.2 path (R-07 regression guard)", async () => {
    const plugin = makeTokenedPlugin();
    const { server } = makeServer();
    const scope: ToolScope = {
      id: "claude",
      active: new Set([
        "find_broken_links",
        "rename_vault_file",
        "tool_catalog",
        "activate_tool",
        "activate_tools",
      ]),
      allowed: null,
    };

    const result = await activateToolsHandler({
      arguments: { names: ["find_broken_links", "rename_vault_file"] },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      scope,
      promoteInSession: () => {},
    });
    expect(parse(result).outcomes).toEqual({
      find_broken_links: "activated",
      rename_vault_file: "activated",
    });
  });

  test("no scope passed ⇒ current global behaviour (unit-test ergonomics; the settings UI path)", async () => {
    // Deliberately omits `scope`: the pre-Task-6 assertions above already
    // lock this in (they call the handler with no scope at all and still
    // pass), so this test only documents the intent explicitly.
    const plugin = makePlugin();
    const { server } = makeServer();
    const result = await activateToolsHandler({
      arguments: { names: ["find_broken_links"] },
      registry: makeRegistry(ENTRIES),
      plugin,
      server,
      enableInRegistry: () => true,
    });
    expect(parse(result).outcomes).toEqual({ find_broken_links: "activated" });
  });
});
