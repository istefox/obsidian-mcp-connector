import { describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isIndexableFile,
  probeAndWipeStaleStores,
  purgeExcludedFromStores,
  wireSemanticSearch,
} from "./productionWiring";
import { createEmbeddingStoreRegistry } from "./storeRegistry";
import { createEmbeddingGemmaProvider } from "./embeddingGemmaProvider";
import { applySettings } from "..";
import type { SemanticIndexer } from "./indexer";
import {
  FORMAT_VERSION,
  type EmbeddingRecord,
  type VaultAdapter,
} from "./store";
import { compilePolicy, EMPTY_POLICY } from "$/shared/pathPolicy";
import { TFile } from "obsidian";
import {
  fireMockVaultEvent,
  mockPlugin,
  resetMockVault,
  setMockFile,
  setMockFileStat,
} from "$/test-setup";
import { pathPolicyFor } from "$/shared/policyProvider";
import { captureLogLines } from "$/shared/log/logCapture";

/** In-memory adapter tracking text + binary files and remove() calls. */
function memAdapter() {
  const files = new Map<string, string>();
  const bins = new Map<string, ArrayBuffer>();
  const removed: string[] = [];
  const adapter: VaultAdapter = {
    async exists(p) {
      return files.has(p) || bins.has(p);
    },
    async read(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async write(p, d) {
      files.set(p, d);
    },
    async readBinary(p) {
      const v = bins.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v.slice(0);
    },
    async writeBinary(p, d) {
      bins.set(p, d.slice(0));
    },
    async remove(p) {
      removed.push(p);
      if (!files.delete(p) && !bins.delete(p)) {
        throw new Error(`ENOENT ${p}`);
      }
    },
    async mkdir() {},
  };
  return { adapter, files, bins, removed: () => removed };
}

const BASE = "/p/embeddings";

/** Write a store's index + meta sidecar at a given format version. */
function seedStore(
  mem: ReturnType<typeof memAdapter>,
  key: string,
  version: number,
  recordCount: number,
) {
  const dir = `${BASE}/${key}`;
  mem.files.set(
    `${dir}/embeddings.index.json`,
    JSON.stringify({ version, records: new Array(recordCount).fill({}) }),
  );
  mem.files.set(
    `${dir}/embeddings.meta.json`,
    JSON.stringify({ version, recordCount }),
  );
  mem.bins.set(`${dir}/embeddings.bin`, new ArrayBuffer(8));
  mem.files.set(`${dir}/mtimes.json`, "{}");
}

describe("probeAndWipeStaleStores", () => {
  test("empty base dir: no stale keys, no counts, no removals", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual([]);
    expect(probedCounts).toEqual({});
    expect(mem.removed()).toEqual([]);
  });

  test("current non-empty store is marked ready with its count, not wiped", async () => {
    const mem = memAdapter();
    seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION, 42);
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual([]);
    expect(probedCounts["native-minilm-l6-v2"]).toBe(42);
    expect(registry.isReady("native-minilm-l6-v2")).toBe(true);
    expect(mem.removed()).toEqual([]);
    // Files survive.
    expect(
      await mem.adapter.exists(`${BASE}/native-minilm-l6-v2/embeddings.bin`),
    ).toBe(true);
  });

  test("stale store: reported stale AND all its files wiped (legacy pair + segments)", async () => {
    const mem = memAdapter();
    const key = "native-minilm-l6-v2";
    seedStore(mem, key, FORMAT_VERSION - 1, 10);
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual([key]);
    expect(probedCounts).toEqual({});
    expect(registry.isReady(key)).toBe(false);
    // Every candidate file is attempted best-effort: the legacy pair,
    // the sidecars, and each segment pair (a stale store may be in
    // either layout, or mid-migration in both).
    const dir = `${BASE}/${key}`;
    const expectedTargets = [
      `${dir}/embeddings.bin`,
      `${dir}/embeddings.index.json`,
      `${dir}/embeddings.index.json.writing`,
      `${dir}/mtimes.json`,
      `${dir}/embeddings.meta.json`,
    ];
    for (let seg = 0; seg < 16; seg++) {
      expectedTargets.push(
        `${dir}/embeddings.seg${seg}.bin`,
        `${dir}/embeddings.seg${seg}.index.json`,
      );
    }
    expect(mem.removed()).toEqual(expectedTargets);
    expect(await mem.adapter.exists(`${dir}/embeddings.bin`)).toBe(false);
    expect(await mem.adapter.exists(`${dir}/embeddings.index.json`)).toBe(
      false,
    );
  });

  test("a current store and a stale store: only the stale one is wiped", async () => {
    const mem = memAdapter();
    seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION, 5);
    seedStore(mem, "embedding-gemma-300m", FORMAT_VERSION - 1, 9);
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual(["embedding-gemma-300m"]);
    expect(probedCounts).toEqual({ "native-minilm-l6-v2": 5 });
    expect(
      await mem.adapter.exists(`${BASE}/native-minilm-l6-v2/embeddings.bin`),
    ).toBe(true);
    expect(
      await mem.adapter.exists(`${BASE}/embedding-gemma-300m/embeddings.bin`),
    ).toBe(false);
  });
});

