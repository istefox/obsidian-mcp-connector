import { describe, expect, spyOn, test } from "bun:test";
import { mockPlugin } from "$/test-setup";
import type McpToolsPlugin from "$/main";
import { logger } from "$/shared/logger";
import {
  ensureTokenStore,
  readTokens,
  regenerateToken,
  revokeToken,
  type TokenRecord,
} from "./tokenStore";

/**
 * `ensureTokenStore` is a plain function over `PluginDataLike` (ADR-0014
 * §6), so it is exercised here against the same in-memory `data.json`
 * double `setup.test.ts` uses, plus a save counter so idempotency (R-13)
 * can be asserted on write COUNT, not just on the resulting value.
 */
function makePlugin(initialData: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...initialData };
  let saves = 0;
  const plugin = mockPlugin({
    loadData: async () => data,
    saveData: async (next: unknown) => {
      saves += 1;
      data = next as Record<string, unknown>;
    },
  } as Partial<McpToolsPlugin>);
  return { plugin, getData: () => data, saveCount: () => saves };
}

describe("ensureTokenStore — migration from a 0.28.2 vault", () => {
  test("bearer token string survives byte-for-byte into tokens[0] (R-11, R-21)", async () => {
    const TOKEN = "a".repeat(43);
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: TOKEN, livePort: 27200 },
      toolLoading: {
        profile: "core",
        promoted: ["x"],
        counters: { y: 2 },
      },
    });

    await ensureTokenStore(plugin);

    const mcpTransport = getData().mcpTransport as {
      bearerToken: string;
      tokens: TokenRecord[];
    };
    expect(mcpTransport.tokens).toHaveLength(1);
    const [token] = mcpTransport.tokens;
    expect(token.id).toBe("default");
    expect(token.label).toBe("Default");
    expect(token.token).toBe(TOKEN);
    expect(typeof token.createdAt).toBe("number");
  });

  test("copies the global profile/promoted into profiles.default; counters untouched (R-11)", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: "a".repeat(43) },
      toolLoading: {
        profile: "core",
        promoted: ["x"],
        counters: { y: 2 },
      },
    });

    await ensureTokenStore(plugin);

    const toolLoading = getData().toolLoading as {
      counters: Record<string, number>;
      profiles: Record<
        string,
        { profile: string; promoted: string[]; allowed: string[] | null }
      >;
    };
    expect(toolLoading.profiles.default).toEqual({
      profile: "core",
      promoted: ["x"],
      allowed: null,
    });
    expect(toolLoading.counters).toEqual({ y: 2 });
  });

  test("bearerToken/profile/promoted still mirror the default token afterwards (R-12)", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: "a".repeat(43) },
      toolLoading: { profile: "core", promoted: ["x"], counters: {} },
    });

    await ensureTokenStore(plugin);

    const data = getData();
    const mcpTransport = data.mcpTransport as {
      bearerToken: string;
      tokens: TokenRecord[];
    };
    const toolLoading = data.toolLoading as {
      profile: string;
      promoted: string[];
    };
    expect(mcpTransport.bearerToken).toBe(mcpTransport.tokens[0].token);
    expect(toolLoading.profile).toBe("core");
    expect(toolLoading.promoted).toEqual(["x"]);
  });

  test("running ensureTokenStore twice writes nothing the second time (R-13)", async () => {
    const { plugin, saveCount } = makePlugin({
      mcpTransport: { bearerToken: "a".repeat(43) },
      toolLoading: { profile: "core", promoted: ["x"], counters: {} },
    });

    await ensureTokenStore(plugin);
    const firstRunSaves = saveCount();
    expect(firstRunSaves).toBeGreaterThan(0);

    await ensureTokenStore(plugin);
    expect(saveCount()).toBe(firstRunSaves);
  });
});

