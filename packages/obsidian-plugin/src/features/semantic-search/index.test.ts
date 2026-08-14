import { describe, expect, test, beforeEach } from "bun:test";
import type McpToolsPlugin from "$/main";
import {
  applySettings,
  refreshAutoProvider,
  setup,
  type SemanticSearchState,
} from "./index";
import {
  DEFAULT_SEMANTIC_SETTINGS,
  type SemanticSearchSettings,
} from "./types";

/**
 * Minimal plugin stub: only loadData + saveData are exercised by the
 * settings load path. Other McpToolsPlugin members are not touched
 * here. The provider/indexer test surface lives in the dedicated
 * service test files (T3-T10).
 */
function makePluginStub(initial: Record<string, unknown> = {}) {
  let storage: Record<string, unknown> = { ...initial };
  let saveCount = 0;
  const stub = {
    async loadData() {
      // Return a structuralClone-ish copy so callers cannot mutate
      // internal state by reference.
      return JSON.parse(JSON.stringify(storage));
    },
    async saveData(data: Record<string, unknown>) {
      saveCount += 1;
      storage = JSON.parse(JSON.stringify(data));
    },
  };
  return {
    plugin: stub as unknown as McpToolsPlugin,
    getSaveCount: () => saveCount,
    getStorage: () => storage,
  };
}

async function setupOrThrow(
  plugin: McpToolsPlugin,
): Promise<SemanticSearchState> {
  const result = await setup(plugin);
  if (!result.success) {
    throw new Error(`setup failed: ${result.error}`);
  }
  return result.state;
}

describe("semantic-search setup — settings load/merge/persist", () => {
  test("empty data.json → defaults persisted", async () => {
    const { plugin, getSaveCount, getStorage } = makePluginStub();
    const state = await setupOrThrow(plugin);

    expect(state.settings).toEqual(DEFAULT_SEMANTIC_SETTINGS);
    expect(getSaveCount()).toBe(1);
    expect(getStorage().semanticSearch).toEqual(DEFAULT_SEMANTIC_SETTINGS);
  });

  test("partial settings → merged with defaults and persisted", async () => {
    const { plugin, getSaveCount, getStorage } = makePluginStub({
      semanticSearch: { provider: "native" },
    });
    const state = await setupOrThrow(plugin);

    expect(state.settings.provider).toBe("native");
    expect(state.settings.indexingMode).toBe(
      DEFAULT_SEMANTIC_SETTINGS.indexingMode,
    );
    expect(state.settings.unloadModelWhenIdle).toBe(
      DEFAULT_SEMANTIC_SETTINGS.unloadModelWhenIdle,
    );
    // Merge writes back the completed object.
    expect(getSaveCount()).toBe(1);
    expect(getStorage().semanticSearch).toEqual(state.settings);
  });

  test("complete settings → no rewrite (idempotent load)", async () => {
    const fullSettings = {
      provider: "smart-connections" as const,
      indexingMode: "low-power" as const,
      unloadModelWhenIdle: false,
    };
    const { plugin, getSaveCount } = makePluginStub({
      semanticSearch: fullSettings,
    });
    const state = await setupOrThrow(plugin);

    expect(state.settings).toEqual(fullSettings);
    expect(getSaveCount()).toBe(0); // no persist needed
  });

  test("malformed settings → fallback defaults + log, persist sanitized", async () => {
    const { plugin, getSaveCount, getStorage } = makePluginStub({
      semanticSearch: {
        provider: "telepathy",
        indexingMode: 42,
        unloadModelWhenIdle: "yes",
      },
    });
    const state = await setupOrThrow(plugin);

    expect(state.settings).toEqual(DEFAULT_SEMANTIC_SETTINGS);
    expect(getSaveCount()).toBe(1);
    expect(getStorage().semanticSearch).toEqual(DEFAULT_SEMANTIC_SETTINGS);
  });

  test("preserves unrelated keys in data.json", async () => {
    const { plugin, getStorage } = makePluginStub({
      commandPermissions: { enabled: true, allowlist: ["editor:toggle-bold"] },
      toolToggle: { disabled: ["fetch"] },
    });
    await setupOrThrow(plugin);

    const storage = getStorage() as Record<string, unknown>;
    expect(storage.commandPermissions).toEqual({
      enabled: true,
      allowlist: ["editor:toggle-bold"],
    });
    expect(storage.toolToggle).toEqual({ disabled: ["fetch"] });
    expect(storage.semanticSearch).toEqual(DEFAULT_SEMANTIC_SETTINGS);
  });

  test("setup without factoryDeps returns a NoopProvider (isReady=false, search throws, chooser=null)", async () => {
    const { plugin } = makePluginStub();
    const state = await setupOrThrow(plugin);

    expect(state.provider.isReady()).toBe(false);
    expect(state.chooser).toBeNull();
    await expect(state.provider.search("anything", {})).rejects.toThrow(
      /not configured/i,
    );
  });

  test("two concurrent setups serialize via the mutex (no lost updates)", async () => {
    // 35-way concurrency lives with T9 (the live indexer is the real
    // multi-writer surface). For T2, asserting that two parallel
    // setup() calls produce identical, non-corrupt state is enough
    // to validate the lock contract for the load path.
    const { plugin } = makePluginStub({
      semanticSearch: { provider: "native" },
    });
    const [a, b] = await Promise.all([
      setupOrThrow(plugin),
      setupOrThrow(plugin),
    ]);

    expect(a.settings).toEqual(b.settings);
    expect(a.settings.provider).toBe("native");
    expect(a.settings.indexingMode).toBe(
      DEFAULT_SEMANTIC_SETTINGS.indexingMode,
    );
  });
});

