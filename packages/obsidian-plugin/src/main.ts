import { type EventRef, Notice, Plugin, TFile } from "obsidian";
import { lastValueFrom } from "rxjs";
import { type SmartConnections } from "shared";
import { globalSettingsMutex } from "./features/command-permissions";
import { checkCommandPermission as runCommandPermissionCheck } from "./features/command-permissions/services/checkCommandPermission";
import { SettingsStore } from "./shared/settingsStore";
import { setup as setupCore } from "./features/core";
import {
  setup as mcpTransportSetup,
  teardown as mcpTransportTeardown,
  type McpTransportState,
} from "./features/mcp-transport";
import {
  setup as promptsSetup,
  teardown as promptsTeardown,
  type PromptsFeatureState,
} from "./features/prompts";
import {
  setup as semanticSearchSetup,
  teardown as semanticSearchTeardown,
  createModelDownloader,
  type SemanticSearchState,
} from "./features/semantic-search";
import {
  createEmbedder,
  realPipelineFactory,
} from "./features/semantic-search/services/embedder";
import {
  ALL_PROVIDER_KEYS,
  type ProviderKey,
} from "./features/semantic-search/services/providerFactory";
import {
  createNativeEmbeddingProvider,
  MAX_INPUT_TOKENS as NATIVE_MAX_INPUT_TOKENS,
} from "./features/semantic-search/services/nativeEmbeddingProvider";
import {
  createEmbeddingStoreRegistry,
  migrateV1FlatStore,
} from "./features/semantic-search/services/storeRegistry";
import { createEmbeddingGemmaProvider } from "./features/semantic-search/services/embeddingGemmaProvider";
import { createMultilingualE5Provider } from "./features/semantic-search/services/multilingualE5Provider";
import { detectNonAsciiRatio } from "./features/semantic-search/services/langDetect";
import type { VaultAdapter } from "./features/semantic-search/services/store";
import { FORMAT_VERSION } from "./features/semantic-search/services/store";
import {
  createLiveIndexer,
  createLowPowerIndexer,
  type SemanticIndexer,
  type VaultLike,
} from "./features/semantic-search/services/indexer";
import { makeChunkerForProvider } from "./features/semantic-search/services/chunker";
import type { ExcerptResolver } from "./features/semantic-search/services/nativeProvider";
import { loadSmartSearchAPI } from "./shared";
import { logger } from "./shared/logger";
import { createExclusionFilter } from "./shared/isUserIgnored";

export default class McpToolsPlugin extends Plugin {
  mcpTransportState?: McpTransportState;

  promptsState?: PromptsFeatureState;

  semanticSearchState?: SemanticSearchState;

  /**
   * Resolved Smart Connections search API, populated best-effort at
   * onload from the reactive `loadSmartSearchAPI` loader. The
   * SmartConnectionsProvider + provider factory read this field to
   * decide readiness and to dispatch `search_vault_smart` queries when
   * the user picks the "smart-connections" (or "auto") provider.
   * Undefined until the loader resolves, or permanently if Smart
   * Connections is not installed (#99).
   */
  smartSearch?: SmartConnections.SmartSearch;

  /**
   * In-process permission check for `execute_obsidian_command`,
   * delegated to the testable service. The two-phase decision (Phase A
   * decide + fast-path audit, modal wait, Phase B persist) lives in
   * services/checkCommandPermission.ts.
   */
  async checkCommandPermission(
    rawCommandId: string,
  ): Promise<{ outcome: "allow" | "deny"; reason?: string }> {
    return runCommandPermissionCheck(
      { app: this.app, store: new SettingsStore(this) },
      rawCommandId,
    );
  }

