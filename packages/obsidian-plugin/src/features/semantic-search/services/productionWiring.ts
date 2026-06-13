/**
 * Phase 3 semantic-search production wiring, extracted from main.ts so
 * the index-format probe, the silent stale-store wipe, and the
 * provider/indexer construction are testable against a mock Obsidian
 * app instead of only running inside onload(). Behavior is unchanged:
 * onload() awaits this and assigns the returned state.
 */

import { type EventRef, Notice, TFile } from "obsidian";
import type McpToolsPlugin from "$/main";
import { logger } from "$/shared/logger";
import { SettingsStore } from "$/shared/settingsStore";
import { createExclusionFilter } from "$/shared/isUserIgnored";
import {
  setup as semanticSearchSetup,
  createModelDownloader,
  type SemanticSearchState,
} from "../index";
import { createEmbedder, realPipelineFactory } from "./embedder";
import { ALL_PROVIDER_KEYS, type ProviderKey } from "./providerFactory";
import {
  createNativeEmbeddingProvider,
  MAX_INPUT_TOKENS as NATIVE_MAX_INPUT_TOKENS,
} from "./nativeEmbeddingProvider";
import {
  createEmbeddingStoreRegistry,
  migrateV1FlatStore,
  type EmbeddingStoreRegistry,
} from "./storeRegistry";
import { createEmbeddingGemmaProvider } from "./embeddingGemmaProvider";
import { createMultilingualE5Provider } from "./multilingualE5Provider";
import { detectNonAsciiRatio } from "./langDetect";
import type { VaultAdapter } from "./store";
import { FORMAT_VERSION } from "./store";
import {
  createLiveIndexer,
  createLowPowerIndexer,
  type SemanticIndexer,
  type VaultLike,
} from "./indexer";
import { makeChunkerForProvider } from "./chunker";
import type { ExcerptResolver } from "./nativeProvider";

