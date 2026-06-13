import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { SettingsStore } from "./settingsStore";
import { createMutex, globalSettingsMutex } from "./settingsLock";

/**
 * In-memory plugin data mock. `saveData` forces a microtask gap so the
 * lost-update race is observable without the mutex (mirrors
 * settingsLock.test.ts).
 */
function makePlugin(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = structuredClone(initial);
  let saves = 0;
  return {
    plugin: {
      loadData: async () => structuredClone(data),
      saveData: async (next: unknown) => {
        await Promise.resolve();
        saves++;
        data = structuredClone(next as Record<string, unknown>);
      },
    },
    snapshot: () => structuredClone(data),
    saves: () => saves,
  };
}

describe("SettingsStore.updateSlice", () => {
  test("writes only its key, preserving siblings", async () => {
    const { plugin, snapshot } = makePlugin({ other: { keep: 1 } });
    const store = new SettingsStore(plugin);
    await store.updateSlice("mine", () => ({ v: 2 }));
    expect(snapshot()).toEqual({ other: { keep: 1 }, mine: { v: 2 } });
  });

  test("returning the same reference skips the write (NO_CHANGE)", async () => {
    const { plugin, saves } = makePlugin({ mine: { v: 1 } });
    const store = new SettingsStore(plugin);
    const ret = await store.updateSlice("mine", (current) => current);
    expect(saves()).toBe(0);
    expect(ret).toEqual({ v: 1 });
  });

  test("returning a new object always writes and propagates the value", async () => {
    const { plugin, saves } = makePlugin({ mine: { v: 1 } });
    const store = new SettingsStore(plugin);
    const ret = await store.updateSlice("mine", () => ({ v: 2 }));
    expect(saves()).toBe(1);
    expect(ret).toEqual({ v: 2 });
  });

  test("a corrupt sibling slice is preserved untouched", async () => {
    const { plugin, snapshot } = makePlugin({ broken: "not-an-object" });
    const store = new SettingsStore(plugin);
    await store.updateSlice("mine", () => ({ ok: true }));
    expect(snapshot()).toEqual({ broken: "not-an-object", mine: { ok: true } });
  });

  test("N concurrent writers on two keys through the singleton lose no slice", async () => {
    // Uses the DEFAULT globalSettingsMutex (not a fresh one): this is
    // what proves cross-feature safety, since every feature shares it.
    let data: Record<string, unknown> = {};
    const plugin = {
      loadData: async () => structuredClone(data),
      saveData: async (next: unknown) => {
        await Promise.resolve();
        data = structuredClone(next as Record<string, unknown>);
      },
    };
    const store = new SettingsStore(plugin, globalSettingsMutex);
    const push = (key: "a" | "b", value: number) =>
      store.updateSlice(key, (cur) => {
        const arr = Array.isArray(cur) ? [...(cur as number[])] : [];
        arr.push(value);
        return arr;
      });

    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) => [push("a", i), push("b", i)]).flat(),
    );
    expect((data.a as number[]).slice().sort((x, y) => x - y)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    );
    expect((data.b as number[]).slice().sort((x, y) => x - y)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    );
  });

  test("a fresh mutex does not serialize against the global singleton", async () => {
    // Per-instance isolation: a store built with createMutex() runs
    // independently of globalSettingsMutex (mirrors settingsLock's
    // distinct-instances test).
    const order: string[] = [];
    const slow = globalSettingsMutex.run(async () => {
      order.push("global-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("global-end");
    });
    const { plugin } = makePlugin();
    const isolated = new SettingsStore(plugin, createMutex());
    await isolated.updateSlice("x", () => {
      order.push("isolated");
      return 1;
    });
    await slow;
    // isolated ran before global finished — not serialized behind it.
    expect(order.indexOf("isolated")).toBeLessThan(order.indexOf("global-end"));
  });
});

describe("SettingsStore.loadSlice", () => {
  const schema = type({ provider: "string", count: "number" });
  const defaults = { provider: "native", count: 0 };

  test("merges defaults for missing keys and persists when changed", async () => {
    const { plugin, snapshot, saves } = makePlugin({
      semanticSearch: { provider: "auto" },
    });
    const store = new SettingsStore(plugin);
    const out = await store.loadSlice("semanticSearch", { schema, defaults });
    expect(out).toEqual({ provider: "auto", count: 0 });
    expect(saves()).toBe(1);
    expect(snapshot().semanticSearch).toEqual({ provider: "auto", count: 0 });
  });

  test("does NOT persist when disk already equals the merged result", async () => {
    const { plugin, saves } = makePlugin({
      semanticSearch: { provider: "native", count: 0 },
    });
    const store = new SettingsStore(plugin);
    await store.loadSlice("semanticSearch", { schema, defaults });
    expect(saves()).toBe(0);
  });

  test("invalid data falls back to defaults, persists them, does not throw", async () => {
    const { plugin, snapshot } = makePlugin({
      semanticSearch: { provider: 123, count: "nope" },
    });
    const store = new SettingsStore(plugin);
    const out = await store.loadSlice("semanticSearch", { schema, defaults });
    expect(out).toEqual(defaults);
    expect(snapshot().semanticSearch).toEqual(defaults);
  });

  test("no schema: merges defaults without validation", async () => {
    const { plugin } = makePlugin({ s: { a: 1 } });
    const store = new SettingsStore(plugin);
    const out = await store.loadSlice("s", { defaults: { a: 0, b: 9 } });
    expect(out).toEqual({ a: 1, b: 9 });
  });
});

describe("SettingsStore.readSlice", () => {
  test("returns the slice value without acquiring the write lock", async () => {
    const order: string[] = [];
    let data: Record<string, unknown> = { s: { v: 1 } };
    const plugin = {
      loadData: async () => structuredClone(data),
      // Slow save keeps the mutex held while the write is in flight.
      saveData: async (next: unknown) => {
        await new Promise((r) => setTimeout(r, 30));
        order.push("write-done");
        data = structuredClone(next as Record<string, unknown>);
      },
    };
    const store = new SettingsStore(plugin, globalSettingsMutex);

    const writing = store.updateSlice("s", () => ({ v: 2 }));
    // readSlice must resolve WITHOUT waiting for the in-flight write.
    const value = await store.readSlice("s");
    order.push("read-done");
    expect(order[0]).toBe("read-done");
    expect(value).toEqual({ v: 1 });
    await writing;
  });

  test("returns undefined for a missing slice", async () => {
    const { plugin } = makePlugin({});
    const store = new SettingsStore(plugin);
    expect(await store.readSlice("nope")).toBeUndefined();
  });
});
