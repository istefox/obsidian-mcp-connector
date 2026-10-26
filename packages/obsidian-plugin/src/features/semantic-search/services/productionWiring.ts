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
import { pathPolicyFor } from "$/shared/policyProvider";
import type { PathPolicy } from "$/shared/pathPolicy";
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
  vectorRevisionFor,
  type EmbeddingStoreRegistry,
} from "./storeRegistry";
import {
  createEmbeddingGemmaProvider,
  EMBEDDING_GEMMA_BACKEND,
} from "./embeddingGemmaProvider";
import { createMultilingualE5Provider } from "./multilingualE5Provider";
import { detectNonAsciiRatio } from "./langDetect";
import type { VaultAdapter } from "./store";
import { FORMAT_VERSION, SEGMENT_COUNT } from "./store";
import {
  createLiveIndexer,
  createLowPowerIndexer,
  type SemanticIndexer,
  type VaultLike,
} from "./indexer";
import { makeChunkerForProvider } from "./chunker";
import {
  guardChooserWithPolicy,
  guardProviderWithPolicy,
} from "./policyGuardedProvider";
import type { ExcerptResolver } from "./nativeProvider";

/**
 * The live indexing path must see the SAME set of files as the rebuild
 * (`vault.getMarkdownFiles()`): only `.md`. Without this guard, a
 * `create`/`modify` for a PDF or other attachment is forwarded to the
 * indexer, which reads it as UTF-8 and embeds it as garbage (CPU spike +
 * polluted index).
 */
export function isIndexableFile(f: unknown): f is TFile {
  return f instanceof TFile && f.extension === "md";
}

/** First wait after a failed native first start, doubling up to the cap. */
const START_RETRY_BASE_MS = 30_000;
const START_RETRY_CAP_MS = 10 * 60_000;

