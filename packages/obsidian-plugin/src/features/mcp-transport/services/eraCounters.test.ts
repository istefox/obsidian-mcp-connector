import { describe, expect, test } from "bun:test";
import { mockPlugin } from "$/test-setup";
import type McpToolsPlugin from "$/main";
import { flush, record } from "./eraCounters";

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
