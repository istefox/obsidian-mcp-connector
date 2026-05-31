import { describe, expect, test } from "bun:test";
import {
  createProviderFactory,
  isSmartConnectionsAvailable,
  type ProviderFactoryDeps,
} from "./providerFactory";
import type McpToolsPlugin from "$/main";
import type { SemanticSearchSettings } from "$/features/semantic-search/types";
import type { EmbeddingProvider } from "$/features/semantic-search/types";
import type { Embedder } from "./embedder";
import { createEmbeddingStore, type VaultAdapter } from "./store";
import { createEmbeddingStoreRegistry } from "./storeRegistry";
import { SmartConnectionsUnavailableError } from "./smartConnectionsProvider";

const DIM = 4;

function fakeEmbedder(): Embedder {
  return {
    embed: async () => new Float32Array(DIM),
    embedBatch: async (texts) => texts.map(() => new Float32Array(DIM)),
    unload: async () => undefined,
    isLoaded: () => true,
  };
}

function memAdapter(): VaultAdapter {
  const files = new Map<string, string>();
  const bins = new Map<string, ArrayBuffer>();
  return {
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
      files.delete(p);
      bins.delete(p);
    },
    async mkdir() {},
  };
}

async function makeStore() {
  const store = createEmbeddingStore({
    adapter: memAdapter(),
    binPath: "/p/embeddings.bin",
    indexPath: "/p/embeddings.index.json",
    vectorDim: DIM,
  });
  await store.init();
  return store;
}

function pluginWithSmartSearch(present: boolean): McpToolsPlugin {
  return {
    smartSearch: present ? { search: async () => [] } : undefined,
  } as unknown as McpToolsPlugin;
}

async function makeDeps(scPresent: boolean): Promise<ProviderFactoryDeps> {
  return {
    plugin: pluginWithSmartSearch(scPresent),
    embedder: fakeEmbedder(),
    store: await makeStore(),
  };
}

const SETTINGS = {
  native: {
    provider: "native",
    indexingMode: "live",
    unloadModelWhenIdle: true,
  } as SemanticSearchSettings,
  smartConnections: {
    provider: "smart-connections",
    indexingMode: "live",
    unloadModelWhenIdle: true,
  } as SemanticSearchSettings,
  auto: {
    provider: "auto",
    indexingMode: "live",
    unloadModelWhenIdle: true,
  } as SemanticSearchSettings,
  embeddingGemma: {
    provider: "embedding-gemma",
    indexingMode: "live",
    unloadModelWhenIdle: true,
  } as SemanticSearchSettings,
  multilingualE5: {
    provider: "multilingual-e5-base",
    indexingMode: "live",
    unloadModelWhenIdle: true,
  } as SemanticSearchSettings,
};

function fakeEmbeddingProvider(dim: number): EmbeddingProvider {
  return {
    providerKey: `fake-${dim}d`,
    dimensions: dim,
    maxInputTokens: 512,
    getMaxInputTokens: async () => 512,
    embed: async (texts, _role) => texts.map(() => new Float32Array(dim)),
    isAvailable: async () => true,
    getModelSizeBytes: () => 0,
  };
}

async function makeDepsWithRegistry(
  scPresent: boolean,
): Promise<ProviderFactoryDeps> {
  const adapter = memAdapter();
  const registry = createEmbeddingStoreRegistry(adapter, "/plugin/embeddings");
  const gemmaStore = registry.storeFor("embedding-gemma-300m", 768);
  await gemmaStore.init();
  const e5Store = registry.storeFor("multilingual-e5-base", 768);
  await e5Store.init();

  return {
    plugin: pluginWithSmartSearch(scPresent),
    embedder: fakeEmbedder(),
    store: await makeStore(),
    registry,
    embeddingProviders: {
      "embedding-gemma-300m": fakeEmbeddingProvider(768),
      "multilingual-e5-base": fakeEmbeddingProvider(768),
    },
  };
}

