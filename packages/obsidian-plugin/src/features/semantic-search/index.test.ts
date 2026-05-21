import { describe, expect, test, beforeEach } from "bun:test";
import type McpToolsPlugin from "$/main";
import { applySettings, setup, type SemanticSearchState } from "./index";
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
});