describe("ensureTokenStore — fresh and malformed vaults", () => {
  test("a fresh vault mints one token >= 32 bytes and writes both slices", async () => {
    const { plugin, getData } = makePlugin({});

    await ensureTokenStore(plugin);

    const data = getData();
    const mcpTransport = data.mcpTransport as {
      bearerToken: string;
      tokens: TokenRecord[];
    };
    const toolLoading = data.toolLoading as {
      profiles: Record<string, unknown>;
    };
    expect(mcpTransport.tokens).toHaveLength(1);
    expect(
      Buffer.byteLength(mcpTransport.tokens[0].token, "utf8"),
    ).toBeGreaterThanOrEqual(32);
    expect(mcpTransport.bearerToken).toBe(mcpTransport.tokens[0].token);
    expect(toolLoading.profiles[mcpTransport.tokens[0].id]).toBeDefined();
  });

  test("tokens: [] is treated as absent and re-minted, never left unauthenticable", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: "a".repeat(43), tokens: [] },
    });

    await ensureTokenStore(plugin);

    const mcpTransport = getData().mcpTransport as { tokens: TokenRecord[] };
    expect(mcpTransport.tokens.length).toBeGreaterThan(0);
  });

  test("a bearerToken shorter than 32 bytes is treated as absent and re-minted", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: "short" },
    });

    await ensureTokenStore(plugin);

    const mcpTransport = getData().mcpTransport as {
      bearerToken: string;
      tokens: TokenRecord[];
    };
    expect(mcpTransport.tokens[0].token).not.toBe("short");
    expect(
      Buffer.byteLength(mcpTransport.tokens[0].token, "utf8"),
    ).toBeGreaterThanOrEqual(32);
  });

  test("a desynced bearerToken (!= tokens[0].token) is repaired to tokens[0].token", async () => {
    const REAL = "b".repeat(43);
    const { plugin, getData } = makePlugin({
      mcpTransport: {
        bearerToken: "stale-value-that-does-not-match-tokens0",
        tokens: [
          { id: "default", label: "Default", token: REAL, createdAt: 1 },
        ],
      },
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: { default: { profile: "all", promoted: [], allowed: null } },
      },
    });

    await ensureTokenStore(plugin);

    const mcpTransport = getData().mcpTransport as { bearerToken: string };
    expect(mcpTransport.bearerToken).toBe(REAL);
  });
});

describe("ensureTokenStore — real-vault migration check (R-21)", () => {
  /**
   * A faithful, redacted reconstruction of a real pre-upgrade 0.28.2
   * `data.json` (Task 9 sub-step 1). Built from the pre-branch settings
   * shapes rather than any live vault: `mcpTransport.{bearerToken,
   * livePort,serverName}` from `services/setup.ts` (the `mcpTransportSlice`
   * read at L71-73 plus the `livePort` write at L121-122 on the pre-branch
   * tree); `toolLoading.{profile,promoted,counters}` from
   * `adaptive-tool-loading/types.ts`'s `McpToolsPluginSettings`
   * augmentation on the pre-branch tree; `commandPermissions`,
   * `semanticSearch` and `mcpTools` from their respective feature
   * `types.ts` augmentations (all present on `main` at the 0.28.2 tag,
   * fc81d6f); `version` from the root `types.ts` augmentation. The token
   * string below is an obviously-fake 43-char base64url-shaped filler
   * (`"a".repeat(43)`, matching the byte-length convention already used
   * elsewhere in this file), not a real secret.
   */
  const REAL_TOKEN = "a".repeat(43);
  function makeRealisticFixture() {
    return {
      version: "0.28.2",
      mcpTransport: {
        bearerToken: REAL_TOKEN,
        livePort: 27201,
        serverName: "Obsidian - Research Vault",
      },
      toolLoading: {
        profile: "core",
        promoted: ["get_vault_file", "search_vault", "list_directory"],
        counters: {
          get_vault_file: 42,
          search_vault: 17,
          list_directory: 5,
          create_vault_file: 1,
        },
      },
      commandPermissions: {
        enabled: true,
        allowlist: ["workspace:split-vertical", "editor:save-file"],
        recentInvocations: [
          {
            commandId: "editor:save-file",
            outcome: "allow",
            timestamp: 1753900000000,
          },
          {
            commandId: "workspace:split-vertical",
            outcome: "deny",
            timestamp: 1753900060000,
          },
        ],
      },
      semanticSearch: {
        provider: "native",
        indexingMode: "low-power",
        unloadModelWhenIdle: true,
      },
      mcpTools: {
        maxTextOutputKB: 250,
      },
    };
  }

  test("migrates a full, messy 0.28.2 vault: token unchanged, policy carried over and mirrored, every unrelated slice and counters untouched", async () => {
    const fixture = makeRealisticFixture();
    const { plugin, getData } = makePlugin(fixture);

    const tokens = await ensureTokenStore(plugin);

    const data = getData();
    const mcpTransport = data.mcpTransport as {
      bearerToken: string;
      tokens: TokenRecord[];
      livePort: number;
      serverName: string;
    };
    const toolLoading = data.toolLoading as {
      profile: string;
      promoted: string[];
      counters: Record<string, number>;
      profiles: Record<
        string,
        { profile: string; promoted: string[]; allowed: string[] | null }
      >;
    };

    // Bearer token: unchanged byte-for-byte (R-21).
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe(REAL_TOKEN);
    expect(mcpTransport.tokens[0].token).toBe(REAL_TOKEN);

    // Pre-existing profile and promoted list carried into
    // profiles[tokens[0].id] (R-21).
    expect(toolLoading.profiles[tokens[0].id]).toEqual({
      profile: "core",
      promoted: ["get_vault_file", "search_vault", "list_directory"],
      allowed: null,
    });

    // Legacy mirror keys still hold the same values afterwards (R-21).
    expect(mcpTransport.bearerToken).toBe(REAL_TOKEN);
    expect(toolLoading.profile).toBe("core");
    expect(toolLoading.promoted).toEqual([
      "get_vault_file",
      "search_vault",
      "list_directory",
    ]);

    // Counters preserved exactly (R-21).
    expect(toolLoading.counters).toEqual(fixture.toolLoading.counters);

    // Every unrelated slice untouched byte-for-byte (R-21): this is the
    // assertion the minimal-fixture tests above cannot make.
    expect(data.version).toBe(fixture.version);
    expect(mcpTransport.livePort).toBe(fixture.mcpTransport.livePort);
    expect(mcpTransport.serverName).toBe(fixture.mcpTransport.serverName);
    expect(data.commandPermissions).toEqual(fixture.commandPermissions);
    expect(data.semanticSearch).toEqual(fixture.semanticSearch);
    expect(data.mcpTools).toEqual(fixture.mcpTools);
  });
});