  async onload() {
    // Initialize features in order
    await setupCore(this);

    // 0.4.0 HTTP transport — in-process MCP server.
    const mcpResult = await mcpTransportSetup(this);
    if (mcpResult.success) {
      this.mcpTransportState = mcpResult.state;
      const promptsResult = await promptsSetup(
        mcpResult.state.mcp.promptRegistry,
        this.app,
      );
      if (promptsResult.success) {
        this.promptsState = promptsResult.state;
      } else {
        logger.error("Prompts feature setup failed", {
          error: promptsResult.error,
        });
      }
    } else {
      new Notice(`MCP Connector: ${mcpResult.error}`);
      logger.error("MCP transport setup failed", { error: mcpResult.error });
    }

    // 0.4.0 semantic search — Phase 3 production wiring (T15).
    // Construct vault adapter, embedder (via model downloader),
    // store, indexer and excerpt resolver against the live Obsidian
    // app, then hand them to the feature setup as factoryDeps so
    // the provider factory yields a real provider matching the
    // user's tri-state setting.
    try {
      const ssAdapter: VaultAdapter = {
        exists: (p) => this.app.vault.adapter.exists(p),
        read: (p) => this.app.vault.adapter.read(p),
        write: (p, d) => this.app.vault.adapter.write(p, d),
        readBinary: (p) => this.app.vault.adapter.readBinary(p),
        writeBinary: (p, d) => this.app.vault.adapter.writeBinary(p, d),
        remove: (p) => this.app.vault.adapter.remove(p),
        mkdir: (p) => this.app.vault.adapter.mkdir(p),
      };

      const ssVault: VaultLike = {
        getMarkdownFiles: () =>
          this.app.vault.getMarkdownFiles().map((f) => ({
            path: f.path,
            mtime: f.stat?.mtime,
          })),
        read: async (path) => {
          const f = this.app.vault.getAbstractFileByPath(path);
          if (!(f instanceof TFile)) {
            throw new Error(`semantic-search: not a file: ${path}`);
          }
          return this.app.vault.cachedRead(f);
        },
        getFileMtime: (path) => {
          const f = this.app.vault.getAbstractFileByPath(path);
          return f instanceof TFile ? f.stat?.mtime : undefined;
        },
        on: (event, handler) => {
          // Obsidian's vault.on signatures are event-specific. The
          // unsubscribe is offref(EventRef). Wrap so our VaultLike
          // contract stays clean.
          const ref = (
            this.app.vault as unknown as {
              on: (event: string, handler: (f: unknown) => void) => EventRef;
            }
          ).on(event, (f: unknown) => {
            if (f instanceof TFile) handler(f.path);
          });
          return () => this.app.vault.offref(ref);
        },
      };

      // Honour `Files & Links → Excluded files`: files the user has
      // excluded never enter any embedding store, in both the full
      // rebuild and the live event listener (RFC #238). Built once here
      // where `app.metadataCache` is in scope and injected into every
      // indexer below.
      const ssIsExcluded = createExclusionFilter(this.app);

      const ssExcerpt: ExcerptResolver = async (path, _offset, maxLen) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) return "";
        const text = await this.app.vault.cachedRead(f);
        return text.slice(_offset, _offset + maxLen);
      };

      const pluginDir =
        this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;

      // Migrate v1 flat store before constructing any registry entry.
      await migrateV1FlatStore(ssAdapter, pluginDir);

      // One cheap probe per provider replaces the three eager store
      // loads this block used to do (stale-version JSON parse, native
      // init, DLC size checks): it reads the meta sidecar (or the index
      // JSON once, for pre-sidecar stores), never the bin, so no vector
      // data sits in RAM for providers that may never be queried this
      // session. Stores init lazily on first indexer/search use.
      const embeddingsBaseDir = `${pluginDir}/embeddings`;
      const registry = createEmbeddingStoreRegistry(
        ssAdapter,
        embeddingsBaseDir,
      );
      const PROVIDER_DIMS = {
        "native-minilm-l6-v2": 384,
        "embedding-gemma-300m": 768,
        "multilingual-e5-base": 768,
      } as const satisfies Record<ProviderKey, number>;
      const staleProviderKeys: ProviderKey[] = [];
      const probedCounts: Partial<Record<ProviderKey, number>> = {};
      for (const key of ALL_PROVIDER_KEYS) {
        const probed = await registry.storeFor(key, PROVIDER_DIMS[key]).probe();
        if (!probed) continue;
        if (probed.version < FORMAT_VERSION) {
          staleProviderKeys.push(key);
        } else if (
          probed.version === FORMAT_VERSION &&
          probed.recordCount > 0
        ) {
          registry.markReady(key);
          probedCounts[key] = probed.recordCount;
        }
      }