describe("provider factory — chooser", () => {
  test("provider='native' returns a NativeProvider", async () => {
    const deps = await makeDeps(true);
    const choose = createProviderFactory(deps);
    const provider = choose(SETTINGS.native);
    // NativeProvider#isReady returns true regardless of store state.
    expect(provider.isReady()).toBe(true);
    // Empty store → empty search results, no error.
    const out = await provider.search("anything", {});
    expect(out).toEqual([]);
  });

  test("provider='smart-connections' returns SmartConnectionsProvider that errors on .search() when SC absent", async () => {
    const deps = await makeDeps(false);
    const choose = createProviderFactory(deps);
    const provider = choose(SETTINGS.smartConnections);
    expect(provider.isReady()).toBe(false);
    await expect(provider.search("q", {})).rejects.toBeInstanceOf(
      SmartConnectionsUnavailableError,
    );
  });

  test("provider='smart-connections' with SC present delegates correctly", async () => {
    const deps = await makeDeps(true);
    const choose = createProviderFactory(deps);
    const provider = choose(SETTINGS.smartConnections);
    expect(provider.isReady()).toBe(true);
    // The fake SC returns an empty array, so search resolves to [].
    const out = await provider.search("q", {});
    expect(out).toEqual([]);
  });

  test("provider='auto' with SC present picks SmartConnectionsProvider", async () => {
    const deps = await makeDeps(true);
    const choose = createProviderFactory(deps);
    const provider = choose(SETTINGS.auto);
    // SmartConnectionsProvider.isReady() === true when SC is present.
    expect(provider.isReady()).toBe(true);
    // Confirm it dispatches to SC by observing the call.
    let saw: string | undefined;
    (
      deps.plugin as unknown as {
        smartSearch: { search: (q: string) => Promise<unknown[]> };
      }
    ).smartSearch.search = async (q: string) => {
      saw = q;
      return [];
    };
    await provider.search("ping", {});
    expect(saw).toBe("ping");
  });

  test("provider='auto' with SC absent falls back to NativeProvider", async () => {
    const deps = await makeDeps(false);
    const choose = createProviderFactory(deps);
    const provider = choose(SETTINGS.auto);
    expect(provider.isReady()).toBe(true); // NativeProvider#isReady === true
    // NativeProvider will not throw SmartConnectionsUnavailableError;
    // it returns [] on an empty store.
    const out = await provider.search("anything", {});
    expect(out).toEqual([]);
  });

  test("settings change re-runs the chooser and yields a fresh provider", async () => {
    const deps = await makeDeps(true);
    const choose = createProviderFactory(deps);
    const a = choose(SETTINGS.native);
    const b = choose(SETTINGS.smartConnections);
    expect(a).not.toBe(b);
    // a is NativeProvider (always ready), b is SC (also ready here).
    expect(a.isReady()).toBe(true);
    expect(b.isReady()).toBe(true);

    // Move SC out of the picture and rerun the chooser with auto.
    (deps.plugin as unknown as { smartSearch?: unknown }).smartSearch =
      undefined;
    const c = choose(SETTINGS.auto);
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
    // With SC removed, auto resolves to native.
    expect(c.isReady()).toBe(true);
  });

  test("provider='embedding-gemma' returns a NativeProvider backed by gemma store", async () => {
    const deps = await makeDepsWithRegistry(false);
    const choose = createProviderFactory(deps);
    const provider = choose(SETTINGS.embeddingGemma);
    expect(provider.isReady()).toBe(true);
    const out = await provider.search("anything", {});
    expect(out).toEqual([]);
  });

  test("provider='multilingual-e5-base' returns a NativeProvider backed by e5 store", async () => {
    const deps = await makeDepsWithRegistry(false);
    const choose = createProviderFactory(deps);
    const provider = choose(SETTINGS.multilingualE5);
    expect(provider.isReady()).toBe(true);
    const out = await provider.search("anything", {});
    expect(out).toEqual([]);
  });

  test("embedding-gemma without registry falls back to native", async () => {
    const deps = await makeDeps(false);
    const choose = createProviderFactory(deps);
    const provider = choose(SETTINGS.embeddingGemma);
    // Falls back to NativeProvider (always ready).
    expect(provider.isReady()).toBe(true);
    const out = await provider.search("anything", {});
    expect(out).toEqual([]);
  });

  test("embedding-gemma query text uses 'query' role via the search embedder", async () => {
    const roles: string[] = [];
    const deps = await makeDepsWithRegistry(false);
    const ep = deps.embeddingProviders!["embedding-gemma-300m"]!;
    const origEmbed = ep.embed.bind(ep);
    ep.embed = async (texts, role) => {
      roles.push(role);
      return origEmbed(texts, role);
    };
    const choose = createProviderFactory(deps);
    const provider = choose(SETTINGS.embeddingGemma);
    await provider.search("hello", {});
    expect(roles).toEqual(["query"]);
  });
});

describe("isSmartConnectionsAvailable", () => {
  test("false when plugin.smartSearch is absent", () => {
    expect(isSmartConnectionsAvailable(pluginWithSmartSearch(false))).toBe(
      false,
    );
  });

  test("true when plugin.smartSearch.search is a function", () => {
    expect(isSmartConnectionsAvailable(pluginWithSmartSearch(true))).toBe(true);
  });

  test("false when smartSearch exists but search is not a function", () => {
    const plugin = {
      smartSearch: { search: "not-a-function" },
    } as unknown as McpToolsPlugin;
    expect(isSmartConnectionsAvailable(plugin)).toBe(false);
  });
});
