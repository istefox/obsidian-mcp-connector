import { describe, expect, test } from "bun:test";
import { mockPlugin } from "$/test-setup";
import type McpToolsPlugin from "$/main";
import { flush, readEraCountersByToken, record } from "./eraCounters";

/**
 * `record`/`flush` batch per-era request counts in memory and persist them
 * through `SettingsStore.updateSlice`, the same batching discipline
 * `ToolLoadingManager.flushPendingCalls` already uses for tool-call
 * counters and for the same reason: a settings write per request would be
 * a disk write per request (ADR-0016 §7). `mcpServer.ts` calls
 * `record(era)` with no plugin reference on each branch of
 * `handleRequest`, so the in-memory batch itself is a single counter, not
 * one keyed by plugin — only `flush(plugin)` takes one.
 *
 * Exercised here against the same in-memory `data.json` double
 * `setup.test.ts` uses, plus a save counter so "no write when nothing
 * changed" can be asserted on write COUNT, the same way
 * `tokenStore.test.ts` asserts `ensureTokenStore`'s idempotency.
 *
 * Because the in-memory batch is a module-level singleton, every test
 * below records only what IT needs and flushes it away before finishing.
 * That keeps the batch at zero regardless of which test bun runs next —
 * none of the assertions here depend on file execution order.
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

describe("eraCounters — batched per-era request counts (R-16)", () => {
  test('record("legacy") x3 + record("modern") x2, then flush(plugin) writes the aggregated batch in one write', async () => {
    const { plugin, getData, saveCount } = makePlugin();

    record("legacy");
    record("legacy");
    record("legacy");
    record("modern");
    record("modern");
    await flush(plugin);

    const mcpTransport = getData().mcpTransport as {
      eraCounters?: { legacy: number; modern: number };
    };
    expect(mcpTransport.eraCounters).toEqual({ legacy: 3, modern: 2 });
    expect(saveCount()).toBe(1);
  });

  test("a second flush with nothing newly recorded performs no additional write", async () => {
    const { plugin, saveCount } = makePlugin();

    record("legacy");
    await flush(plugin);
    expect(saveCount()).toBe(1);

    await flush(plugin);
    expect(saveCount()).toBe(1);
  });

  test("existing eraCounters values accumulate rather than reset", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { eraCounters: { legacy: 5, modern: 1 } },
    });

    record("modern");
    record("modern");
    await flush(plugin);

    const mcpTransport = getData().mcpTransport as {
      eraCounters: { legacy: number; modern: number };
    };
    expect(mcpTransport.eraCounters).toEqual({ legacy: 5, modern: 3 });
  });

  test("an absent eraCounters key defaults to zero, and sibling mcpTransport fields survive untouched", async () => {
    const existingTokens = [
      {
        id: "default",
        label: "Default",
        token: "a".repeat(32),
        createdAt: 1,
      },
    ];
    const { plugin, getData } = makePlugin({
      mcpTransport: {
        port: 27123,
        livePort: 27123,
        serverName: "mcp-connector",
        bearerToken: existingTokens[0]!.token,
        tokens: existingTokens,
      },
      // A sibling top-level slice, unrelated to mcpTransport: proves the
      // write goes through updateSlice's `{ ...raw, [key]: next }` merge
      // rather than a hand-rolled write that could drop it. This is the
      // clobber CLAUDE.md's "Settings are sliced" invariant exists to
      // prevent — data.json is shared by every feature.
      toolLoading: { profile: "core", promoted: [], counters: {} },
    });

    record("legacy");
    await flush(plugin);

    const data = getData();
    const mcpTransport = data.mcpTransport as Record<string, unknown>;
    expect(mcpTransport.eraCounters).toEqual({ legacy: 1, modern: 0 });
    expect(mcpTransport.port).toBe(27123);
    expect(mcpTransport.livePort).toBe(27123);
    expect(mcpTransport.serverName).toBe("mcp-connector");
    expect(mcpTransport.tokens).toEqual(existingTokens);
    expect(data.toolLoading).toEqual({
      profile: "core",
      promoted: [],
      counters: {},
    });
  });
});

/**
 * OMC-024. The per-token map is ADDITIVE: `eraCounters` keeps counting the
 * vault and keeps being what ADR-0016 §8's trigger reads, while the map
 * answers the question the total cannot — which era a given CLIENT is served
 * on. `sum(byToken) <= eraCounters` holds by construction and nothing should
 * derive one from the other, so every test below asserts both.
 */