export async function wireSemanticSearch(
  plugin: McpToolsPlugin,
  { now = Date.now }: { now?: () => number } = {},
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
          on: (
            event: string,
            handler: (f: unknown, oldPath?: unknown) => void,
          ) => EventRef;
        }
      ).on(event, (f: unknown, oldPath?: unknown) => {
        if (event === "rename") {
          // Files only, any extension: the indexer needs the old path
          // even when the new name is no longer markdown. Folders are
          // skipped, Obsidian also emits one `rename` per file inside.
          if (f instanceof TFile && typeof oldPath === "string") {
            handler(f.path, oldPath);
          }
          return;
        }
        if (isIndexableFile(f)) handler(f.path);
      });
      return () => plugin.app.vault.offref(ref);
    },
  };

  // Two independent exclusion lists, unioned (ADR-0020 §Consequences):
  // Obsidian's own `Files & Links → Excluded files` (RFC #238) and this
  // plugin's hidden-folder policy. Neither derives from the other, and a
  // file named by either never enters any embedding store — in the full
  // rebuild and in the live event listener alike. Built once here where
  // `app.metadataCache` is in scope, and injected into every indexer
  // below.
  //
  // The indexer runs outside a request (vault events, the onLayoutReady
  // rebuild, work deferred past a tool call), so it reads the vault-wide
  // policy explicitly. A shared embedding store must never inherit one
  // client's exclusions. That policy starts at deny-all until the first
  // successful settings read (ADR-0020 §D7). For a read that posture is a
  // safe refusal; for the index it would be a silent wipe, every file
  // skipped and the store rebuilt empty. This one resolving read, before
  // any indexer exists, is what keeps fail-closed from meaning
  // fail-destructive, and the only thing that does: no request refresh
  // runs before the indexer's first read. A *later* read failure is harmless: the
  // provider retains the last policy it resolved.
  const policyProvider = pathPolicyFor(plugin);
  await policyProvider.refresh();
  const isUserIgnored = createExclusionFilter(plugin.app);
  // Read per call, never captured: the list can change between two files
  // of the same rebuild.
  const ssIsExcluded = (path: string): boolean =>
    isUserIgnored(path) || policyProvider.vaultWide.isExcluded(path);

  const ssExcerpt: ExcerptResolver = async (path, offset, maxLen) => {
    const f = plugin.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return { excerpt: "", line: null };
    const text = await plugin.app.vault.cachedRead(f);
    // 0-indexed, matching the line convention get_vault_file_partial's
    // document-map mode already exposes externally.
    const line = text.slice(0, offset).split("\n").length - 1;
    return { excerpt: text.slice(offset, offset + maxLen), line };
  };

  const pluginDir =
    plugin.manifest.dir ??
    `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;

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
  // The dtype is per backend because transformers.js defaults to fp32
  // everywhere but WASM: 1.23 GB for Gemma and 1.11 GB for E5 on WebGPU
  // (#597). Gemma has a 4-bit build (~197 MB) that WebGPU supports; fp16
  // and q4f16 do not work for it. E5's q4 is 823 MB, so it keeps q8.
  const gemmaDownloader = createModelDownloader({
    innerFactory: realPipelineFactory,
    dtype: { wasm: "q8", webgpu: "q4" },
    // Gemma's vectors are wrong on WebGPU (ADR-0034).
    backend: EMBEDDING_GEMMA_BACKEND,
  });
  const gemmaProvider = createEmbeddingGemmaProvider(gemmaDownloader.factory);
  const e5Downloader = createModelDownloader({
    innerFactory: realPipelineFactory,
    dtype: { wasm: "q8", webgpu: "q8" },
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
    // All three, not only MiniLM's: the Gemma and e5 downloads are the
    // large ones, and showed no progress at all.
    state.downloaders = [
      { label: "MiniLM", downloader: nativeDownloader },
      { label: "EmbeddingGemma 300M", downloader: gemmaDownloader },
      { label: "Multilingual E5 base", downloader: e5Downloader },
    ];
    state.store = nativeStore;
    state.registry = registry;
    // DLC readiness came from the probe pass above (no store init);
    // the settings UI uses these counts while stores are still lazy.
    state.probedCounts = probedCounts;

    // Enforce the hidden-folder policy on every provider this state will
    // ever hold. The chooser is wrapped as well as the instance setup
    // already built from it, because the settings UI re-runs the chooser
    // on a provider swap and would otherwise install an unguarded
    // provider (see policyGuardedProvider's header).
    const policySource = () => policyProvider.current();
    if (state.chooser) {
      state.chooser = guardChooserWithPolicy(state.chooser, policySource);
    }
    state.provider = guardProviderWithPolicy(state.provider, policySource);

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
    let closed = false;
    // A start that keeps failing (say, one note the embedder always
    // chokes on) is retried by the next search, so the retries back off
    // instead of running a whole new attempt per search call.
    let failedStarts = 0;
    let retryNotBefore = 0;
    state.startIndexerIfNeeded = () => {
      if (indexerStarted || closed || now() < retryNotBefore) return;
      indexerStarted = true;
      // #344: mark the build in-flight before kicking it off so a
      // search_vault_smart call landing in this same tick already sees
      // the flag. Cleared on both success and failure — a failed build
      // must not permanently block search with a stale "still building"
      // signal.
      state.nativeIndexBuildInProgress = true;
      state.nativeIndexBuildStartedAt = now();
      // The first pass prunes records of files missing from the vault
      // listing, so it must not run on a partial listing. A search can
      // reach here before Obsidian has finished listing the vault.
      new Promise<void>((resolve) =>
        plugin.app.workspace.onLayoutReady(resolve),
      )
        .then(() => (closed ? undefined : indexer.start()))
        .catch(async (err) => {
          logger.error("semantic-search: indexer start failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          // Let the next search retry. A failed start (say, the model
          // download with no network) must not disable search until
          // restart. stop() first: start() returns at once on an indexer
          // that still thinks it is running, so a retry would build
          // nothing. Partial progress is flushed and kept.
          await indexer.stop().catch(() => {});
          failedStarts += 1;
          retryNotBefore =
            now() +
            Math.min(
              START_RETRY_BASE_MS * 2 ** (failedStarts - 1),
              START_RETRY_CAP_MS,
            );
          indexerStarted = false;
        })
        .finally(() => {
          state.nativeIndexBuildInProgress = false;
        });
    };

    // Language detection for multilingual provider suggestion (fire-and-forget).
    // Deferred to onLayoutReady: during onload() getMarkdownFiles() can be
    // empty or partial (Obsidian's vault scan is still in flight), so the
    // sample came out empty and the suggestion never fired, and the 50 file
    // reads ran inside plugin load. Only the settings tab reads the result.
    plugin.app.workspace.onLayoutReady(() => {
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
    // The finishing step of each rebuild that ran to the end (flush, mark
    // ready, provider swap). Teardown waits for these before it closes the
    // stores. Only this step is tracked, not the rebuild itself, which
    // settles once stop() has cut it short.
    const _completingRebuilds = new Set<Promise<void>>();
    const _rebuildErrors = new Map<string, string>();
    state.isRebuildingFor = (providerKey: string) =>
      _rebuildingProviders.has(providerKey);
    state.dlcRebuildErrors = _rebuildErrors;
    state.startRebuildFor = (providerKey: string) => {
      // After teardown nothing may build or start an indexer: it would
      // be untracked and keep receiving vault events.
      if (closed || _rebuildingProviders.has(providerKey)) return;
      _rebuildingProviders.add(providerKey);
      _rebuildErrors.delete(providerKey);
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
        .then(() => {
          // A rebuild that stop() cut short returns as if it had finished.
          // Only teardown stops a DLC indexer, so a closed wiring means the
          // index is partial: leave it unready and the banner up, and touch
          // nothing that teardown is closing. The next session finishes it.
          if (closed) return;
          const completion = (async () => {
            const dlcStore = registry.storeFor(providerKey, ep.dimensions);
            await dlcStore.flush();
            // Teardown may have started during the flush. It waits for this
            // step, but it must not find the provider swapped in behind it.
            if (closed) return;
            registry.markReady(providerKey);
            if (state.pendingProvider === providerKey) {
              state.pendingProvider = null;
              state.pendingProviderStartedAt = null;
            }
            if (state.chooser) {
              state.provider = state.chooser(state.settings);
            }
          })();
          _completingRebuilds.add(completion);
          return completion.finally(() => {
            _completingRebuilds.delete(completion);
          });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          _rebuildErrors.set(providerKey, message);
          logger.error("semantic-search: DLC rebuild failed", {
            providerKey,
            error: message,
          });
        })
        .finally(() => {
          _rebuildingProviders.delete(providerKey);
        });
    };

    // Auto-subscribe active DLC provider at plugin load when its
    // store already has content. Subscribes to vault events and runs the
    // session-start pass, as the native indexer does: files whose stored
    // mtime matches are skipped unread, so an index that an interrupted
    // build left partial is completed. Deferred to onLayoutReady to
    // match the same vault-scan-ready guarantee as the migration
    // auto-trigger below.
    const _autoSubscribeDlc = (
      providerKey: keyof typeof embeddingProviders,
    ): void => {
      if (state.dlcIndexers?.has(providerKey)) return;
      const dlcIndexer = buildDlcIndexer(providerKey);
      if (!dlcIndexer) return;
      state.dlcIndexers?.set(providerKey, dlcIndexer);
      plugin.app.workspace.onLayoutReady(() => {
        if (closed) return;
        dlcIndexer.start().catch((err) => {
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

    // Purge hook for the hidden-folder settings UI (ADR-0020 §D15).
    // Deliberately NOT subscribed to a settings event: the UI awaits
    // this, so a failed purge surfaces where the user just clicked
    // rather than in a log nobody reads.
    state.purgeExcludedFolders = async () => {
      // Refresh first. The UI has just written the list, and this is
      // also what brings the vault-wide policy — the one the indexer
      // reads — up to date for every file indexed from here on.
      const policy = await policyProvider.refresh();
      return purgeExcludedFromStores(registry, policy);
    };

    state.teardown = async () => {
      closed = true;
      // Always, not only after the first search: the settings "Rebuild"
      // button runs `rebuildAll()` on this indexer before any search has
      // started it, and stop() waits for that rebuild's writes.
      try {
        await indexer.stop();
      } catch {
        // best-effort
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
      // A rebuild that stop() cut short takes the closed path at once. One
      // that had already finished may be mid-flush, and closing the registry
      // under it would let it write after teardown. Nothing here holds it
      // up: its rebuild is over and only the flush is left.
      await Promise.allSettled([..._completingRebuilds]);
      // Release the models: the ONNX sessions live outside the JavaScript
      // heap and survive the plugin instance otherwise (ADR-0032).
      for (const [providerKey, ep] of Object.entries(embeddingProviders)) {
        try {
          await ep.unload?.();
        } catch (err) {
          logger.warn("semantic-search: provider unload failed", {
            providerKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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

    logger.info("semantic-search: started", {
      provider: state.settings.provider,
    });
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
 * Drop every embedding under a hidden folder, across every provider
 * store, and return how many paths were removed (ADR-0020 §D15).
 *
 * Extracted from the settings hook for the same reason
 * `probeAndWipeStaleStores` is: it is the destructive half, and it is
 * worth testing against an in-memory adapter rather than only through a
 * live plugin.
 *
 * Every provider is swept, not just the active one. A store the user
 * switched away from keeps its records, and "the folder is hidden unless
 * you switch back to the provider you used last month" is not a policy.
 * Smart Connections is the one index this cannot reach — it is
 * third-party and gets filtered at query time instead.
 */
export async function purgeExcludedFromStores(
  registry: EmbeddingStoreRegistry,
  policy: PathPolicy,
): Promise<number> {
  if (policy.isEmpty) return 0;
  let removed = 0;
  for (const key of ALL_PROVIDER_KEYS) {
    const store = registry.storeFor(key, PROVIDER_DIMS[key]);
    // Skip a store that is empty in memory AND absent on disk: probing
    // is a sidecar read, while initializing would pull the whole bin of
    // a provider this vault may never have used.
    if (store.size() === 0 && (await store.probe()) === null) continue;
    removed += await store.purge((path) => policy.isExcluded(path));
  }
  return removed;
}

/**
 * Probe each provider's store via its cheap metadata sidecar (never the
 * bin), mark current non-empty stores ready, and silently wipe stores
 * whose on-disk format predates FORMAT_VERSION or whose vectors predate
 * the provider's vector revision. Embedding data is fully
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
    // Older layout, or vectors an earlier build of this provider made.
    if (
      probed.version < FORMAT_VERSION ||
      (probed.version === FORMAT_VERSION &&
        probed.revision < vectorRevisionFor(key))
    ) {
      staleKeys.push(key);
    } else if (
      probed.version === FORMAT_VERSION &&
      probed.revision === vectorRevisionFor(key) &&
      probed.recordCount > 0
    ) {
      registry.markReady(key);
      probedCounts[key] = probed.recordCount;
    }
  }

  for (const key of staleKeys) {
    const dirPath = `${baseDir}/${key}`;
    try {
      // A stale store may be in the legacy single-pair layout, the
      // segmented layout, or (mid-migration) both — remove every
      // candidate file, tolerating absence.
      const targets = [
        `${dirPath}/embeddings.bin`,
        `${dirPath}/embeddings.index.json`,
        `${dirPath}/embeddings.index.json.writing`,
        `${dirPath}/mtimes.json`,
        `${dirPath}/embeddings.meta.json`,
      ];
      for (let seg = 0; seg < SEGMENT_COUNT; seg++) {
        targets.push(
          `${dirPath}/embeddings.seg${seg}.bin`,
          `${dirPath}/embeddings.seg${seg}.index.json`,
        );
      }
      for (const target of targets) {
        await adapter.remove(target).catch(() => {});
      }
    } catch (err) {
      logger.warn("semantic-search: failed to wipe stale index directory", {
        dir: dirPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { staleKeys, probedCounts };
}
