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
 *   provider="remote"              → NativeProvider backed by the store
 *                                    for the configured remote model
 *
 * For "embedding-gemma" and "multilingual-e5-base", `deps.registry`
 * and `deps.embeddingProviders` must be supplied; when absent the
 * factory falls back to the native provider (degraded but safe).
 *
 * "remote" resolves its store key through `deps.getRemoteProviderKey()`
 * rather than a constant, because the key encodes the configured model
 * and vector width, both of which can change while the plugin is
 * loaded. Reading it through a closure is what lets a settings change
 * take effect without a reload — a captured string would pin the
 * chooser to whatever was configured at startup.
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
 * Canonical list of the *bundled* provider keys — the ones whose store
 * directory name is known at compile time. Used for the startup
 * stale-format probe and the hidden-folder purge sweep.
 *
 * The remote provider is deliberately absent: its key is derived at
 * runtime from the configured model and width
 * (`remoteProviderKey(model, dims)`), so both call sites take the
 * active remote key as an extra argument instead.
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
  /**
   * Store key of the currently configured remote model, or null when
   * the remote block is incomplete (no server, no model, or no detected
   * width). Read on every chooser call — see the header.
   */
  getRemoteProviderKey?: () => string | null;
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
      case "remote": {
        const key = deps.getRemoteProviderKey?.() ?? null;
        const ep = key ? deps.embeddingProviders?.[key] : undefined;
        // Unconfigured, unreachable at load, or width not yet detected:
        // fall back to native rather than handing back a provider whose
        // store cannot be read. The settings UI is where the user learns
        // why; search keeps working meanwhile.
        if (!key || !ep || !deps.registry) return buildNative();
        // Width comes from the provider, not the settings block, so the
        // store is always opened at the same width the vectors were
        // written with.
        return buildNativeSearchProvider(
          ep,
          deps.registry.storeFor(key, ep.dimensions),
        );
      }
    }
  };
}