describe("isIndexableFile", () => {
  // Builds an object that passes `instanceof TFile` (the obsidian mock
  // wires up the prototype) with an explicit `extension`, without
  // depending on MockTFile.
  function fakeTFile(path: string, extension: string): TFile {
    const f = Object.create(TFile.prototype) as TFile;
    Object.assign(f, { path, extension });
    return f;
  }

  test("accepts a .md TFile", () => {
    expect(isIndexableFile(fakeTFile("Notes/a.md", "md"))).toBe(true);
  });

  test("rejects a .pdf TFile", () => {
    expect(isIndexableFile(fakeTFile("Attachments/doc.pdf", "pdf"))).toBe(
      false,
    );
  });

  test("rejects a .canvas TFile", () => {
    expect(isIndexableFile(fakeTFile("map.canvas", "canvas"))).toBe(false);
  });

  test("rejects something that is not a TFile", () => {
    expect(isIndexableFile({ path: "x.md", extension: "md" })).toBe(false);
    expect(isIndexableFile(null)).toBe(false);
  });
});

describe("purgeExcludedFromStores", () => {
  const DIMS = {
    "native-minilm-l6-v2": 384,
    "embedding-gemma-300m": 768,
    "multilingual-e5-base": 768,
  } as const;

  function rec(filePath: string, dim: number): EmbeddingRecord {
    return {
      chunkId: `${filePath}#0`,
      filePath,
      offset: 0,
      heading: "Session notes",
      contentHash: "deadbeefdeadbeef",
      vector: new Float32Array(dim),
    };
  }

  /** Seed a real store for `key` with one record per path, flushed. */
  async function seed(
    registry: ReturnType<typeof createEmbeddingStoreRegistry>,
    key: keyof typeof DIMS,
    paths: string[],
  ) {
    const store = registry.storeFor(key, DIMS[key]);
    await store.init();
    await store.upsert(paths.map((p) => rec(p, DIMS[key])));
    await store.flush();
    return store;
  }

  test("purges every provider store, not only the active one", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const native = await seed(registry, "native-minilm-l6-v2", [
      "Journal/a.md",
      "Notes/b.md",
    ]);
    const gemma = await seed(registry, "embedding-gemma-300m", [
      "Journal/c.md",
    ]);

    // A store the user switched away from still holds paths and
    // headings. "Hidden unless you switch back to last month's
    // provider" is not a policy (ADR-0020 D15).
    const removed = await purgeExcludedFromStores(
      registry,
      compilePolicy(["Journal"]),
    );

    expect(removed).toBe(2);
    expect(native.hasRecords("Journal/a.md")).toBe(false);
    expect(native.hasRecords("Notes/b.md")).toBe(true);
    expect(gemma.hasRecords("Journal/c.md")).toBe(false);
  });

  test("an empty policy purges nothing", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const native = await seed(registry, "native-minilm-l6-v2", [
      "Journal/a.md",
    ]);

    expect(await purgeExcludedFromStores(registry, EMPTY_POLICY)).toBe(0);
    expect(native.hasRecords("Journal/a.md")).toBe(true);
  });

  test("never initializes a store this vault has never used", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);

    expect(
      await purgeExcludedFromStores(registry, compilePolicy(["Journal"])),
    ).toBe(0);
    // A store that inits writes a dirty sentinel and a segment pair on
    // its first flush. Nothing on disk means nothing was loaded — the
    // point of probing before touching a provider's bin.
    expect(mem.files.size).toBe(0);
    expect(mem.bins.size).toBe(0);
  });
});