describe("readTokens", () => {
  test("returns the live token list written by ensureTokenStore", async () => {
    const { plugin } = makePlugin({});
    const minted = await ensureTokenStore(plugin);

    const read = await readTokens(plugin);

    expect(read).toEqual(minted);
  });
});

describe("regenerateToken", () => {
  test("keeps id/label/createdAt/profiles entry, changes only the secret, updates the mirror (R-18)", async () => {
    const { plugin, getData } = makePlugin({});
    const [initial] = await ensureTokenStore(plugin);

    const updated = await regenerateToken(plugin, initial.id);

    expect(updated.id).toBe(initial.id);
    expect(updated.label).toBe(initial.label);
    expect(updated.createdAt).toBe(initial.createdAt);
    expect(updated.token).not.toBe(initial.token);

    const data = getData();
    const mcpTransport = data.mcpTransport as {
      bearerToken: string;
      tokens: TokenRecord[];
    };
    const toolLoading = data.toolLoading as {
      profiles: Record<string, unknown>;
    };
    expect(mcpTransport.tokens[0].token).toBe(updated.token);
    expect(mcpTransport.bearerToken).toBe(updated.token);
    expect(toolLoading.profiles[initial.id]).toBeDefined();
  });
});

describe("ensureTokenStore — malformed policy entries", () => {
  /**
   * `ensureTokenStore` is the first statement of `setup()`, so anything
   * that throws here means the MCP server never binds and the user has
   * no in-app way back. A hand-edited `data.json` must degrade, never
   * crash.
   */
  test("survives a profiles entry whose promoted is not an array", async () => {
    const { plugin, getData } = makePlugin({
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
        profile: "core",
        promoted: [],
        counters: {},
        profiles: { default: { profile: "core", promoted: "abc" } },
      },
    });

    await ensureTokenStore(plugin);

    const toolLoading = getData().toolLoading as {
      promoted: string[];
      profiles: Record<string, unknown>;
    };
    // "abc" must not be spread into ["a","b","c"], nor throw.
    expect(toolLoading.promoted).toEqual([]);
    expect(toolLoading.profiles.default).toEqual({
      profile: "core",
      promoted: [],
      allowed: null,
    });
  });
});