describe("eraCounters — per-token attribution (OMC-024)", () => {
  const TOK_A = { id: "tok_a", label: "A", token: "a".repeat(32) };
  const TOK_B = { id: "tok_b", label: "B", token: "b".repeat(32) };

  test("two tokens accumulate independently, and the total counts both", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { tokens: [TOK_A, TOK_B] },
    });

    record("legacy", TOK_A.id);
    record("legacy", TOK_A.id);
    record("modern", TOK_B.id);
    await flush(plugin);

    const slice = getData().mcpTransport as Record<string, unknown>;
    expect(slice.eraCountersByToken).toEqual({
      tok_a: { legacy: 2, modern: 0 },
      tok_b: { legacy: 0, modern: 1 },
    });
    expect(slice.eraCounters).toEqual({ legacy: 2, modern: 1 });
  });

  test("counts accumulate onto stored per-token values across flushes", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: {
        tokens: [TOK_A],
        eraCounters: { legacy: 7, modern: 1 },
        eraCountersByToken: { tok_a: { legacy: 5, modern: 1 } },
      },
    });

    record("legacy", TOK_A.id);
    await flush(plugin);

    const slice = getData().mcpTransport as Record<string, unknown>;
    expect(slice.eraCountersByToken).toEqual({
      tok_a: { legacy: 6, modern: 1 },
    });
    expect(slice.eraCounters).toEqual({ legacy: 8, modern: 1 });
  });

  // The pre-split history is exactly this case: a total with nothing under it.
  test("an empty tokenId moves the total and creates no bucket", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { tokens: [TOK_A] },
    });

    record("legacy", "");
    record("modern");
    await flush(plugin);

    const slice = getData().mcpTransport as Record<string, unknown>;
    expect(slice.eraCounters).toEqual({ legacy: 1, modern: 1 });
    // Dropped rather than written as `{}`, so a vault that never attributes a
    // request keeps the data.json it already had.
    expect("eraCountersByToken" in slice).toBe(false);
  });

  test("a revoked token's bucket is pruned, and the totals are left alone", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: {
        // tok_b is gone from `tokens` — revoked between the two flushes.
        tokens: [TOK_A],
        eraCounters: { legacy: 40, modern: 2 },
        eraCountersByToken: {
          tok_a: { legacy: 30, modern: 0 },
          tok_b: { legacy: 10, modern: 2 },
        },
      },
    });

    record("legacy", TOK_A.id);
    await flush(plugin);

    const slice = getData().mcpTransport as Record<string, unknown>;
    expect(slice.eraCountersByToken).toEqual({
      tok_a: { legacy: 31, modern: 0 },
    });
    // The revoked client's history stays inside the vault total: that number
    // is what the §8 trigger reads, and a revocation is not evidence that
    // nobody ever reached us on the legacy era.
    expect(slice.eraCounters).toEqual({ legacy: 41, modern: 2 });
  });

  // Read literally, a missing `tokens` means "no token exists" — and acting on
  // that during a boot where the counter writes before the token store is
  // seeded would wipe every bucket. A stale bucket is recoverable; that is not.
  test.each([
    ["absent", undefined],
    ["not an array", { nope: true }],
    ["an empty array", []],
  ])("a tokens key that is %s prunes nothing", async (_label, tokens) => {
    const { plugin, getData } = makePlugin({
      mcpTransport: {
        ...(tokens === undefined ? {} : { tokens }),
        eraCountersByToken: { tok_a: { legacy: 3, modern: 0 } },
      },
    });

    record("modern", TOK_B.id);
    await flush(plugin);

    const slice = getData().mcpTransport as Record<string, unknown>;
    expect(slice.eraCountersByToken).toEqual({
      tok_a: { legacy: 3, modern: 0 },
      tok_b: { legacy: 0, modern: 1 },
    });
  });

  test("a failed write restores BOTH dimensions of the batch", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { tokens: [TOK_A] },
    });
    const failing = plugin as unknown as {
      saveData: (d: unknown) => Promise<void>;
    };
    const saveData = failing.saveData.bind(failing);
    failing.saveData = async () => {
      throw new Error("disk full");
    };

    record("legacy", TOK_A.id);
    await expect(flush(plugin)).rejects.toThrow("disk full");

    // Restoring only the totals would leave the map permanently behind them,
    // and nothing downstream would ever notice.
    failing.saveData = saveData;
    await flush(plugin);
    const slice = getData().mcpTransport as Record<string, unknown>;
    expect(slice.eraCounters).toEqual({ legacy: 1, modern: 0 });
    expect(slice.eraCountersByToken).toEqual({
      tok_a: { legacy: 1, modern: 0 },
    });
  });
});

describe("readEraCountersByToken", () => {
  test("absent or non-object reads as an empty map", () => {
    expect(readEraCountersByToken(undefined)).toEqual({});
    expect(readEraCountersByToken(null)).toEqual({});
    expect(readEraCountersByToken(42)).toEqual({});
  });

  test("a malformed entry reads as zeros rather than throwing", () => {
    expect(
      readEraCountersByToken({ a: { legacy: "many" }, b: null, c: 7 }),
    ).toEqual({
      a: { legacy: 0, modern: 0 },
      b: { legacy: 0, modern: 0 },
      c: { legacy: 0, modern: 0 },
    });
  });
});