describe("semantic-search setup — provider factory integration (T8)", () => {
  test("with factoryDeps the provider is constructed via the chooser", async () => {
    const { plugin } = makePluginStub({
      semanticSearch: { provider: "native" },
    });
    // Lazily import the test helpers so this describe block stays
    // self-contained and the providerFactory dep is exercised end-
    // to-end. The factory + its deps are tested in isolation in
    // services/providerFactory.test.ts; here we only check that the
    // setup wires them through.
    const { createEmbeddingStore } = await import("./services/store");
    const memFiles = new Map<string, string>();
    const memBins = new Map<string, ArrayBuffer>();
    const adapter = {
      async exists(p: string) {
        return memFiles.has(p) || memBins.has(p);
      },
      async read(p: string) {
        const v = memFiles.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
      },
      async write(p: string, d: string) {
        memFiles.set(p, d);
      },
      async readBinary(p: string) {
        const v = memBins.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v.slice(0);
      },
      async writeBinary(p: string, d: ArrayBuffer) {
        memBins.set(p, d.slice(0));
      },
      async remove(p: string) {
        memFiles.delete(p);
        memBins.delete(p);
      },
      async mkdir() {},
    };
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: 4,
    });
    await store.init();

    const embedder = {
      embed: async () => new Float32Array(4),
      embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array(4)),
      unload: async () => undefined,
      isLoaded: () => true,
    };

    const result = await setup(plugin, {
      factoryDeps: { plugin, embedder, store },
    });
    if (!result.success) throw new Error(result.error);

    // settings.provider === "native" → NativeProvider, which is
    // ready by contract (returns [] on empty store).
    expect(result.state.chooser).not.toBeNull();
    expect(result.state.provider.isReady()).toBe(true);
    const out = await result.state.provider.search("anything", {});
    expect(out).toEqual([]);
  });

  test("chooser swap on a settings-style change yields a different provider instance", async () => {
    const { plugin } = makePluginStub({
      semanticSearch: { provider: "native" },
    });
    const { createEmbeddingStore } = await import("./services/store");
    const adapter = {
      async exists() {
        return false;
      },
      async read() {
        throw new Error("nope");
      },
      async write() {
        return undefined;
      },
      async readBinary() {
        throw new Error("nope");
      },
      async writeBinary() {
        return undefined;
      },
      async remove() {
        return undefined;
      },
      async mkdir() {},
    };
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: 4,
    });
    await store.init();

    const embedder = {
      embed: async () => new Float32Array(4),
      embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array(4)),
      unload: async () => undefined,
      isLoaded: () => true,
    };

    // Plugin without smart-connections so the auto branch resolves
    // to native and the smart-connections branch surfaces an error.
    const result = await setup(plugin, {
      factoryDeps: { plugin, embedder, store },
    });
    if (!result.success) throw new Error(result.error);
    const initial = result.state.provider;

    const swapped = result.state.chooser?.({
      ...result.state.settings,
      provider: "smart-connections",
    });
    expect(swapped).toBeDefined();
    expect(swapped).not.toBe(initial);
  });
});