      if (staleProviderKeys.length > 0) {
        // Silent wipe: the previous IndexWipeMigrationModal flow blocked
        // onload() indefinitely on Obsidian's "Loading plugins..." splash,
        // which suppresses modal interaction during plugin load. Embedding
        // data is fully derivable from vault notes (no original content
        // lost), so user confirmation buys nothing — wipe immediately and
        // surface a Notice after the workspace becomes interactive.
        for (const key of staleProviderKeys) {
          const dirPath = `${embeddingsBaseDir}/${key}`;
          try {
            await ssAdapter.remove(`${dirPath}/embeddings.bin`);
            await ssAdapter.remove(`${dirPath}/embeddings.index.json`);
            await ssAdapter
              .remove(`${dirPath}/embeddings.index.json.writing`)
              .catch(() => {});
            await ssAdapter.remove(`${dirPath}/mtimes.json`).catch(() => {});
            await ssAdapter
              .remove(`${dirPath}/embeddings.meta.json`)
              .catch(() => {});
          } catch (err) {
            logger.warn(
              "semantic-search: failed to wipe stale index directory",
              {
                dir: dirPath,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }
        }
        const wipedCount = staleProviderKeys.length;
        this.app.workspace.onLayoutReady(() => {
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
      const semanticPrefs = await globalSettingsMutex.run(async () => {
        const data = ((await this.loadData()) as Record<string, unknown>) ?? {};
        return (data.semanticSearch ?? {}) as {
          unloadModelWhenIdle?: boolean;
        };
      });
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
      const gemmaProvider = createEmbeddingGemmaProvider(
        gemmaDownloader.factory,
      );
      const e5Downloader = createModelDownloader({
        innerFactory: realPipelineFactory,
        dtype: "q8",
      });
      const e5Provider = createMultilingualE5Provider(e5Downloader.factory);

      const embeddingProviders = {
        "embedding-gemma-300m": gemmaProvider,
        "multilingual-e5-base": e5Provider,
      };

      const semanticResult = await semanticSearchSetup(this, {
        factoryDeps: {
          plugin: this,
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
          this.app.workspace.onLayoutReady(() => {
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
          const isActive =
            settingToRegistryKey[state.settings.provider] === key;
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
        if (
          activeRegistryKey &&
          staleProviderKeys.includes(activeRegistryKey)
        ) {
          this.app.workspace.onLayoutReady(() => {
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

        this.semanticSearchState = state;
      } else {
        logger.error("Semantic search setup failed", {
          error: semanticResult.error,
        });
      }
    } catch (error) {
      logger.error("Semantic search wiring failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 0.4.0: the in-process server has no binary to install.
    // 0.17.0: the 0.3.x migration wizard was removed; users coming
    // from <=0.3.x migrate through any 0.15.x release first.

    // Smart Connections: resolve the search API best-effort and bind
    // it onto the plugin instance. The SmartConnectionsProvider and
    // the provider factory read `this.smartSearch` to decide readiness
    // and dispatch `search_vault_smart` under the "smart-connections" /
    // "auto" provider settings. Without this binding the field stays
    // undefined and the provider can never become ready even with
    // Smart Connections fully loaded (#99). Best-effort, same shape as
    // the Local REST API binding above.
    lastValueFrom(loadSmartSearchAPI(this))
      .then((dep) => {
        this.smartSearch = dep.api;
        if (this.smartSearch) {
          logger.info(
            "Smart Connections detected — `search_vault_smart` can use it",
          );
        } else {
          logger.debug(
            "Smart Connections not installed — `search_vault_smart` falls back to the native provider unless reconfigured",
          );
        }
      })
      .catch((error: unknown) => {
        logger.debug("Smart Connections load skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    logger.info("MCP Tools Plugin loaded");
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Obsidian calls onunload synchronously; the returned Promise is not awaited by the plugin lifecycle
  async onunload() {
    if (this.promptsState) {
      promptsTeardown(this.promptsState);
      this.promptsState = undefined;
    }
    if (this.mcpTransportState) {
      await mcpTransportTeardown(this.mcpTransportState);
      this.mcpTransportState = undefined;
    }
    if (this.semanticSearchState) {
      await semanticSearchTeardown(this.semanticSearchState);
      this.semanticSearchState = undefined;
    }
  }
}