export async function wireSemanticSearch(
  plugin: McpToolsPlugin,
): Promise<SemanticSearchState | undefined> {
  const ssAdapter: VaultAdapter = {
    exists: (p) => plugin.app.vault.adapter.exists(p),
    read: (p) => plugin.app.vault.adapter.read(p),
    write: (p, d) => plugin.app.vault.adapter.write(p, d),
    readBinary: (p) => plugin.app.vault.adapter.readBinary(p),
    writeBinary: (p, d) => plugin.app.vault.adapter.writeBinary(p, d),
    remove: (p) => plugin.app.vault.adapter.remove(p),
    mkdir: (p) => plugin.app.vault.adapter.mkdir(p),
  };

  const ssVault: VaultLike = {
    getMarkdownFiles: () =>
      plugin.app.vault.getMarkdownFiles().map((f) => ({
        path: f.path,
        mtime: f.stat?.mtime,
      })),
    read: async (path) => {
      const f = plugin.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) {
        throw new Error(`semantic-search: not a file: ${path}`);
      }
      return plugin.app.vault.cachedRead(f);
    },
    getFileMtime: (path) => {
      const f = plugin.app.vault.getAbstractFileByPath(path);
      return f instanceof TFile ? f.stat?.mtime : undefined;
    },
    on: (event, handler) => {
      // Obsidian's vault.on signatures are event-specific. The
      // unsubscribe is offref(EventRef). Wrap so our VaultLike
      // contract stays clean.
      const ref = (
        plugin.app.vault as unknown as {
          on: (event: string, handler: (f: unknown) => void) => EventRef;
        }
      ).on(event, (f: unknown) => {
        if (f instanceof TFile) handler(f.path);
      });
      return () => plugin.app.vault.offref(ref);
    },
  };

  // Honour `Files & Links → Excluded files`: files the user has
  // excluded never enter any embedding store, in both the full
  // rebuild and the live event listener (RFC #238). Built once here
  // where `app.metadataCache` is in scope and injected into every
  // indexer below.
  const ssIsExcluded = createExclusionFilter(plugin.app);

  const ssExcerpt: ExcerptResolver = async (path, _offset, maxLen) => {
    const f = plugin.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return "";
    const text = await plugin.app.vault.cachedRead(f);
    return text.slice(_offset, _offset + maxLen);
  };

  const pluginDir =
    plugin.manifest.dir ?? `.obsidian/plugins/${plugin.manifest.id}`;

  // Migrate v1 flat store before constructing any registry entry.
  await migrateV1FlatStore(ssAdapter, pluginDir);

  // One cheap probe per provider replaces the three eager store
  // loads this block used to do (stale-version JSON parse, native
  // init, DLC size checks): it reads the meta sidecar (or the index
  // JSON once, for pre-sidecar stores), never the bin, so no vector
  // data sits in RAM for providers that may never be queried this
  // session. Stores init lazily on first indexer/search use.
  const embeddingsBaseDir = `${pluginDir}/embeddings`;
  const registry = createEmbeddingStoreRegistry(ssAdapter, embeddingsBaseDir);
  const { staleKeys: staleProviderKeys, probedCounts } =
    await probeAndWipeStaleStores(registry, ssAdapter, embeddingsBaseDir);

  if (staleProviderKeys.length > 0) {
    const wipedCount = staleProviderKeys.length;
    plugin.app.workspace.onLayoutReady(() => {
      new Notice(
        `MCP Tools: Semantic search index format upgraded (${wipedCount} provider${wipedCount > 1 ? "s" : ""} migrated). Rebuilding automatically.`,
        8000,
      );
    });
  }

  // Native MiniLM — always available (store loads lazily).
  const nativeDownloader = createModelDownloader({
    innerFactory: realPipelineFactory,
  });
  // Construction-time read: toggling the setting takes effect at
  // the next plugin reload (the settings UI says so).
  const semanticPrefs = ((await new SettingsStore(plugin).readSlice(
    "semanticSearch",
  )) ?? {}) as { unloadModelWhenIdle?: boolean };
  const embedder = createEmbedder({
    pipelineFactory: nativeDownloader.factory,
    maxInputTokens: NATIVE_MAX_INPUT_TOKENS,
    unloadWhenIdle: semanticPrefs.unloadModelWhenIdle === true,
  });
  const nativeEp = createNativeEmbeddingProvider(embedder);
  const nativeStore = registry.storeFor("native-minilm-l6-v2", 384);
  // No eager init: the indexer/search path inits on first use. The
  // native provider is always available, so it is always "ready".
  registry.markReady("native-minilm-l6-v2");

  // DLC providers — pipeline loads lazily on first embed call.
  const gemmaDownloader = createModelDownloader({
    innerFactory: realPipelineFactory,
    dtype: "q8",
  });
  const gemmaProvider = createEmbeddingGemmaProvider(gemmaDownloader.factory);
  const e5Downloader = createModelDownloader({
    innerFactory: realPipelineFactory,
    dtype: "q8",
  });
  const e5Provider = createMultilingualE5Provider(e5Downloader.factory);

  const embeddingProviders = {
    "embedding-gemma-300m": gemmaProvider,
    "multilingual-e5-base": e5Provider,
  };

  const semanticResult = await semanticSearchSetup(plugin, {
    factoryDeps: {
      plugin,
      embedder,
      store: nativeStore,
      excerptResolver: ssExcerpt,
      registry,
      embeddingProviders,
    },
  });

  if (semanticResult.success) {
    const state = semanticResult.state;
    state.downloader = nativeDownloader;
    state.store = nativeStore;
    state.registry = registry;
    // DLC readiness came from the probe pass above (no store init);
    // the settings UI uses these counts while stores are still lazy.
    state.probedCounts = probedCounts;

    // Native indexer — lazy start on first search tool call.
    // The chunker tracks the provider's effective max-input-tokens
    // (backend-resolved via getMaxInputTokens()), with a small safety
    // margin for the task-prompt prefix prepended at embed time.
    const nativeChunker = makeChunkerForProvider(nativeEp);
    const indexer =
      state.settings.indexingMode === "low-power"
        ? createLowPowerIndexer({
            vault: ssVault,
            chunker: nativeChunker,
            embedder: nativeEp,
            store: nativeStore,
            isExcluded: ssIsExcluded,
          })
        : createLiveIndexer({
            vault: ssVault,
            chunker: nativeChunker,
            embedder: nativeEp,
            store: nativeStore,
            isExcluded: ssIsExcluded,
          });
    state.indexer = indexer;

    let indexerStarted = false;
    state.startIndexerIfNeeded = () => {
      if (indexerStarted) return;
      indexerStarted = true;
      indexer.start().catch((err) => {
        logger.error("semantic-search: indexer start failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    // Language detection for multilingual provider suggestion (fire-and-forget).
    detectNonAsciiRatio(ssVault)
      .then((ratio) => {
        if (
          ratio > 0.3 &&
          state.settings.provider !== "embedding-gemma" &&
          state.settings.provider !== "multilingual-e5-base"
        ) {
          state.autoSuggestProvider = "embedding-gemma-300m";
        }
      })
      .catch(() => {
        // best-effort — non-ASCII sampling failure must not affect startup
      });

    // Map from `SemanticSearchSettings.provider` string to the
    // registry providerKey. Declared once here and reused by both the
    // auto-subscribe block below and the post-migration auto-rebuild
    // trigger further down.
    const settingToRegistryKey: Partial<Record<string, ProviderKey>> = {
      native: "native-minilm-l6-v2",
      auto: "native-minilm-l6-v2",
      "embedding-gemma": "embedding-gemma-300m",
      "multilingual-e5-base": "multilingual-e5-base",
      // "smart-connections" has no local store — no rebuild needed.
    };

    // Persistent DLC indexers — created on first rebuild or at
    // plugin-load auto-subscribe for the active provider. Each one
    // subscribes to vault create/modify/delete events so live edits
    // update the matching store without requiring a full rebuild.
    state.dlcIndexers = new Map<string, SemanticIndexer>();

    // Helper: build a fresh DLC indexer for a providerKey. Pure
    // construction — does not start / subscribe. Caller decides.
    const buildDlcIndexer = (
      providerKey: keyof typeof embeddingProviders,
    ): SemanticIndexer | null => {
      const ep = embeddingProviders[providerKey];
      if (!ep) return null;
      const dlcStore = registry.storeFor(providerKey, ep.dimensions);
      return createLiveIndexer({
        vault: ssVault,
        chunker: makeChunkerForProvider(ep),
        embedder: ep,
        store: dlcStore,
        isExcluded: ssIsExcluded,
      });
    };

    // DLC rebuild hook — download + full index for one provider.
    // First call creates the indexer and `start()`s it (subscribes +
    // initial rebuild). Subsequent calls reuse the live indexer and
    // run a fresh `rebuildAll()` against it; the subscription stays
    // intact so post-rebuild edits keep flowing.
    const _rebuildingProviders = new Set<string>();
    state.startRebuildFor = (providerKey: string) => {
      if (_rebuildingProviders.has(providerKey)) return;
      _rebuildingProviders.add(providerKey);
      const epKey = providerKey as keyof typeof embeddingProviders;
      const ep = embeddingProviders[epKey];
      if (!ep) {
        _rebuildingProviders.delete(providerKey);
        return;
      }

      const existing = state.dlcIndexers?.get(providerKey);
      const dlcIndexer = existing ?? buildDlcIndexer(epKey);
      if (!dlcIndexer) {
        _rebuildingProviders.delete(providerKey);
        return;
      }
      if (!existing) {
        state.dlcIndexers?.set(providerKey, dlcIndexer);
      }

      const work = existing ? dlcIndexer.rebuildAll() : dlcIndexer.start();

      work
        .then(async () => {
          const dlcStore = registry.storeFor(providerKey, ep.dimensions);
          await dlcStore.flush();
          registry.markReady(providerKey);
          if (state.pendingProvider === providerKey)
            state.pendingProvider = null;
          if (state.chooser) {
            state.provider = state.chooser(state.settings);
          }
        })
        .catch((err) => {
          logger.error("semantic-search: DLC rebuild failed", {
            providerKey,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          _rebuildingProviders.delete(providerKey);
        });
    };

    // Auto-subscribe active DLC provider at plugin load when its
    // store already has content. Skips the initial rebuild (existing
    // store is current) and only wires up vault event subscriptions
    // so future create/modify/delete events update the index live.
    // Deferred to onLayoutReady to match the same vault-scan-ready
    // guarantee as the migration auto-trigger below.
    const _autoSubscribeDlc = (
      providerKey: keyof typeof embeddingProviders,
    ): void => {
      if (state.dlcIndexers?.has(providerKey)) return;
      const dlcIndexer = buildDlcIndexer(providerKey);
      if (!dlcIndexer) return;
      state.dlcIndexers?.set(providerKey, dlcIndexer);
      plugin.app.workspace.onLayoutReady(() => {
        dlcIndexer.start({ initialRebuild: false }).catch((err) => {
          logger.error("semantic-search: DLC auto-subscribe failed", {
            providerKey,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    };

    for (const key of [
      "embedding-gemma-300m",
      "multilingual-e5-base",
    ] as const) {
      // Auto-subscribe only when the provider is currently active AND
      // its store is ready (probe pass found a current store with
      // records). Inactive providers stay dormant — the user can
      // switch into them, which routes through startRebuildFor and
      // lazily starts the indexer at that point.
      const isActive = settingToRegistryKey[state.settings.provider] === key;
      if (isActive && registry.isReady(key)) {
        _autoSubscribeDlc(key);
      }
    }

    // B3: Trigger rebuild for the active provider's store that was just
    // wiped by the migration. Deferred to onLayoutReady because
    // vault.getMarkdownFiles() can return an empty/partial snapshot
    // during onload() — Obsidian's vault scan is still in flight.
    // Firing earlier silently produces a 0-chunk rebuild and the .then()
    // flush writes an empty store.
    const activeRegistryKey = settingToRegistryKey[state.settings.provider];
    if (activeRegistryKey && staleProviderKeys.includes(activeRegistryKey)) {
      plugin.app.workspace.onLayoutReady(() => {
        if (activeRegistryKey === "native-minilm-l6-v2") {
          state.startIndexerIfNeeded?.();
        } else {
          state.startRebuildFor?.(activeRegistryKey);
        }
      });
    }

    state.teardown = async () => {
      if (indexerStarted) {
        try {
          await indexer.stop();
        } catch {
          // best-effort
        }
      }
      // Stop every persistent DLC indexer so its debounced flush
      // drains to disk before the plugin unloads.
      if (state.dlcIndexers) {
        for (const [providerKey, dlcIndexer] of state.dlcIndexers) {
          try {
            await dlcIndexer.stop();
          } catch (err) {
            logger.warn("semantic-search: DLC indexer stop failed", {
              providerKey,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        state.dlcIndexers.clear();
      }
      try {
        await embedder.unload();
      } catch {
        // best-effort
      }
      try {
        await registry.closeAll();
      } catch {
        // best-effort
      }
    };

    return state;
  } else {
    logger.error("Semantic search setup failed", {
      error: semanticResult.error,
    });
  }
  return undefined;
}

/** Vector dimensions per provider key. */
const PROVIDER_DIMS = {
  "native-minilm-l6-v2": 384,
  "embedding-gemma-300m": 768,
  "multilingual-e5-base": 768,
} as const satisfies Record<ProviderKey, number>;

/**
 * Probe each provider's store via its cheap metadata sidecar (never the
 * bin), mark current non-empty stores ready, and silently wipe stores
 * whose on-disk format predates FORMAT_VERSION. Embedding data is fully
 * re-derivable from the vault, so an upgrade wipe loses nothing and
 * needs no user confirmation. Extracted from wireSemanticSearch so this
 * (the riskiest startup path) is unit-testable with an in-memory adapter.
 */
export async function probeAndWipeStaleStores(
  registry: EmbeddingStoreRegistry,
  adapter: VaultAdapter,
  baseDir: string,
): Promise<{
  staleKeys: ProviderKey[];
  probedCounts: Partial<Record<ProviderKey, number>>;
}> {
  const staleKeys: ProviderKey[] = [];
  const probedCounts: Partial<Record<ProviderKey, number>> = {};
  for (const key of ALL_PROVIDER_KEYS) {
    const probed = await registry.storeFor(key, PROVIDER_DIMS[key]).probe();
    if (!probed) continue;
    if (probed.version < FORMAT_VERSION) {
      staleKeys.push(key);
    } else if (probed.version === FORMAT_VERSION && probed.recordCount > 0) {
      registry.markReady(key);
      probedCounts[key] = probed.recordCount;
    }
  }

  for (const key of staleKeys) {
    const dirPath = `${baseDir}/${key}`;
    try {
      await adapter.remove(`${dirPath}/embeddings.bin`);
      await adapter.remove(`${dirPath}/embeddings.index.json`);
      await adapter
        .remove(`${dirPath}/embeddings.index.json.writing`)
        .catch(() => {});
      await adapter.remove(`${dirPath}/mtimes.json`).catch(() => {});
      await adapter.remove(`${dirPath}/embeddings.meta.json`).catch(() => {});
    } catch (err) {
      logger.warn("semantic-search: failed to wipe stale index directory", {
        dir: dirPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { staleKeys, probedCounts };
}