/**
 * R-09: a successful semantic-search wiring is logged. The line is read back
 * from an in-memory file system the logger is configured onto.
 */
describe("diagnostic log — semantic-search started", () => {
  const STARTED = "semantic-search: started";
  const { lines, has, named } = captureLogLines();

  /** A plugin whose vault adapter is in memory and whose layout never becomes ready. */
  function wiringPlugin() {
    const mem = memAdapter();
    let data: Record<string, unknown> = {};
    const plugin = mockPlugin({
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = next as Record<string, unknown>;
      },
    });
    const app = plugin.app as unknown as {
      vault: Record<string, unknown>;
      workspace: Record<string, unknown>;
    };
    app.vault.adapter = mem.adapter;
    app.vault.configDir = ".obsidian";
    app.workspace.onLayoutReady = () => {};
    (plugin.manifest as { dir?: string }).dir = "/p";
    return plugin;
  }

  test("a successful wiring writes `semantic-search: started` at INFO with a provider", async () => {
    const plugin = wiringPlugin();
    const state = await wireSemanticSearch(plugin);
    expect(state).toBeDefined();
    try {
      const started = named(await lines((a) => has(a, STARTED)), STARTED);
      expect(started).toHaveLength(1);
      expect(started[0]?.level).toBe("INFO");
      expect(typeof started[0]?.fields.provider).toBe("string");
      expect((started[0]?.fields.provider as string).length).toBeGreaterThan(0);
    } finally {
      await state?.teardown();
    }
  });
});

/**
 * ADR-0020 D11: the indexer runs on vault events, the `onLayoutReady`
 * rebuild and work deferred past a tool call, none of them a request. It
 * reads the vault-wide policy explicitly. `current()` falls back to that
 * policy outside a scope, so only a scope opened on purpose, and a spy on
 * `getStore`, can tell the two reads apart.
 */
describe("indexer policy source", () => {
  /** A wired plugin whose vault-wide policy excludes `Private`. */
  function wiringPlugin() {
    const mem = memAdapter();
    const data = { mcpTools: { excludedFolders: ["Private"] } };
    const plugin = mockPlugin({
      loadData: async () => data,
      saveData: async () => undefined,
    });
    const app = plugin.app as unknown as {
      vault: Record<string, unknown>;
      workspace: Record<string, unknown>;
    };
    app.vault.adapter = mem.adapter;
    app.vault.configDir = ".obsidian";
    app.workspace.onLayoutReady = () => {};
    (plugin.manifest as { dir?: string }).dir = "/p";
    return plugin;
  }

  function note(path: string): TFile {
    const f = Object.create(TFile.prototype) as TFile;
    Object.assign(f, { path, extension: "md" });
    return f;
  }

  /** Wires, starts the indexer without a rebuild, and runs `body`. */
  async function withIndexer(
    body: (ctx: {
      pending: () => number;
      runWith: (policy: typeof EMPTY_POLICY, fn: () => void) => void;
    }) => void | Promise<void>,
  ): Promise<void> {
    const plugin = wiringPlugin();
    const state = await wireSemanticSearch(plugin);
    if (!state?.indexer) throw new Error("semantic search was not wired");
    try {
      await state.indexer.start({ initialRebuild: false });
      const provider = pathPolicyFor(plugin);
      await body({
        pending: () => state.indexer!.pending(),
        runWith: (policy, fn) => provider.runWith(policy, fn),
      });
    } finally {
      await state.indexer.stop();
      await state.teardown();
    }
  }

  test("a vault-wide exclusion applies to a vault event", async () => {
    await withIndexer(({ pending }) => {
      fireMockVaultEvent("modify", note("Private/a.md"));
      expect(pending()).toBe(0);
      fireMockVaultEvent("modify", note("Other/a.md"));
      expect(pending()).toBe(1);
    });
  });

  test("an unrelated request scope does not lift the exclusion", async () => {
    await withIndexer(({ pending, runWith }) => {
      // A request whose own policy excludes nothing is in flight.
      runWith(EMPTY_POLICY, () =>
        fireMockVaultEvent("modify", note("Private/a.md")),
      );
      expect(pending()).toBe(0);
    });
  });

  test("an unrelated request scope does not add an exclusion", async () => {
    await withIndexer(({ pending, runWith }) => {
      runWith(compilePolicy(["Other"]), () =>
        fireMockVaultEvent("modify", note("Other/a.md")),
      );
      expect(pending()).toBe(1);
    });
  });

  test("vault events never read AsyncLocalStorage", async () => {
    await withIndexer(({ pending }) => {
      const getStore = spyOn(AsyncLocalStorage.prototype, "getStore");
      try {
        fireMockVaultEvent("modify", note("Other/a.md"));
        fireMockVaultEvent("create", note("Private/b.md"));
        fireMockVaultEvent("delete", note("Other/c.md"));
        expect(pending()).toBeGreaterThan(0);
        expect(getStore).toHaveBeenCalledTimes(0);
      } finally {
        getStore.mockRestore();
      }
    });
  });
});

