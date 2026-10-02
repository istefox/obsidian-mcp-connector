import { describe, expect, test } from "bun:test";
import type McpToolsPlugin from "src/main";
import { loadSmartSearchAPI } from "./index";

/**
 * The poll replaced an rxjs pipeline (interval → takeUntil(timer) → map →
 * takeWhile(no callable search, inclusive) → distinct(installed)). These
 * tests pin the behaviour that pipeline had: report on the first tick and
 * on every flip of `installed`, stop as soon as a usable API shows up,
 * give up at the horizon, and go quiet when cancelled.
 */

type Registry = Record<string, unknown>;

function fakePlugin(registry: Registry): McpToolsPlugin {
  return {
    app: { plugins: { plugins: registry } },
  } as unknown as McpToolsPlugin;
}

const v3 = {
  env: { smart_sources: { lookup: async () => [] } },
};

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("loadSmartSearchAPI poll", () => {
  test("not installed: one report with installed=false, then completes at the horizon", async () => {
    const seen: boolean[] = [];
    let completed = 0;
    loadSmartSearchAPI(fakePlugin({}), {
      onNext: (dep) => seen.push(dep.installed),
      onComplete: () => completed++,
      intervalMs: 5,
      timeoutMs: 40,
    });
    await settle(80);
    expect(seen).toEqual([false]);
    expect(completed).toBe(1);
  });

  test("API appears mid-poll: reports the flip with the API and completes at once", async () => {
    const registry: Registry = {};
    const seen: Array<{ installed: boolean; hasSearch: boolean }> = [];
    let completed = 0;
    loadSmartSearchAPI(fakePlugin(registry), {
      onNext: (dep) =>
        seen.push({
          installed: dep.installed,
          hasSearch: typeof dep.api?.search === "function",
        }),
      onComplete: () => completed++,
      intervalMs: 5,
      timeoutMs: 500,
    });
    await settle(15);
    registry["smart-connections"] = v3;
    await settle(30);
    expect(seen).toEqual([
      { installed: false, hasSearch: false },
      { installed: true, hasSearch: true },
    ]);
    expect(completed).toBe(1);
    const reports = seen.length;
    await settle(30);
    expect(seen.length).toBe(reports);
  });

  test("installed from the first tick: one report, immediate completion", async () => {
    const seen: boolean[] = [];
    let completed = 0;
    loadSmartSearchAPI(fakePlugin({ "smart-connections": v3 }), {
      onNext: (dep) => seen.push(dep.installed),
      onComplete: () => completed++,
      intervalMs: 5,
      timeoutMs: 500,
    });
    await settle(30);
    expect(seen).toEqual([true]);
    expect(completed).toBe(1);
  });

  test("cancel stops the ticks and never calls onComplete", async () => {
    const seen: boolean[] = [];
    let completed = 0;
    const cancel = loadSmartSearchAPI(fakePlugin({}), {
      onNext: (dep) => seen.push(dep.installed),
      onComplete: () => completed++,
      intervalMs: 5,
      timeoutMs: 40,
    });
    await settle(12);
    cancel();
    await settle(60);
    expect(seen).toEqual([false]);
    expect(completed).toBe(0);
  });

  test("a throwing tick reports the error and completes", async () => {
    const errors: unknown[] = [];
    let completed = 0;
    loadSmartSearchAPI({ app: {} } as unknown as McpToolsPlugin, {
      onNext: () => {},
      onComplete: () => completed++,
      onError: (e) => errors.push(e),
      intervalMs: 5,
      timeoutMs: 500,
    });
    await settle(30);
    expect(errors.length).toBe(1);
    expect(completed).toBe(1);
  });
});
