import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POLICY,
  readPolicy,
  updateToolLoading,
} from "./tokenPolicyStore";
import { ToolLoadingManager } from "./toolLoadingManager";
import { PROMOTION_THRESHOLD } from "./constants";

/**
 * Follows the plain in-memory `PluginDataLike` double used throughout
 * this feature's tests (toolLoadingManager.test.ts).
 */
function makePlugin(data: Record<string, unknown> = {}) {
  let store: Record<string, unknown> = { ...data };
  return {
    loadData: async () => ({ ...store }),
    saveData: async (d: unknown) => {
      store = { ...(d as Record<string, unknown>) };
    },
    _store: () => store,
  };
}

const TWO_TOKEN_FIXTURE = {
  mcpTransport: {
    bearerToken: "a".repeat(43),
    tokens: [
      { id: "default", label: "Default", token: "a".repeat(43), createdAt: 1 },
      { id: "claude", label: "claude.ai", token: "b".repeat(43), createdAt: 2 },
    ],
  },
};

describe("readPolicy", () => {
  test("returns DEFAULT_POLICY for a token with no profiles entry (R-14)", async () => {
    const plugin = makePlugin({
      ...TWO_TOKEN_FIXTURE,
      toolLoading: { profile: "all", promoted: [], counters: {}, profiles: {} },
    });

    const policy = await readPolicy(plugin, "claude");

    expect(policy).toEqual(DEFAULT_POLICY);
  });

  test("returns DEFAULT_POLICY when the toolLoading slice is missing entirely (R-14)", async () => {
    const plugin = makePlugin({ ...TWO_TOKEN_FIXTURE });

    const policy = await readPolicy(plugin, "default");

    expect(policy).toEqual(DEFAULT_POLICY);
  });
});

describe("updateToolLoading", () => {
  /**
   * The mirror must be derived from the same snapshot the recipe writes
   * from. A second, earlier read would sit outside the non-re-entrant
   * settings mutex and could be overtaken by a revoke, making the recipe
   * compute the mirror from an already-pruned entry and clobber a
   * correct one. Counting reads is what pins that structurally: one read
   * means there is no pre-read to go stale.
   */
  test("derives the mirror from the write's own snapshot, not a read taken before the mutex", async () => {
    let loads = 0;
    let store: Record<string, unknown> = {
      ...TWO_TOKEN_FIXTURE,
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          default: { profile: "core", promoted: ["x"], allowed: null },
        },
      },
    };
    const plugin = {
      loadData: async () => {
        loads += 1;
        return { ...store };
      },
      saveData: async (d: unknown) => {
        store = { ...(d as Record<string, unknown>) };
      },
    };

    await updateToolLoading(plugin, (state) => state);

    expect(loads).toBe(1);
    const toolLoading = store.toolLoading as {
      profile: string;
      promoted: string[];
    };
    expect(toolLoading.profile).toBe("core");
    expect(toolLoading.promoted).toEqual(["x"]);
  });

  /**
   * The behavioural half of the test above: `loads === 1` pins how
   * `updateSlice` is implemented, this pins the invariant. `loadData`
   * serves a pre-revoke snapshot once and the post-revoke world after,
   * so a `mirrorId` taken before the mutex names `default` — already
   * revoked and already pruned — and the mirror comes out wrong.
   */
  test("uses the post-revoke snapshot when an earlier read would have seen the pre-revoke one", async () => {
    const PRE = {
      mcpTransport: {
        tokens: [
          { id: "default", label: "Default", token: "a".repeat(43) },
          { id: "claude", label: "claude.ai", token: "b".repeat(43) },
        ],
      },
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          default: { profile: "all", promoted: [], allowed: null },
          claude: { profile: "core", promoted: ["x"], allowed: null },
        },
      },
    };
    const POST = {
      mcpTransport: {
        tokens: [{ id: "claude", label: "claude.ai", token: "b".repeat(43) }],
      },
      toolLoading: {
        profile: "core",
        promoted: ["x"],
        counters: {},
        profiles: {
          claude: { profile: "core", promoted: ["x"], allowed: null },
        },
      },
    };
    let loads = 0;
    let store: Record<string, unknown> = POST;
    const plugin = {
      loadData: async () => {
        loads += 1;
        return loads === 1 ? { ...PRE } : { ...store };
      },
      saveData: async (d: unknown) => {
        store = { ...(d as Record<string, unknown>) };
      },
    };

    await updateToolLoading(plugin, (state) => state);

    const toolLoading = store.toolLoading as {
      profile: string;
      promoted: string[];
    };
    // A stale mirrorId would resolve `default`, find it pruned, and fall
    // back to the default policy — writing all/[] over claude's core.
    expect(toolLoading.profile).toBe("core");
    expect(toolLoading.promoted).toEqual(["x"]);
  });

  test("rewrites profile/promoted from profiles[tokens[0].id] after mutating the first token's policy (R-12)", async () => {
    const plugin = makePlugin({
      ...TWO_TOKEN_FIXTURE,
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          default: { profile: "all", promoted: [], allowed: null },
          claude: { profile: "core", promoted: [], allowed: null },
        },
      },
    });

    await updateToolLoading(plugin, (state) => {
      state.profiles.default = {
        profile: "core",
        promoted: ["get_active_file"],
        allowed: null,
      };
      return state;
    });

    const toolLoading = plugin._store().toolLoading as {
      profile: string;
      promoted: string[];
    };
    expect(toolLoading.profile).toBe("core");
    expect(toolLoading.promoted).toEqual(["get_active_file"]);
  });

  test("leaves profile/promoted alone when a non-first token is mutated (R-12)", async () => {
    const plugin = makePlugin({
      ...TWO_TOKEN_FIXTURE,
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          default: { profile: "all", promoted: [], allowed: null },
          claude: { profile: "core", promoted: [], allowed: null },
        },
      },
    });

    await updateToolLoading(plugin, (state) => {
      state.profiles.claude = {
        profile: "adaptive",
        promoted: ["search_vault"],
        allowed: null,
      };
      return state;
    });

    const toolLoading = plugin._store().toolLoading as {
      profile: string;
      promoted: string[];
    };
    expect(toolLoading.profile).toBe("all");
    expect(toolLoading.promoted).toEqual([]);
  });

  test("prunes profiles entries whose id is not in the live token list", async () => {
    const plugin = makePlugin({
      mcpTransport: {
        bearerToken: "a".repeat(43),
        tokens: [
          {
            id: "default",
            label: "Default",
            token: "a".repeat(43),
            createdAt: 1,
          },
        ],
      },
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          default: { profile: "all", promoted: [], allowed: null },
          orphan: { profile: "core", promoted: [], allowed: null },
        },
      },
    });

    await updateToolLoading(plugin, (state) => state);

    const toolLoading = plugin._store().toolLoading as {
      profiles: Record<string, unknown>;
    };
    expect(toolLoading.profiles.orphan).toBeUndefined();
    expect(toolLoading.profiles.default).toBeDefined();
  });
});