/**
 * The multilingual-provider suggestion samples vault files. It must wait for
 * onLayoutReady: during onload() `getMarkdownFiles()` can still be empty, and
 * the 50 reads would run inside plugin load.
 */
describe("language sampling timing", () => {
  function deferredLayoutPlugin() {
    const mem = memAdapter();
    const ready: Array<() => void> = [];
    const plugin = mockPlugin({
      loadData: async () => ({}),
      saveData: async () => undefined,
    });
    const app = plugin.app as unknown as {
      vault: Record<string, unknown>;
      workspace: Record<string, unknown>;
    };
    app.vault.adapter = mem.adapter;
    app.vault.configDir = ".obsidian";
    app.workspace.onLayoutReady = (cb: () => void) => {
      ready.push(cb);
    };
    (plugin.manifest as { dir?: string }).dir = "/p";
    return { plugin, ready };
  }

  test("sampling waits for onLayoutReady, so a vault that scans in late is still sampled", async () => {
    resetMockVault();
    const { plugin, ready } = deferredLayoutPlugin();
    const state = await wireSemanticSearch(plugin);
    try {
      // onload() finished with an empty vault: nothing sampled yet.
      expect(state?.autoSuggestProvider ?? null).toBeNull();
      // The vault scan completes, then Obsidian fires onLayoutReady.
      for (let i = 0; i < 5; i++) {
        setMockFile(`Notes/n${i}.md`, "これは日本語のノートです。".repeat(20));
      }
      for (const cb of ready) cb();
      await new Promise((r) => setTimeout(r, 20));
      expect(state?.autoSuggestProvider).toBe("embedding-gemma-300m");
    } finally {
      await state?.teardown();
      resetMockVault();
    }
  });

  test("an ASCII vault leaves the suggestion unset", async () => {
    resetMockVault();
    const { plugin, ready } = deferredLayoutPlugin();
    const state = await wireSemanticSearch(plugin);
    try {
      setMockFile("Notes/a.md", "plain ascii text ".repeat(40));
      for (const cb of ready) cb();
      await new Promise((r) => setTimeout(r, 20));
      expect(state?.autoSuggestProvider ?? null).toBeNull();
    } finally {
      await state?.teardown();
      resetMockVault();
    }
  });
});

/**
 * The lazy native indexer start and its vault events. No model is ever
 * loaded: the vault in these tests holds either nothing to embed or
 * only files whose stored mtime already matches. Tests wait on the
 * indexer's own calls, never on a clock.
 */
