import { describe, expect, test } from "bun:test";
import { createSemanticWiring } from "./wiringLifecycle";
import { wireSemanticSearch } from "./productionWiring";
import { FORMAT_VERSION, type VaultAdapter } from "./store";
import type { SemanticSearchState } from "../index";
import { mockPlugin, resetMockVault } from "$/test-setup";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A state stand-in whose only observable is how often it was torn down. */
function fakeState() {
  let teardowns = 0;
  const state = {
    teardown: async () => {
      teardowns += 1;
    },
  } as unknown as SemanticSearchState;
  return { state, teardowns: () => teardowns };
}

describe("createSemanticWiring", () => {
  test("a wiring that finishes before unload hands out its state", async () => {
    const fake = fakeState();
    const wiring = createSemanticWiring(async () => fake.state);
    expect(await wiring.wire()).toBe(fake.state);
    expect(wiring.unloaded).toBe(false);
    await wiring.unload();
    expect(fake.teardowns()).toBe(0);
  });

  test("a wiring that finishes after unload is torn down and not handed out, and unload waits for it", async () => {
    const fake = fakeState();
    const held = deferred<SemanticSearchState>();
    const wiring = createSemanticWiring(() => held.promise);
    const wired = wiring.wire();

    let unloadDone = false;
    const unloading = wiring.unload().then(() => {
      unloadDone = true;
    });
    expect(wiring.unloaded).toBe(true);
    await turn();
    expect(unloadDone).toBe(false);
    expect(fake.teardowns()).toBe(0);

    held.resolve(fake.state);
    expect(await wired).toBeUndefined();
    await unloading;
    expect(fake.teardowns()).toBe(1);
  });

  test("a failing late teardown or wiring does not make unload reject", async () => {
    const failing = createSemanticWiring(async () => {
      throw new Error("wiring failed");
    });
    const wired = failing.wire();
    await expect(wired).rejects.toThrow("wiring failed");
    await failing.unload();

    const badTeardown = createSemanticWiring(
      async () =>
        ({
          teardown: async () => {
            throw new Error("disk gone");
          },
        }) as unknown as SemanticSearchState,
    );
    const late = badTeardown.wire();
    const unloading = badTeardown.unload();
    expect(await late).toBeUndefined();
    await unloading;
  });

  test("a wiring asked for after unload never starts", async () => {
    let calls = 0;
    const wiring = createSemanticWiring(async () => {
      calls += 1;
      return undefined;
    });
    await wiring.unload();
    expect(await wiring.wire()).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("wireSemanticSearch — unload while the stale-store wipe is paused", () => {
  test("the late state is torn down, nothing is started, and no store write follows unload", async () => {
    resetMockVault();
    // A stale native store, so wiring wipes it through adapter.remove().
    const files = new Map<string, string>();
    const bins = new Map<string, ArrayBuffer>();
    const dir = "/p/embeddings/native-minilm-l6-v2";
    files.set(
      `${dir}/embeddings.meta.json`,
      JSON.stringify({ version: FORMAT_VERSION - 1, recordCount: 3 }),
    );
    bins.set(`${dir}/embeddings.bin`, new ArrayBuffer(8));
    let writes = 0;
    const parked = deferred();
    const resume = deferred();
    let first = true;
    const adapter: VaultAdapter = {
      exists: async (p) => files.has(p) || bins.has(p),
      read: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
      },
      write: async (p, d) => {
        writes += 1;
        files.set(p, d);
      },
      readBinary: async (p) => {
        const v = bins.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v.slice(0);
      },
      writeBinary: async (p, d) => {
        writes += 1;
        bins.set(p, d.slice(0));
      },
      remove: async (p) => {
        writes += 1;
        if (first) {
          first = false;
          parked.resolve();
          await resume.promise;
        }
        files.delete(p);
        bins.delete(p);
      },
      mkdir: async () => {},
    };
    let data: Record<string, unknown> = {};
    const plugin = mockPlugin({
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = next as Record<string, unknown>;
      },
    });
    const app = plugin.app as unknown as {
      vault: Record<string, unknown>;
      workspace: { onLayoutReady: (cb: () => void) => void };
    };
    app.vault.adapter = adapter;
    app.vault.configDir = ".obsidian";
    // Layout becomes ready only after unload.
    const layoutCallbacks: Array<() => void> = [];
    app.workspace.onLayoutReady = (cb) => {
      layoutCallbacks.push(cb);
    };
    (plugin.manifest as { dir?: string }).dir = "/p";

    let teardowns = 0;
    let starts = 0;
    const wiring = createSemanticWiring(async () => {
      const state = await wireSemanticSearch(plugin);
      const start = state!.indexer!.start.bind(state!.indexer);
      state!.indexer!.start = (opts) => {
        starts += 1;
        return start(opts);
      };
      const teardown = state!.teardown;
      state!.teardown = async () => {
        teardowns += 1;
        await teardown();
      };
      return state;
    });
    const wired = wiring.wire();
    await parked.promise;

    // Unload lands while the wipe is paused: it must not finish early.
    let unloadDone = false;
    const unloading = wiring.unload().then(() => {
      unloadDone = true;
    });
    for (let i = 0; i < 3; i++) await turn();
    expect(unloadDone).toBe(false);

    resume.resolve();
    expect(await wired).toBeUndefined();
    await unloading;
    expect(teardowns).toBe(1);

    // The wipe finished before unload resolved, and nothing wrote after.
    expect(files.has(`${dir}/embeddings.meta.json`)).toBe(false);
    const writesAtUnload = writes;
    // The host's layout-ready callbacks, the stale-index rebuild among
    // them, fire late and start nothing.
    expect(layoutCallbacks.length).toBeGreaterThan(0);
    for (const cb of layoutCallbacks.splice(0)) cb();
    for (let i = 0; i < 3; i++) await turn();
    expect(starts).toBe(0);
    expect(writes).toBe(writesAtUnload);
  });
});
