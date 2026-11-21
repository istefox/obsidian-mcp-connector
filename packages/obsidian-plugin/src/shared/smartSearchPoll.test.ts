import { describe, expect, test } from "bun:test";
import type McpToolsPlugin from "src/main";
import { loadSmartSearchAPI, startSmartSearchBinding } from "./index";

/**
 * The poll replaced an rxjs pipeline (interval → takeUntil(timer) → map →
 * takeWhile(no callable search, inclusive) → distinct(installed)). These
 * tests pin the behaviour that pipeline had: report on the first tick and
 * on every flip of `installed`, stop as soon as a usable API shows up,
 * give up at the horizon, and go quiet when cancelled. #676 widened the
 * report condition to a change of `installed` OR of a callable search, and
 * added `startSmartSearchBinding`'s on-demand `refresh` for an API that
 * shows up after the horizon.
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

type SmartSearchGlobal = { SmartSearch?: unknown };

function withWindowSmartSearch(value: unknown): () => void {
  const w = window as unknown as SmartSearchGlobal;
  w.SmartSearch = value;
  return () => {
    delete w.SmartSearch;
  };
}

describe("loadSmartSearchAPI poll — callable search with unchanged installed (#676)", () => {
  test("window.SmartSearch without search, then the v3 API: reported although installed stays true", async () => {
    // The real v2 branch of detectSmartConnections: a truthy
    // window.SmartSearch gives installed=true with no callable search.
    const restore = withWindowSmartSearch({});
    try {
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
      await settle(20);
      registry["smart-connections"] = v3;
      await settle(30);
      expect(seen).toEqual([
        { installed: true, hasSearch: false },
        { installed: true, hasSearch: true },
      ]);
      expect(completed).toBe(1);
    } finally {
      restore();
    }
  });

  test("the binding ends callable in the same case", async () => {
    const restore = withWindowSmartSearch({});
    try {
      const registry: Registry = {};
      const plugin = fakePlugin(registry);
      const binding = startSmartSearchBinding(plugin, {
        bind: (dep) => {
          plugin.smartSearch = dep.api;
        },
        onComplete: () => {},
        intervalMs: 5,
        timeoutMs: 500,
      });
      await settle(20);
      expect(typeof plugin.smartSearch?.search).not.toBe("function");
      registry["smart-connections"] = v3;
      await settle(30);
      expect(typeof plugin.smartSearch?.search).toBe("function");
      binding.cancel();
    } finally {
      restore();
    }
  });
});

describe("startSmartSearchBinding — API after the horizon (#676)", () => {
  function setup(registry: Registry) {
    const plugin = fakePlugin(registry);
    const bound: boolean[] = [];
    let completed = 0;
    const binding = startSmartSearchBinding(plugin, {
      bind: (dep) => {
        plugin.smartSearch = dep.api;
        bound.push(typeof dep.api?.search === "function");
      },
      onComplete: () => completed++,
      intervalMs: 5,
      timeoutMs: 30,
    });
    return { plugin, binding, bound, completed: () => completed };
  }

  test("the poll gives up; refresh binds the API that appears later, once", async () => {
    const registry: Registry = {};
    const { plugin, binding, bound, completed } = setup(registry);
    await settle(60);
    expect(completed()).toBe(1);
    expect(bound).toEqual([false]);
    expect(binding.refresh()).toBe(false);
    expect(bound).toEqual([false]);

    registry["smart-connections"] = v3;
    expect(binding.refresh()).toBe(true);
    expect(bound).toEqual([false, true]);
    expect(typeof plugin.smartSearch?.search).toBe("function");

    // Already bound: no second detection, no second bind.
    expect(binding.refresh()).toBe(true);
    expect(bound).toEqual([false, true]);
  });

  test("no timer survives the horizon", async () => {
    let lookups = 0;
    const registry: Registry = {};
    Object.defineProperty(registry, "smart-connections", {
      get: () => {
        lookups++;
        return undefined;
      },
    });
    const { completed } = setup(registry);
    await settle(60);
    expect(completed()).toBe(1);
    const atHorizon = lookups;
    expect(atHorizon).toBeGreaterThan(0);
    await settle(60);
    expect(lookups).toBe(atHorizon);
  });

  test("cancelled after the horizon: refresh binds nothing", async () => {
    const registry: Registry = {};
    const { plugin, binding, bound, completed } = setup(registry);
    await settle(60);
    expect(completed()).toBe(1);
    binding.cancel();
    registry["smart-connections"] = v3;
    expect(binding.refresh()).toBe(false);
    expect(bound).toEqual([false]);
    expect(plugin.smartSearch).toBeUndefined();
  });

  test("cancelled inside the first window: ticks stop, onComplete never runs, refresh binds nothing", async () => {
    const registry: Registry = {};
    const { plugin, binding, bound, completed } = setup(registry);
    await settle(12);
    binding.cancel();
    registry["smart-connections"] = v3;
    await settle(60);
    expect(completed()).toBe(0);
    expect(bound).toEqual([false]);
    expect(binding.refresh()).toBe(false);
    expect(plugin.smartSearch).toBeUndefined();
  });
});

describe("startSmartSearchBinding — v2 window.SmartSearch that gains search in place", () => {
  test("after the horizon: refresh hands the now-callable API to bind", async () => {
    const legacy: { search?: () => Promise<unknown[]> } = {};
    const restore = withWindowSmartSearch(legacy);
    try {
      const plugin = fakePlugin({});
      const bound: boolean[] = [];
      let completed = 0;
      const binding = startSmartSearchBinding(plugin, {
        bind: (dep) => {
          plugin.smartSearch = dep.api;
          bound.push(typeof dep.api?.search === "function");
        },
        onComplete: () => completed++,
        intervalMs: 5,
        timeoutMs: 30,
      });
      await settle(60);
      expect(completed).toBe(1);
      expect(bound).toEqual([false]);
      // The SAME object, already bound, becomes callable.
      legacy.search = async () => [];
      expect(typeof plugin.smartSearch?.search).toBe("function");
      expect(binding.refresh()).toBe(true);
      expect(bound).toEqual([false, true]);
      // Reported once: the next refresh is the fast path.
      expect(binding.refresh()).toBe(true);
      expect(bound).toEqual([false, true]);
    } finally {
      restore();
    }
  });

  test("inside the poll window: the tick that sees it callable reports it", async () => {
    const legacy: { search?: () => Promise<unknown[]> } = {};
    const restore = withWindowSmartSearch(legacy);
    try {
      const seen: boolean[] = [];
      let completed = 0;
      loadSmartSearchAPI(fakePlugin({}), {
        onNext: (dep) => seen.push(typeof dep.api?.search === "function"),
        onComplete: () => completed++,
        intervalMs: 5,
        timeoutMs: 500,
      });
      await settle(20);
      legacy.search = async () => [];
      await settle(30);
      expect(seen).toEqual([false, true]);
      expect(completed).toBe(1);
    } finally {
      restore();
    }
  });
});