describe("wireSemanticSearch — indexer start and vault events", () => {
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** A plugin whose vault adapter is in memory, and the layout callbacks it is holding back. */
  function host(initial: Record<string, unknown> = {}) {
    resetMockVault();
    const mem = memAdapter();
    let data: Record<string, unknown> = initial;
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
    app.vault.adapter = mem.adapter;
    app.vault.configDir = ".obsidian";
    (plugin.manifest as { dir?: string }).dir = "/p";
    const barrier: Array<() => void> = [];
    return {
      plugin,
      mem,
      /** From now on, layout-ready callbacks wait until `ready()`. */
      holdLayout: () => {
        app.workspace.onLayoutReady = (cb) => {
          barrier.push(cb);
        };
      },
      ready: () => {
        for (const cb of barrier.splice(0)) cb();
      },
    };
  }

  /**
   * Counts `start()` calls and keeps the promise of the latest one.
   * `startWith` replaces the real start, say with one that fails.
   * `nextStop()` resolves once the next `stop()` has finished and its
   * caller has run on.
   */
  function watchIndexer(
    indexer: SemanticIndexer,
    startWith?: () => Promise<void>,
  ) {
    const start = indexer.start.bind(indexer);
    const stop = indexer.stop.bind(indexer);
    const waiting: Array<() => void> = [];
    let starts = 0;
    let latest: Promise<void> | undefined;
    indexer.start = (opts) => {
      starts += 1;
      latest = startWith ? startWith() : start(opts);
      return latest;
    };
    indexer.stop = async () => {
      try {
        await stop();
      } finally {
        waiting.shift()?.();
      }
    };
    return {
      starts: () => starts,
      latest: () => latest,
      nextStop: () =>
        new Promise<void>((resolve) => waiting.push(resolve)).then(turn),
    };
  }

  const fakeTFile = (path: string, extension: string): TFile => {
    const f = Object.create(TFile.prototype) as TFile;
    Object.assign(f, { path, extension });
    return f;
  };

  test("the first index pass waits for the host's vault listing: a search before it prunes nothing, after it prunes what is missing", async () => {
    const h = host();
    const record = (filePath: string): EmbeddingRecord => ({
      chunkId: `${filePath}#0`,
      filePath,
      offset: 0,
      heading: null,
      contentHash: "h",
      vector: new Float32Array(384),
    });
    // A session that left records for a note still in the vault and one
    // that is gone. The mtime of the note matches its stat in the mock
    // vault, so the next pass skips it instead of embedding it.
    const earlier = await wireSemanticSearch(h.plugin);
    await earlier!.store!.init();
    await earlier!.store!.upsert([record("Notes/a.md"), record("Gone/b.md")]);
    earlier!.store!.setMtime("Notes/a.md", 0);
    await earlier!.store!.flush();
    await earlier!.teardown();

    // The next session starts while the host is still listing the vault:
    // nothing is listed yet, and layout-ready is a barrier.
    h.holdLayout();
    const state = await wireSemanticSearch(h.plugin);
    const watch = watchIndexer(state!.indexer!);
    const store = state!.store!;
    await store.init();
    try {
      state?.startIndexerIfNeeded?.();
      await turn();
      expect(watch.starts()).toBe(0);
      expect(store.hasRecords("Notes/a.md")).toBe(true);
      expect(store.hasRecords("Gone/b.md")).toBe(true);

      // The listing completes, then the host says so.
      setMockFile("Notes/a.md", "# Title\n");
      h.ready();
      await turn();
      await watch.latest();
      expect(watch.starts()).toBe(1);
      expect(store.hasRecords("Notes/a.md")).toBe(true);
      expect(store.hasRecords("Gone/b.md")).toBe(false);
    } finally {
      await state?.teardown();
    }
  });

  test("a failed indexer start is retried by a later call, not latched until restart", async () => {
    const h = host();
    let now = 0;
    const state = await wireSemanticSearch(h.plugin, { now: () => now });
    const watch = watchIndexer(state!.indexer!, () =>
      Promise.reject(new Error("offline")),
    );
    try {
      // Two calls in the same tick are one start.
      const failed = watch.nextStop();
      state?.startIndexerIfNeeded?.();
      state?.startIndexerIfNeeded?.();
      expect(state?.nativeIndexBuildInProgress).toBe(true);
      await failed;
      expect(watch.starts()).toBe(1);
      expect(state?.nativeIndexBuildInProgress).toBe(false);

      // The failure did not disable search: once the wait is over the
      // next call starts again.
      now = 30_000;
      const failedAgain = watch.nextStop();
      state?.startIndexerIfNeeded?.();
      expect(state?.nativeIndexBuildInProgress).toBe(true);
      await failedAgain;
      expect(watch.starts()).toBe(2);
      expect(state?.nativeIndexBuildInProgress).toBe(false);
    } finally {
      await state?.teardown();
    }
  });

  test("repeated failed starts wait 30 s, doubling to a 10 minute cap, and a call that waits claims no build", async () => {
    const h = host();
    let now = 0;
    const state = await wireSemanticSearch(h.plugin, { now: () => now });
    const watch = watchIndexer(state!.indexer!, () =>
      Promise.reject(new Error("offline")),
    );
    try {
      let failedAt = 0;
      let starts = 0;
      for (const wait of [
        30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
      ]) {
        now = failedAt;
        const failed = watch.nextStop();
        state?.startIndexerIfNeeded?.();
        await failed;
        starts += 1;
        expect(watch.starts()).toBe(starts);

        // Until the wait is over a call starts nothing, and a search that
        // sees the state is not told a build is running.
        now = failedAt + wait - 1;
        state?.startIndexerIfNeeded?.();
        await turn();
        expect(watch.starts()).toBe(starts);
        expect(state?.nativeIndexBuildInProgress).toBe(false);
        failedAt += wait;
      }
    } finally {
      await state?.teardown();
    }
  });

  test("a start that is still running is not started again", async () => {
    const h = host();
    const state = await wireSemanticSearch(h.plugin);
    let fail!: () => void;
    const watch = watchIndexer(
      state!.indexer!,
      () =>
        new Promise<void>((_, reject) => {
          fail = () => reject(new Error("stop"));
        }),
    );
    try {
      state?.startIndexerIfNeeded?.();
      await turn();
      state?.startIndexerIfNeeded?.();
      await turn();
      expect(watch.starts()).toBe(1);
      expect(state?.nativeIndexBuildInProgress).toBe(true);
    } finally {
      const stopped = watch.nextStop();
      fail();
      await stopped;
      await state?.teardown();
    }
  });

  test("a teardown before the host is ready keeps the pending first pass from starting", async () => {
    const h = host();
    h.holdLayout();
    const state = await wireSemanticSearch(h.plugin);
    const watch = watchIndexer(state!.indexer!);
    state?.startIndexerIfNeeded?.();
    await turn();
    await state?.teardown();
    h.ready();
    await turn();
    expect(watch.starts()).toBe(0);
  });

  test("teardown waits for a manual rebuild started before any search, and no store write follows it", async () => {
    const h = host();
    const record = (filePath: string): EmbeddingRecord => ({
      chunkId: `${filePath}#0`,
      filePath,
      offset: 0,
      heading: null,
      contentHash: "h",
      vector: new Float32Array(384),
    });
    const state = await wireSemanticSearch(h.plugin);
    const store = state!.store!;
    await store.init();
    // A record for a note that is not in the vault: the rebuild prunes it.
    await store.upsert([record("Gone/b.md")]);

    const realPurge = store.purge.bind(store);
    let parked!: () => void;
    const purgeReached = new Promise<void>((resolve) => (parked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    store.purge = async (isExcluded) => {
      parked();
      await released;
      return realPurge(isExcluded);
    };
    let tornDown = false;
    let lateWrites = 0;
    for (const name of ["upsert", "delete", "flush", "setMtime"] as const) {
      const real = (store[name] as (...a: never[]) => unknown).bind(store);
      (store as unknown as Record<string, unknown>)[name] = (
        ...args: never[]
      ) => {
        if (tornDown) lateWrites += 1;
        return real(...args);
      };
    }

    // What the settings "Rebuild" button does, with no search before it.
    let rebuildDone = false;
    const rebuilt = state!.indexer!.rebuildAll().then(() => {
      rebuildDone = true;
    });
    await purgeReached;
    let tearDownDone = false;
    const tearing = state!.teardown().then(() => {
      tearDownDone = true;
      tornDown = true;
    });
    for (let i = 0; i < 3; i++) await turn();
    expect(tearDownDone).toBe(false);

    release();
    await rebuilt;
    await tearing;
    expect(rebuildDone).toBe(true);
    for (let i = 0; i < 3; i++) await turn();
    expect(lateWrites).toBe(0);
  });

  test("a teardown before the host is ready keeps a deferred DLC start from running", async () => {
    // An active provider whose store already holds records is subscribed
    // to vault events once the layout is ready.
    const h = host({ semanticSearch: { provider: "embedding-gemma" } });
    seedStore(h.mem, "embedding-gemma-300m", FORMAT_VERSION, 3);
    h.holdLayout();
    const state = await wireSemanticSearch(h.plugin);
    const dlc = state!.dlcIndexers!.get("embedding-gemma-300m")!;
    expect(dlc).toBeDefined();
    const watch = watchIndexer(dlc);

    await state?.teardown();
    h.ready();
    await turn();
    expect(watch.starts()).toBe(0);
    // No subscription was installed: a vault event schedules nothing.
    fireMockVaultEvent("modify", fakeTFile("Notes/a.md", "md"));
    expect(dlc.pending()).toBe(0);

    // A rebuild asked for after teardown builds no indexer either.
    state?.startRebuildFor?.("embedding-gemma-300m");
    expect(state?.dlcIndexers?.size).toBe(0);
  });

  /**
   * Stands in for the DLC model: no pipeline is loaded. `embedded` lists
   * every text the indexer asked to embed, in order, and `chunked()` counts
   * the notes it read and chunked (the chunker asks the provider for its
   * token limit once per note). `gate` runs before each embed returns, to
   * park a rebuild at a chosen point.
   */
  function standInModel(gate?: () => Promise<void>) {
    const proto = Object.getPrototypeOf(
      createEmbeddingGemmaProvider(async () => {
        throw new Error("model not available in tests");
      }),
    ) as {
      embed: (texts: string[]) => Promise<Float32Array[]>;
      getMaxInputTokens: () => Promise<number>;
    };
    const embedded: string[] = [];
    const embed = spyOn(proto, "embed").mockImplementation(async (texts) => {
      embedded.push(...texts);
      await gate?.();
      return texts.map(() => new Float32Array(768));
    });
    const tokens = spyOn(proto, "getMaxInputTokens").mockResolvedValue(512);
    return {
      embedded,
      chunked: () => tokens.mock.calls.length,
      restore: () => {
        embed.mockRestore();
        tokens.mockRestore();
      },
    };
  }

  const DLC_KEY = "embedding-gemma-300m";
  const noteText = (name: string) =>
    `${name} ${"plain ascii text ".repeat(40)}`;
  const addNotes = (...names: string[]) => {
    names.forEach((name, i) => {
      setMockFile(`${name}.md`, noteText(name));
      setMockFileStat(`${name}.md`, { mtime: 100 + i });
    });
  };

  /**
   * Switches a session to the Gemma provider, starts its rebuild, and
   * tears the session down while the rebuild is parked on its first
   * embed. Returns the state, and what the rebuild's success path touched.
   */
  async function interruptRebuild(h: ReturnType<typeof host>) {
    let reached!: () => void;
    const embedReached = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const model = standInModel(async () => {
      if (!first) return;
      first = false;
      reached();
      await released;
    });
    const state = (await wireSemanticSearch(h.plugin))!;
    try {
      // What the settings UI does: persist the choice, keep the old
      // provider and show the banner until the index is built.
      await applySettings(h.plugin, state, {
        ...state.settings,
        provider: "embedding-gemma",
      });
      expect(state.pendingProvider).toBe(DLC_KEY);
      const providerBefore = state.provider;

      const swaps: unknown[] = [];
      const chooser = state.chooser!;
      state.chooser = (settings) => {
        swaps.push(settings);
        return chooser(settings);
      };
      const marked: string[] = [];
      const markReady = state.registry!.markReady.bind(state.registry);
      state.registry!.markReady = (key) => {
        marked.push(key);
        markReady(key);
      };
      state.startRebuildFor?.(DLC_KEY);
      const dlc = state.dlcIndexers!.get(DLC_KEY)!;
      let stopCalled!: () => void;
      const stopping = new Promise<void>((resolve) => (stopCalled = resolve));
      const stop = dlc.stop.bind(dlc);
      dlc.stop = () => {
        stopCalled();
        return stop();
      };

      await embedReached;
      const tearing = state.teardown();
      await stopping;
      release();
      await tearing;
      for (let i = 0; i < 3; i++) await turn();
      return {
        state,
        providerBefore,
        swaps,
        marked,
        embedded: model.embedded,
      };
    } finally {
      model.restore();
    }
  }

  test("a DLC rebuild cut short by teardown is not marked ready or swapped in", async () => {
    const h = host();
    addNotes("A", "B", "C");
    const run = await interruptRebuild(h);
    // The rebuild reached the first note only.
    expect(run.embedded.some((t) => t.startsWith("A "))).toBe(true);
    expect(run.embedded.some((t) => t.startsWith("B "))).toBe(false);

    expect(run.marked).toEqual([]);
    expect(run.state.pendingProvider).toBe(DLC_KEY);
    expect(run.swaps).toEqual([]);
    expect(run.state.provider).toBe(run.providerBefore);
  });

  test("a teardown that starts while a finished DLC rebuild is flushing waits for it, and nothing is marked ready or written after it", async () => {
    const h = host();
    addNotes("A");
    const model = standInModel();
    const state = (await wireSemanticSearch(h.plugin))!;
    try {
      await applySettings(h.plugin, state, {
        ...state.settings,
        provider: "embedding-gemma",
      });
      expect(state.pendingProvider).toBe(DLC_KEY);
      const providerBefore = state.provider;
      const swaps: unknown[] = [];
      const chooser = state.chooser!;
      state.chooser = (settings) => {
        swaps.push(settings);
        return chooser(settings);
      };
      const marked: string[] = [];
      const markReady = state.registry!.markReady.bind(state.registry);
      state.registry!.markReady = (key) => {
        marked.push(key);
        markReady(key);
      };

      // Learn when the rebuild itself is over: what follows is the
      // completion step, whose flush is parked below.
      let rebuildOver = false;
      const set = state.dlcIndexers!.set.bind(state.dlcIndexers!);
      state.dlcIndexers!.set = (key, indexer) => {
        const start = indexer.start.bind(indexer);
        indexer.start = (opts) =>
          start(opts).finally(() => {
            rebuildOver = true;
          });
        return set(key, indexer);
      };

      const store = state.registry!.storeFor(DLC_KEY, 768);
      let tornDown = false;
      let lateWrites = 0;
      let reached!: () => void;
      const flushReached = new Promise<void>((resolve) => (reached = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let parked = false;
      for (const name of ["upsert", "delete", "flush", "setMtime"] as const) {
        const real = (store[name] as (...a: never[]) => unknown).bind(store);
        (store as unknown as Record<string, unknown>)[name] = async (
          ...args: never[]
        ) => {
          if (name === "flush" && rebuildOver && !parked) {
            parked = true;
            reached();
            await released;
          }
          if (tornDown) lateWrites += 1;
          return real(...args);
        };
      }

      state.startRebuildFor?.(DLC_KEY);
      await flushReached;
      let tearDownDone = false;
      const tearing = state.teardown().then(() => {
        tearDownDone = true;
        tornDown = true;
      });
      for (let i = 0; i < 5; i++) await turn();
      // The flush is still in flight, so teardown must not have closed
      // the stores under it.
      expect(tearDownDone).toBe(false);

      release();
      await tearing;
      for (let i = 0; i < 3; i++) await turn();
      expect(lateWrites).toBe(0);
      expect(marked).toEqual([]);
      expect(swaps).toEqual([]);
      expect(state.pendingProvider).toBe(DLC_KEY);
      expect(state.provider).toBe(providerBefore);
    } finally {
      model.restore();
    }
  });

  test("the next session indexes the notes an interrupted DLC build never reached, and skips the ones it did", async () => {
    const h = host();
    addNotes("A", "B", "C");
    await interruptRebuild(h);

    // The store the interrupted session left is current and non-empty,
    // so the next session treats it as ready and subscribes to it.
    const model = standInModel();
    h.holdLayout();
    const state = await wireSemanticSearch(h.plugin);
    try {
      expect(state?.registry?.isReady(DLC_KEY)).toBe(true);
      const watch = watchIndexer(state!.dlcIndexers!.get(DLC_KEY)!);
      h.ready();
      await turn();
      await watch.latest();

      const store = state!.registry!.storeFor(DLC_KEY, 768);
      expect(store.hasRecords("A.md")).toBe(true);
      expect(store.hasRecords("B.md")).toBe(true);
      expect(store.hasRecords("C.md")).toBe(true);
      // The note the first session finished is neither read nor embedded.
      expect(model.chunked()).toBe(2);
      expect(model.embedded.map((t) => t.slice(0, 1)).sort()).toEqual([
        "B",
        "C",
      ]);
    } finally {
      model.restore();
      await state?.teardown();
    }
  });

  test("vault rename events reach the indexer for files only, with the old path", async () => {
    const h = host();
    const state = await wireSemanticSearch(h.plugin);
    try {
      const indexer = state!.indexer!;
      await indexer.start({ initialRebuild: false });

      // A folder (not a TFile) is ignored: its files get their own events.
      fireMockVaultEvent("rename", { path: "moved" }, "dir");
      expect(indexer.pending()).toBe(0);

      // A markdown file schedules both its old and its new path.
      fireMockVaultEvent("rename", fakeTFile("new.md", "md"), "old.md");
      expect(indexer.pending()).toBe(2);

      // Renamed away from markdown: only the old path still needs work.
      fireMockVaultEvent("rename", fakeTFile("a.txt", "txt"), "a.md");
      expect(indexer.pending()).toBe(3);
    } finally {
      await state?.teardown();
    }
  });
});