describe("applySettings — UI swap path (T12)", () => {
  test("persists settings to data.json under the mutex", async () => {
    const { plugin, getStorage } = makePluginStub();
    const state = await setupOrThrow(plugin);
    const next: SemanticSearchSettings = {
      provider: "native",
      indexingMode: "low-power",
      unloadModelWhenIdle: false,
    };

    await applySettings(plugin, state, next);

    expect(state.settings).toEqual(next);
    expect(getStorage().semanticSearch).toEqual(next);
  });

  test("swaps the live provider via the chooser when one exists", async () => {
    const { plugin } = makePluginStub();
    const { createEmbeddingStore } = await import("./services/store");
    const adapter = {
      async exists() {
        return false;
      },
      async read(): Promise<string> {
        throw new Error("nope");
      },
      async write() {
        return;
      },
      async readBinary(): Promise<ArrayBuffer> {
        throw new Error("nope");
      },
      async writeBinary() {
        return;
      },
      async remove() {
        return;
      },
      async mkdir() {},
    };
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: 4,
    });
    await store.init();
    const embedder = {
      embed: async () => new Float32Array(4),
      embedBatch: async (ts: string[]) => ts.map(() => new Float32Array(4)),
      unload: async () => undefined,
      isLoaded: () => true,
    };

    const result = await setup(plugin, {
      factoryDeps: { plugin, embedder, store },
    });
    if (!result.success) throw new Error(result.error);
    const initial = result.state.provider;

    await applySettings(plugin, result.state, {
      ...result.state.settings,
      provider: "smart-connections",
    });

    expect(result.state.provider).not.toBe(initial);
    expect(result.state.settings.provider).toBe("smart-connections");
  });

  test("without chooser the provider stays NoopProvider but settings still persist", async () => {
    const { plugin, getStorage } = makePluginStub();
    const state = await setupOrThrow(plugin);
    const initialProvider = state.provider;

    await applySettings(plugin, state, {
      ...state.settings,
      provider: "native",
    });

    expect(state.provider).toBe(initialProvider); // unchanged (NoopProvider)
    expect(state.settings.provider).toBe("native");
    expect((getStorage().semanticSearch as { provider: string }).provider).toBe(
      "native",
    );
  });

  test("DLC: embedding-gemma with store not ready sets pendingProvider and keeps old provider", async () => {
    const { plugin } = makePluginStub();
    const { createEmbeddingStore } = await import("./services/store");
    const { createEmbeddingStoreRegistry } =
      await import("./services/storeRegistry");
    const adapter = {
      async exists() {
        return false;
      },
      async read(): Promise<string> {
        throw new Error("nope");
      },
      async write() {
        return;
      },
      async readBinary(): Promise<ArrayBuffer> {
        throw new Error("nope");
      },
      async writeBinary() {
        return;
      },
      async remove() {
        return;
      },
      async mkdir() {},
    };
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: 4,
    });
    await store.init();
    const embedder = {
      embed: async () => new Float32Array(4),
      embedBatch: async (ts: string[]) => ts.map(() => new Float32Array(4)),
      unload: async () => undefined,
      isLoaded: () => true,
    };
    const registry = createEmbeddingStoreRegistry(adapter, "/p/embeddings");

    const result = await setup(plugin, {
      factoryDeps: { plugin, embedder, store, registry },
    });
    if (!result.success) throw new Error(result.error);
    result.state.registry = registry;
    const initialProvider = result.state.provider;

    await applySettings(plugin, result.state, {
      ...result.state.settings,
      provider: "embedding-gemma",
    });

    // Store not marked ready → pendingProvider set, live provider unchanged.
    expect(result.state.pendingProvider).toBe("embedding-gemma-300m");
    expect(result.state.provider).toBe(initialProvider);
    // #344: pendingProviderStartedAt set alongside pendingProvider, used by
    // search_vault_smart to estimate retryAfterSeconds.
    expect(result.state.pendingProviderStartedAt).toBeTypeOf("number");
  });

  test("DLC: embedding-gemma with store ready swaps provider and clears pendingProvider", async () => {
    const { plugin } = makePluginStub();
    const { createEmbeddingStore } = await import("./services/store");
    const { createEmbeddingStoreRegistry } =
      await import("./services/storeRegistry");
    const adapter = {
      async exists() {
        return false;
      },
      async read(): Promise<string> {
        throw new Error("nope");
      },
      async write() {
        return;
      },
      async readBinary(): Promise<ArrayBuffer> {
        throw new Error("nope");
      },
      async writeBinary() {
        return;
      },
      async remove() {
        return;
      },
      async mkdir() {},
    };
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: 4,
    });
    await store.init();
    const embedder = {
      embed: async () => new Float32Array(4),
      embedBatch: async (ts: string[]) => ts.map(() => new Float32Array(4)),
      unload: async () => undefined,
      isLoaded: () => true,
    };
    const registry = createEmbeddingStoreRegistry(adapter, "/p/embeddings");
    registry.markReady("embedding-gemma-300m");
    // Seed the gemma store so the chooser can build the NativeProvider.
    const gemmaStore = registry.storeFor("embedding-gemma-300m", 768);
    await gemmaStore.init();

    const fakeGemmaEp = {
      providerKey: "embedding-gemma-300m" as const,
      dimensions: 768,
      maxInputTokens: 512,
      getMaxInputTokens: async () => 2048,
      embed: async (texts: string[]) => texts.map(() => new Float32Array(768)),
      isAvailable: async () => true,
      getModelSizeBytes: () => 0,
    };

    const result = await setup(plugin, {
      factoryDeps: {
        plugin,
        embedder,
        store,
        registry,
        embeddingProviders: { "embedding-gemma-300m": fakeGemmaEp },
      },
    });
    if (!result.success) throw new Error(result.error);
    result.state.registry = registry;
    const initialProvider = result.state.provider;

    await applySettings(plugin, result.state, {
      ...result.state.settings,
      provider: "embedding-gemma",
    });

    expect(result.state.pendingProvider).toBeNull();
    expect(result.state.provider).not.toBe(initialProvider);
    // #344: cleared alongside pendingProvider in the ready-immediately branch.
    expect(result.state.pendingProviderStartedAt).toBeNull();
  });
});

