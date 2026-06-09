/**
 * Provider factory — selects the active SemanticSearchProvider based
 * on the user's setting.
 *
 * Behavior matrix:
 *   provider="native"              → always NativeProvider (MiniLM)
 *   provider="smart-connections"   → always SmartConnectionsProvider
 *   provider="auto"                → SmartConnectionsProvider if SC
 *                                    is loaded, else NativeProvider
 *   provider="embedding-gemma"     → NativeProvider backed by the
 *                                    EmbeddingGemma 300M store
 *   provider="multilingual-e5-base"→ NativeProvider backed by the
 *                                    multilingual-e5-base store
 *
 * For "embedding-gemma" and "multilingual-e5-base", `deps.registry`
 * and `deps.embeddingProviders` must be supplied; when absent the
 * factory falls back to the native provider (degraded but safe).
 */

import type McpToolsPlugin from "$/main";
import type { SemanticSearchProvider } from "$/features/semantic-search";
import type { SemanticSearchSettings } from "$/features/semantic-search/types";
import type { EmbeddingProvider } from "$/features/semantic-search/types";
import { createNativeProvider, type ExcerptResolver } from "./nativeProvider";
import { createSmartConnectionsProvider } from "./smartConnectionsProvider";
import type { Embedder } from "./embedder";
import type { EmbeddingStore } from "./store";
import type { EmbeddingStoreRegistry } from "./storeRegistry";

/**
 * Canonical list of all known provider keys. Used by main.ts to scan
 * for stale per-provider index directories without hard-coding a
 * separate array.
 */
export const ALL_PROVIDER_KEYS = [
  "native-minilm-l6-v2",
  "embedding-gemma-300m",
  "multilingual-e5-base",
] as const;

export type ProviderKey = (typeof ALL_PROVIDER_KEYS)[number];

export type ProviderFactoryDeps = {
  plugin: McpToolsPlugin;
  embedder: Embedder;
  store: EmbeddingStore;
  excerptResolver?: ExcerptResolver;
  /** Required for "embedding-gemma" and "multilingual-e5-base" cases. */
  registry?: EmbeddingStoreRegistry;
  embeddingProviders?: Record<string, EmbeddingProvider>;
};

export type ProviderChooser = (
  settings: SemanticSearchSettings,
) => SemanticSearchProvider;

/**
 * Probe whether the Smart Connections plugin's SmartSearch surface
 * is loaded and ready to be called.
 */
export function isSmartConnectionsAvailable(plugin: McpToolsPlugin): boolean {
  const sc = (plugin as unknown as { smartSearch?: { search?: unknown } })
    .smartSearch;
  return typeof sc?.search === "function";
}

/**
 * Adapts an `EmbeddingProvider` to the `Embedder` interface expected
 * by `NativeProviderImpl`. Role is fixed to `"query"` since this
 * adapter is only used on the search path.
 */
function makeSearchEmbedder(provider: EmbeddingProvider): Embedder {
  return {
    embed: async (text: string): Promise<Float32Array> => {
      const vecs = await provider.embed([text], "query");
      return vecs[0];
    },
    embedBatch: async (texts: string[]): Promise<Float32Array[]> =>
      provider.embed(texts, "query"),
    unload: async () => {},
    isLoaded: () => true,
  };
}

export function createProviderFactory(
  deps: ProviderFactoryDeps,
): ProviderChooser {
  const buildNative = (): SemanticSearchProvider =>
    createNativeProvider({
      embedder: deps.embedder,
      store: deps.store,
      excerptResolver: deps.excerptResolver,
    });

  const buildSmart = (): SemanticSearchProvider =>
    createSmartConnectionsProvider(deps.plugin);

  const buildNativeSearchProvider = (
    ep: EmbeddingProvider,
    store: EmbeddingStore,
  ): SemanticSearchProvider =>
    createNativeProvider({
      embedder: makeSearchEmbedder(ep),
      store,
      excerptResolver: deps.excerptResolver,
    });

  return (settings) => {
    switch (settings.provider) {
      case "native":
        return buildNative();
      case "smart-connections":
        return buildSmart();
      case "auto":
        return isSmartConnectionsAvailable(deps.plugin)
          ? buildSmart()
          : buildNative();
      case "embedding-gemma": {
        const ep = deps.embeddingProviders?.["embedding-gemma-300m"];
        if (!ep || !deps.registry) return buildNative();
        return buildNativeSearchProvider(
          ep,
          deps.registry.storeFor("embedding-gemma-300m", 768),
        );
      }
      case "multilingual-e5-base": {
        const ep = deps.embeddingProviders?.["multilingual-e5-base"];
        if (!ep || !deps.registry) return buildNative();
        return buildNativeSearchProvider(
          ep,
          deps.registry.storeFor("multilingual-e5-base", 768),
        );
      }
    }
  };
}