describe("ensureTokenStore — re-mint over an emptied tokens[]", () => {
  /**
   * `MIGRATED_TOKEN_ID` is the literal "default", so a re-mint reuses an
   * id that a previous token owned — violating `TokenRecord.id`'s
   * "never reused" contract for this one entry. A surviving
   * `profiles["default"]` may therefore belong to a token that is gone.
   * The globals track `tokens[0]`, whose secret the mint reuses, so they
   * win and the stale per-id entry is overwritten.
   */
  test("does not adopt a surviving policy entry for the reused id", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: "a".repeat(43), tokens: [] },
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          default: { profile: "core", promoted: ["x"], allowed: null },
        },
      },
    });

    await ensureTokenStore(plugin);

    const toolLoading = getData().toolLoading as {
      profiles: Record<string, unknown>;
    };
    expect(toolLoading.profiles.default).toEqual({
      profile: "all",
      promoted: [],
      allowed: null,
    });
  });

  test("still seeds a genuine 0.28.2 upgrade from the globals", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: "a".repeat(43) },
      toolLoading: { profile: "core", promoted: ["x"], counters: {} },
    });

    await ensureTokenStore(plugin);

    const toolLoading = getData().toolLoading as {
      profiles: Record<string, unknown>;
    };
    expect(toolLoading.profiles.default).toEqual({
      profile: "core",
      promoted: ["x"],
      allowed: null,
    });
  });
});