/**
 * OMC-025 / #430. `wireSemanticSearch` caches the chooser's decision
 * synchronously during `onload()`, before `plugin.smartSearch` is ever
 * assigned — so "auto" always resolved to native regardless of how fast
 * Smart Connections loaded. `refreshAutoProvider` is the fix: re-run the
 * chooser once the binding actually lands.
 */
describe("refreshAutoProvider — re-selects auto once smartSearch binds (OMC-025, #430)", () => {
  function fixtureDeps() {
    const embedder = {
      embed: async () => new Float32Array(4),
      embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array(4)),
      unload: async () => undefined,
      isLoaded: () => true,
    };
    return { embedder };
  }

  // Same in-memory adapter idiom the T8 describe block above uses for
  // `createEmbeddingStore` — a real store, not a hand-rolled stand-in, so
  // `buildNative()`'s full construction path is exercised for real.
  async function fixtureStore() {
    const { createEmbeddingStore } = await import("./services/store");
    const memFiles = new Map<string, string>();
    const memBins = new Map<string, ArrayBuffer>();
    const adapter = {
      async exists(p: string) {
        return memFiles.has(p) || memBins.has(p);
      },
      async read(p: string) {
        const v = memFiles.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
      },
      async write(p: string, d: string) {
        memFiles.set(p, d);
      },
      async readBinary(p: string) {
        const v = memBins.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v.slice(0);
      },
      async writeBinary(p: string, d: ArrayBuffer) {
        memBins.set(p, d.slice(0));
      },
      async remove(p: string) {
        memFiles.delete(p);
        memBins.delete(p);
      },
      async mkdir() {},
    };
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: 4,
    });
    await store.init();
    return store;
  }

  test("smartSearch bound after setup: swaps auto from native to Smart Connections", async () => {
    const { plugin } = makePluginStub({
      semanticSearch: { provider: "auto" },
    });
    const { embedder } = fixtureDeps();
    const store = await fixtureStore();

    const result = await setup(plugin, {
      factoryDeps: { plugin, embedder, store },
    });
    if (!result.success) throw new Error(result.error);
    const state = result.state;

    // Before the binding: unavailable, so chooser already resolved to
    // native at setup() time. isReady() is unconditionally true for the
    // native provider, so this alone would not distinguish the two —
    // that is exactly why the reported bug was silent.
    const beforeRefresh = state.provider;
    expect(beforeRefresh.isReady()).toBe(true);

    // The binding this defect was missing: assigned asynchronously,
    // after chooser-time, exactly as main.ts's subscribe callback does.
    (
      plugin as unknown as { smartSearch: { search: () => never[] } }
    ).smartSearch = { search: () => [] };

    refreshAutoProvider(state);

    expect(state.provider).not.toBe(beforeRefresh);
    // Behavioral proof, not just a new instance of the same kind: the
    // Smart Connections provider reads `plugin.smartSearch` LIVE
    // (smartConnectionsProvider.ts), so removing the binding again must
    // flip isReady() to false — something a native provider can never do.
    expect(state.provider.isReady()).toBe(true);
    delete (plugin as unknown as { smartSearch?: unknown }).smartSearch;
    expect(state.provider.isReady()).toBe(false);
  });

  test('provider !== "auto": no-op even with smartSearch bound', async () => {
    const { plugin } = makePluginStub({
      semanticSearch: { provider: "native" },
    });
    const { embedder } = fixtureDeps();
    const store = await fixtureStore();

    const result = await setup(plugin, {
      factoryDeps: { plugin, embedder, store },
    });
    if (!result.success) throw new Error(result.error);
    const state = result.state;
    const before = state.provider;

    (
      plugin as unknown as { smartSearch: { search: () => never[] } }
    ).smartSearch = { search: () => [] };
    refreshAutoProvider(state);

    // Gated on "auto" specifically: every other setting is untouched by
    // this call, which is also what keeps it from ever reaching the DLC
    // pending-provider branch below.
    expect(state.provider).toBe(before);
  });

  test("no chooser (NoopProvider path): does not throw", async () => {
    const result = await setup(makePluginStub().plugin);
    if (!result.success) throw new Error(result.error);
    expect(result.state.chooser).toBeNull();
    expect(() => refreshAutoProvider(result.state)).not.toThrow();
  });

  test("does not touch a pending DLC swap, even under auto", async () => {
    const { plugin } = makePluginStub();
    const { createEmbeddingStore } = await import("./services/store");
    const { createEmbeddingStoreRegistry } =
      await import("./services/storeRegistry");
    const adapter = {
      async exists() {
        return false;
      },
      async read(): Promise<string> {
        throw new Error("nope");
      },
      async write() {
        return;
      },
      async readBinary(): Promise<ArrayBuffer> {
        throw new Error("nope");
      },
      async writeBinary() {
        return;
      },
      async remove() {
        return;
      },
      async mkdir() {},
    };
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: 4,
    });
    await store.init();
    const embedder = {
      embed: async () => new Float32Array(4),
      embedBatch: async (ts: string[]) => ts.map(() => new Float32Array(4)),
      unload: async () => undefined,
      isLoaded: () => true,
    };
    const registry = createEmbeddingStoreRegistry(adapter, "/p/embeddings");

    const result = await setup(plugin, {
      factoryDeps: { plugin, embedder, store, registry },
    });
    if (!result.success) throw new Error(result.error);
    result.state.registry = registry;
    const initialProvider = result.state.provider;

    // Puts the state into the exact condition this call must never
    // disturb: a DLC download in flight, old provider intentionally kept
    // live, per "DLC: embedding-gemma with store not ready ..." above.
    await applySettings(plugin, result.state, {
      ...result.state.settings,
      provider: "embedding-gemma",
    });
    expect(result.state.pendingProvider).toBe("embedding-gemma-300m");

    (
      plugin as unknown as { smartSearch: { search: () => never[] } }
    ).smartSearch = { search: () => [] };
    refreshAutoProvider(result.state);

    expect(result.state.pendingProvider).toBe("embedding-gemma-300m");
    expect(result.state.provider).toBe(initialProvider);
  });
});
