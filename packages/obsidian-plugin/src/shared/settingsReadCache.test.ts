import { afterEach, describe, expect, test } from "bun:test";
import { SettingsStore } from "./settingsStore";
import {
  disableSettingsReadCache,
  enableSettingsReadCache,
  invalidateSettingsReadCache,
  loadSettingsSnapshot,
} from "./settingsReadCache";
import { createMutex } from "./settingsLock";

/**
 * In-memory plugin whose `loadData` counts calls, so the tests can say
 * exactly how many disk reads a sequence of store operations costs.
 */
function makePlugin(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = structuredClone(initial);
  let loads = 0;
  const plugin = {
    loadData: async () => {
      loads += 1;
      return structuredClone(data);
    },
    saveData: async (next: unknown) => {
      data = structuredClone(next as Record<string, unknown>);
    },
  };
  return {
    plugin,
    loads: () => loads,
    /** An edit this process never sees — a hand edit, Obsidian Sync. */
    editOnDisk: (next: Record<string, unknown>) => {
      data = structuredClone(next);
    },
  };
}

const enabled: object[] = [];
function enable(plugin: object, ttlMs?: number): void {
  enableSettingsReadCache(plugin as never, ttlMs);
  enabled.push(plugin);
}
afterEach(() => {
  for (const p of enabled.splice(0)) disableSettingsReadCache(p as never);
});

describe("settingsReadCache — off (the default)", () => {
  test("every readSlice is a disk read, exactly as before", async () => {
    const { plugin, loads } = makePlugin({ a: 1 });
    const store = new SettingsStore(plugin, createMutex());
    await store.readSlice("a");
    await store.readSlice("a");
    expect(loads()).toBe(2);
  });
});

describe("settingsReadCache — on", () => {
  test("reads within the TTL share one disk read", async () => {
    const { plugin, loads } = makePlugin({ a: 1, b: 2 });
    enable(plugin);
    const store = new SettingsStore(plugin, createMutex());
    expect(await store.readSlice("a")).toBe(1);
    expect(await store.readSlice("b")).toBe(2);
    expect(await store.readSlice("a")).toBe(1);
    expect(loads()).toBe(1);
  });

  test("concurrent readers during a miss share the in-flight load", async () => {
    const { plugin, loads } = makePlugin({ a: 1 });
    enable(plugin);
    const store = new SettingsStore(plugin, createMutex());
    const [x, y, z] = await Promise.all([
      store.readSlice("a"),
      store.readSlice("a"),
      store.readSlice("a"),
    ]);
    expect([x, y, z]).toEqual([1, 1, 1]);
    expect(loads()).toBe(1);
  });

  test("a write through the store is visible to the very next read, with no disk read in between", async () => {
    const { plugin, loads } = makePlugin({ a: 1 });
    enable(plugin);
    const store = new SettingsStore(plugin, createMutex());
    expect(await store.readSlice("a")).toBe(1);
    await store.updateSlice("a", () => 2);
    const afterWrite = loads();
    expect(await store.readSlice("a")).toBe(2);
    expect(loads()).toBe(afterWrite);
  });

  test("a write always starts from disk, never from the cache", async () => {
    const { plugin, loads, editOnDisk } = makePlugin({ a: 1, other: "x" });
    enable(plugin);
    const store = new SettingsStore(plugin, createMutex());
    await store.readSlice("a");
    // An external writer changed a sibling slice inside the TTL window.
    editOnDisk({ a: 1, other: "y" });
    const before = loads();
    await store.updateSlice("a", () => 2);
    expect(loads()).toBe(before + 1);
    // The sibling edit survived: the recipe spread the on-disk snapshot.
    expect(await store.readSlice("other")).toBe("y");
  });

  test("loadSlice's persisted defaults prime the cache too", async () => {
    const { plugin, loads } = makePlugin({});
    enable(plugin);
    const store = new SettingsStore(plugin, createMutex());
    await store.loadSlice("s", { defaults: { v: 1 } });
    const after = loads();
    expect(await store.readSlice("s")).toEqual({ v: 1 });
    expect(loads()).toBe(after);
  });

  test("an external edit is picked up once the TTL has elapsed", async () => {
    const { plugin, editOnDisk } = makePlugin({ a: 1 });
    enable(plugin, 10);
    const store = new SettingsStore(plugin, createMutex());
    expect(await store.readSlice("a")).toBe(1);
    editOnDisk({ a: 2 });
    expect(await store.readSlice("a")).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(await store.readSlice("a")).toBe(2);
  });

  test("invalidate forces the next read to disk", async () => {
    const { plugin, loads, editOnDisk } = makePlugin({ a: 1 });
    enable(plugin);
    const store = new SettingsStore(plugin, createMutex());
    await store.readSlice("a");
    editOnDisk({ a: 2 });
    invalidateSettingsReadCache(plugin);
    expect(await store.readSlice("a")).toBe(2);
    expect(loads()).toBe(2);
  });

  test("disable drops the snapshot and returns reads to disk", async () => {
    const { plugin, loads } = makePlugin({ a: 1 });
    enable(plugin);
    const store = new SettingsStore(plugin, createMutex());
    await store.readSlice("a");
    disableSettingsReadCache(plugin);
    await store.readSlice("a");
    await store.readSlice("a");
    expect(loads()).toBe(3);
  });

  test("a failed load is not cached and does not wedge later reads", async () => {
    let fail = true;
    let loads = 0;
    const plugin = {
      loadData: async () => {
        loads += 1;
        if (fail) throw new Error("disk");
        return { a: 1 };
      },
      saveData: async () => undefined,
    };
    enable(plugin);
    await expect(loadSettingsSnapshot(plugin)).rejects.toThrow("disk");
    fail = false;
    expect(await loadSettingsSnapshot(plugin)).toEqual({ a: 1 });
    expect(loads).toBe(2);
  });

  test("the cache is per plugin instance", async () => {
    const one = makePlugin({ a: 1 });
    const two = makePlugin({ a: 2 });
    enable(one.plugin);
    enable(two.plugin);
    expect(await new SettingsStore(one.plugin).readSlice("a")).toBe(1);
    expect(await new SettingsStore(two.plugin).readSlice("a")).toBe(2);
  });
});