describe("revokeToken", () => {
  test("refuses to revoke the last remaining token", async () => {
    const { plugin } = makePlugin({
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

    await expect(revokeToken(plugin, "default")).rejects.toThrow();
  });

  test("removes the entry and re-points the mirror at the new tokens[0]", async () => {
    const SECOND_TOKEN = "b".repeat(43);
    const { plugin, getData } = makePlugin({
      mcpTransport: {
        bearerToken: "a".repeat(43),
        tokens: [
          {
            id: "default",
            label: "Default",
            token: "a".repeat(43),
            createdAt: 1,
          },
          {
            id: "claude",
            label: "claude.ai",
            token: SECOND_TOKEN,
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
          // Distinct from `default`'s, so the mirror assertions below
          // can tell "took claude's policy" from "reset to the default".
          claude: { profile: "core", promoted: ["y"], allowed: null },
        },
      },
    });

    await revokeToken(plugin, "default");

    const data = getData();
    const mcpTransport = data.mcpTransport as {
      bearerToken: string;
      tokens: TokenRecord[];
    };
    expect(mcpTransport.tokens.map((t) => t.id)).toEqual(["claude"]);
    expect(mcpTransport.bearerToken).toBe(SECOND_TOKEN);

    // The name of this test promises the mirror; assert it. Without
    // these three lines the whole mirror invariant is untested.
    const toolLoading = data.toolLoading as {
      profile: string;
      promoted: string[];
      profiles: Record<string, unknown>;
    };
    expect(toolLoading.profile).toBe("core");
    expect(toolLoading.promoted).toEqual(["y"]);
    expect(Object.keys(toolLoading.profiles)).toEqual(["claude"]);
  });

  /**
   * The survivor with NO policy entry is the ordinary case: a token
   * minted by "Add token" has none until someone edits its policy. The
   * mirror must fall back to the default policy, not keep the revoked
   * token's — see the round-trip test below for why that matters.
   */
  test("re-points the mirror at the default policy when the new tokens[0] has no entry", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: {
        bearerToken: "a".repeat(43),
        tokens: [
          {
            id: "default",
            label: "Default",
            token: "a".repeat(43),
            createdAt: 1,
          },
          {
            id: "claude",
            label: "claude.ai",
            token: "b".repeat(43),
            createdAt: 2,
          },
        ],
      },
      toolLoading: {
        profile: "core",
        promoted: ["x"],
        counters: {},
        profiles: {
          default: { profile: "core", promoted: ["x"], allowed: null },
        },
      },
    });

    await revokeToken(plugin, "default");

    const toolLoading = getData().toolLoading as {
      profile: string;
      promoted: string[];
      profiles?: Record<string, unknown>;
    };
    // Whether an empty map is written as `{}` or dropped is `toSlice`'s
    // contract and `tokenPolicyStore.test.ts` owns it; here all that
    // matters is that the orphan is gone.
    expect(toolLoading.profiles ?? {}).toEqual({});
    expect(toolLoading.profile).toBe("all");
    expect(toolLoading.promoted).toEqual([]);
  });

  test("a failed policy sweep does not report the revoke as failed", async () => {
    let data: Record<string, unknown> = {
      mcpTransport: {
        bearerToken: "a".repeat(43),
        tokens: [
          {
            id: "default",
            label: "Default",
            token: "a".repeat(43),
            createdAt: 1,
          },
          {
            id: "claude",
            label: "claude.ai",
            token: "b".repeat(43),
            createdAt: 2,
          },
        ],
      },
      toolLoading: {
        profile: "core",
        promoted: ["x"],
        counters: {},
        profiles: {
          default: { profile: "core", promoted: ["x"], allowed: null },
        },
      },
    };
    let saves = 0;
    const plugin = mockPlugin({
      loadData: async () => data,
      saveData: async (next: unknown) => {
        saves += 1;
        // The credential write lands; the policy sweep behind it does not.
        if (saves > 1) throw new Error("disk full");
        data = next as Record<string, unknown>;
      },
    } as Partial<McpToolsPlugin>);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      const remaining = await revokeToken(plugin, "default");

      // Assert the sweep was ATTEMPTED and its failure REPORTED, not
      // just that nothing threw: with the sweep deleted outright this
      // test still passed on `resolves` + post-state alone.
      expect(saves).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(remaining.map((t) => t.id)).toEqual(["claude"]);

      const mcpTransport = data.mcpTransport as { tokens: TokenRecord[] };
      expect(mcpTransport.tokens.map((t) => t.id)).toEqual(["claude"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a lost policy sweep does not let the survivor inherit on the next load", async () => {
    let data: Record<string, unknown> = {
      mcpTransport: {
        bearerToken: "a".repeat(43),
        tokens: [
          {
            id: "default",
            label: "Default",
            token: "a".repeat(43),
            createdAt: 1,
          },
          {
            id: "claude",
            label: "claude.ai",
            token: "b".repeat(43),
            createdAt: 2,
          },
        ],
      },
      toolLoading: {
        profile: "core",
        promoted: ["x"],
        counters: {},
        profiles: {
          default: { profile: "core", promoted: ["x"], allowed: null },
        },
      },
    };
    let saves = 0;
    const plugin = mockPlugin({
      loadData: async () => data,
      saveData: async (next: unknown) => {
        saves += 1;
        if (saves === 2) throw new Error("disk full");
        data = next as Record<string, unknown>;
      },
    } as Partial<McpToolsPlugin>);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      await revokeToken(plugin, "default");
      // The mirror is now stale — the sweep never landed. A crash or a
      // quit between the two writes produces the same state with no
      // error at all, which is why the seeding site, not the sweep, has
      // to be the thing that holds.
      await ensureTokenStore(plugin);
    } finally {
      warn.mockRestore();
    }

    const toolLoading = data.toolLoading as {
      profiles: Record<string, unknown>;
    };
    expect(toolLoading.profiles.claude).toEqual({
      profile: "all",
      promoted: [],
      allowed: null,
    });
  });

  test("the survivor does not inherit the revoked token's policy on the next load", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: {
        bearerToken: "a".repeat(43),
        tokens: [
          {
            id: "default",
            label: "Default",
            token: "a".repeat(43),
            createdAt: 1,
          },
          {
            id: "claude",
            label: "claude.ai",
            token: "b".repeat(43),
            createdAt: 2,
          },
        ],
      },
      toolLoading: {
        profile: "core",
        promoted: ["x"],
        counters: {},
        profiles: {
          default: { profile: "core", promoted: ["x"], allowed: null },
        },
      },
    });

    await revokeToken(plugin, "default");
    // `withPolicyFor` seeds a missing entry FROM the legacy globals, so
    // a stale mirror is not transient — this load is what would burn the
    // revoked token's surface into the survivor permanently.
    await ensureTokenStore(plugin);

    const toolLoading = getData().toolLoading as {
      profiles: Record<string, unknown>;
    };
    expect(toolLoading.profiles.claude).toEqual({
      profile: "all",
      promoted: [],
      allowed: null,
    });
  });
});