describe("flushPendingCalls fans auto-promotion out per adaptive token (R-10)", () => {
  test("two adaptive profiles entries promote independently in one write; counters stay global", async () => {
    const plugin = makePlugin({
      ...TWO_TOKEN_FIXTURE,
      toolLoading: {
        profile: "adaptive",
        promoted: [],
        counters: {},
        profiles: {
          default: { profile: "adaptive", promoted: [], allowed: null },
          claude: { profile: "adaptive", promoted: [], allowed: null },
        },
      },
    });
    let saves = 0;
    const counting = {
      loadData: plugin.loadData,
      saveData: async (d: unknown) => {
        saves += 1;
        await plugin.saveData(d);
      },
    };
    const mgr = new ToolLoadingManager({ flushDelayMs: 60_000 });

    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      await mgr.recordCall("search_and_replace", counting);
    }
    await mgr.flushPendingCalls(counting);
    expect(saves).toBe(1);

    const defaultPolicy = await readPolicy(plugin, "default");
    const claudePolicy = await readPolicy(plugin, "claude");
    expect(defaultPolicy.promoted).toContain("search_and_replace");
    expect(claudePolicy.promoted).toContain("search_and_replace");

    const toolLoading = plugin._store().toolLoading as {
      counters: Record<string, number>;
    };
    expect(toolLoading.counters["search_and_replace"]).toBe(
      PROMOTION_THRESHOLD,
    );
  });

  test("a token whose profile is 'all' gets no promotion", async () => {
    const plugin = makePlugin({
      mcpTransport: {
        bearerToken: "a".repeat(43),
        tokens: [
          {
            id: "default",
            label: "Default",
            token: "a".repeat(43),
            createdAt: 1,
          },
        ],
      },
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: { default: { profile: "all", promoted: [], allowed: null } },
      },
    });
    const mgr = new ToolLoadingManager({ flushDelayMs: 0 });

    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      await mgr.recordCall("search_and_replace", plugin);
    }

    const policy = await readPolicy(plugin, "default");
    expect(policy.promoted).not.toContain("search_and_replace");
  });
});
