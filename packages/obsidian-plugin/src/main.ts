import { Notice, Plugin, TFile } from "obsidian";
import { lastValueFrom } from "rxjs";
import { type SmartConnections } from "shared";
import {
  CommandPermissionModal,
  globalSettingsMutex,
  decidePermission,
  appendAuditEntry,
  createRuntimeRateCounter,
  isDestructiveCommand,
  SOFT_RATE_LIMIT_PER_MINUTE,
} from "./features/command-permissions";
import type { CommandAuditEntry } from "./features/command-permissions";
import { setup as setupCore } from "./features/core";
import {
  setup as mcpTransportSetup,
  teardown as mcpTransportTeardown,
  type McpTransportState,
} from "./features/mcp-transport";
import { registerTemplatesCompatRoute } from "./features/mcp-tools/services/templatesCompat";
import { setupMigration } from "./features/migration";
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
import {
  loadLocalRestAPI,
  loadSmartSearchAPI,
  type Dependencies,
} from "./shared";
import { logger } from "./shared/logger";

// Soft-rate counter for the in-process permission-check path. The
// settings load/modify/save cycle is serialized through the shared
// `globalSettingsMutex` (process-wide, see settingsLock.ts), not a
// path-local mutex — data.json is shared across features.
const _inProcessRateCounter = createRuntimeRateCounter();
const IN_PROCESS_MODAL_TIMEOUT_MS = 30_000;

export default class McpToolsPlugin extends Plugin {
  localRestApi: Dependencies["obsidian-local-rest-api"] = {
    id: "obsidian-local-rest-api",
    name: "Local REST API",
    required: true,
    installed: false,
  };

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

  getLocalRestApiKey(): string | undefined {
    return this.localRestApi.plugin?.settings?.apiKey;
  }

  /**
   * Resolve the Local REST API base URL from the LRA plugin's settings.
   *
   * LRA exposes `bindingHost` (default `127.0.0.1`) and `port` (default
   * `27124` for HTTPS). Reading from the live settings means a user who
   * runs LRA on a non-default port — common when 27124 is taken by
   * another service — gets a working `search_vault` instead of a hard
   * connection error against the previously hardcoded URL.
   *
   * Protocol is fixed to HTTPS: LRA serves HTTPS on `port` by default
   * and HTTP on `port - 1` only when `enableInsecureServer` is opted
   * in. Supporting that branch is out of scope here; the historical
   * pin to HTTPS preserves the previous default behavior.
   *
   * Falls back to `https://127.0.0.1:27124` when the LRA plugin is
   * loaded but its settings aren't readable yet — unusual in practice
   * (the plugin polls until LRA is ready before this can be called)
   * but cheap to handle so the tool returns a sensible URL rather
   * than `undefined`.
   */
  getLocalRestApiUrl(): string {
    const settings = this.localRestApi.plugin?.settings as
      | { port?: number; bindingHost?: string }
      | undefined;
    const host = settings?.bindingHost ?? "127.0.0.1";
    const port = settings?.port ?? 27124;
    return `https://${host}:${port}`;
  }

  /**
   * In-process permission check for the `execute_obsidian_command`
   * MCP tool. Two-phase mutex policy: Phase A (load + decide /
   * detect-modal-needed + fast-path save) under the shared settings
   * lock, modal wait OUTSIDE the lock, Phase B (re-load + persist
   * final outcome) re-acquires it. Returns a plain
   * `{ outcome, reason }`.
   *
   * Fast path: if the master toggle is off, or the command is already
   * in the allowlist (allow) or not (deny), the decision is made under
   * the settings mutex and returned immediately.
   *
   * Slow path: if the master toggle is on and the command is not in the
   * allowlist, a modal is opened in the Obsidian UI. The method awaits
   * the user's decision (or a 30-second timeout). Phase B then persists
   * the outcome under the mutex.
   *
   * The runtime soft-rate-limit counter is updated on every call so the
   * modal can display a warning banner when activity is high.
   */
  async checkCommandPermission(
    rawCommandId: string,
  ): Promise<{ outcome: "allow" | "deny"; reason?: string }> {
    // Allowlist entries are exact ids; a stray leading/trailing space
    // in the request must not cause a spurious deny. Trim only — ids
    // are case-sensitive by Obsidian convention, so no lowercasing.
    const commandId = rawCommandId.trim();

    // Record this call in the soft-rate counter (UI warning only —
    // hard enforcement is the rate limiter in services/rateLimit.ts).
    _inProcessRateCounter.record();

    // Phase A: decide under the settings mutex.
    type PhaseAResult =
      | { kind: "done"; outcome: "allow" | "deny"; reason?: string }
      | { kind: "needs-modal"; softRateLimit: number };

    const phaseA: PhaseAResult = await globalSettingsMutex.run(async () => {
      const settings = (await this.loadData()) ?? {};
      const perms = settings.commandPermissions ?? {};

      const pureOutcome = decidePermission(
        commandId,
        perms.enabled,
        perms.allowlist,
      );

      const inAllowlist = (perms.allowlist ?? []).includes(commandId);
      const needsModal =
        perms.enabled === true &&
        pureOutcome.decision === "deny" &&
        !inAllowlist;

      if (needsModal) {
        return {
          kind: "needs-modal",
          softRateLimit: perms.softRateLimit ?? SOFT_RATE_LIMIT_PER_MINUTE,
        };
      }

      // Fast path: write audit entry and return.
      const auditEntry: CommandAuditEntry = {
        timestamp: new Date().toISOString(),
        commandId,
        decision: pureOutcome.decision,
        ...(pureOutcome.reason ? { reason: pureOutcome.reason } : {}),
      };
      settings.commandPermissions = {
        ...perms,
        recentInvocations: appendAuditEntry(
          perms.recentInvocations,
          auditEntry,
        ),
      };
      await this.saveData(settings);

      return {
        kind: "done",
        outcome: pureOutcome.decision,
        reason: pureOutcome.reason,
      };
    });

    if (phaseA.kind === "done") {
      return { outcome: phaseA.outcome, reason: phaseA.reason };
    }

    // Slow path: open the confirmation modal.
    const commandName = (
      this.app as unknown as {
        commands?: {
          commands?: Record<string, { id: string; name: string }>;
        };
      }
    ).commands?.commands?.[commandId]?.name;

    const isDestructive = isDestructiveCommand(commandId, commandName);
    const rateCount = _inProcessRateCounter.countInLastMinute();
    const showRateWarning = rateCount > phaseA.softRateLimit;

    const modal = new CommandPermissionModal(this.app, {
      commandId,
      commandName,
      isDestructive,
      showRateWarning,
      rateCount,
    });
    modal.open();

    // Race the modal decision against the timeout.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    type ModalOutcome =
      | {
          kind: "decided";
          decision: import("./features/command-permissions").ModalDecision;
        }
      | { kind: "timeout" };

    const outcome = await Promise.race<ModalOutcome>([
      modal
        .waitForDecision()
        .then((d) => ({ kind: "decided" as const, decision: d })),
      new Promise<ModalOutcome>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve({ kind: "timeout" }),
          IN_PROCESS_MODAL_TIMEOUT_MS,
        );
      }),
    ]);

    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (outcome.kind === "timeout") modal.close();

    let finalOutcome: "allow" | "deny";
    let finalReason: string | undefined;
    let persistAllowlistEntry = false;

    if (outcome.kind === "timeout") {
      finalOutcome = "deny";
      finalReason = `User did not respond within ${IN_PROCESS_MODAL_TIMEOUT_MS / 1000} seconds.`;
    } else {
      const d = outcome.decision;
      if (d === "deny") {
        finalOutcome = "deny";
        finalReason = `User denied permission for command '${commandId}' via the confirmation modal.`;
      } else {
        finalOutcome = "allow";
        if (d === "allow-always") persistAllowlistEntry = true;
      }
    }

    // Phase B: persist outcome under the mutex.
    await globalSettingsMutex.run(async () => {
      const settings = (await this.loadData()) ?? {};
      const perms = settings.commandPermissions ?? {};

      const auditEntry: CommandAuditEntry = {
        timestamp: new Date().toISOString(),
        commandId,
        decision: finalOutcome,
        ...(finalReason ? { reason: finalReason } : {}),
      };

      let updatedAllowlist: string[] | undefined;
      if (
        persistAllowlistEntry &&
        !(perms.allowlist ?? []).includes(commandId)
      ) {
        updatedAllowlist = [...(perms.allowlist ?? []), commandId];
      }

      settings.commandPermissions = {
        ...perms,
        ...(updatedAllowlist !== undefined
          ? { allowlist: updatedAllowlist }
          : {}),
        recentInvocations: appendAuditEntry(
          perms.recentInvocations,
          auditEntry,
        ),
      };
      await this.saveData(settings);
    });

    return { outcome: finalOutcome, reason: finalReason };
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
        on: (event, handler) => {
          // Obsidian's vault.on signatures are event-specific. The
          // unsubscribe is offref(EventRef). Wrap so our VaultLike
          // contract stays clean.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ref = (this.app.vault as any).on(event, (f: unknown) => {
            if (f instanceof TFile) handler(f.path);
          });
          return () => this.app.vault.offref(ref);
        },
      };

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

      // Detect stale per-providerKey stores (version < FORMAT_VERSION).
      // If any exist, show a blocking dialog before wiping them.
      const embeddingsBaseDir = `${pluginDir}/embeddings`;
      const staleProviderKeys: ProviderKey[] = [];
      for (const key of ALL_PROVIDER_KEYS) {
        const indexPath = `${embeddingsBaseDir}/${key}/embeddings.index.json`;
        try {
          if (await ssAdapter.exists(indexPath)) {
            const text = await ssAdapter.read(indexPath);
            const parsed = JSON.parse(text) as { version?: number };
            if (
              typeof parsed.version === "number" &&
              parsed.version < FORMAT_VERSION
            ) {
              staleProviderKeys.push(key);
            }
          }
        } catch {
          // Unreadable index is already handled by store.init(); skip here.
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

      const registry = createEmbeddingStoreRegistry(
        ssAdapter,
        `${pluginDir}/embeddings`,
      );

      // Native MiniLM — eager init; always available.
      const nativeDownloader = createModelDownloader({
        innerFactory: realPipelineFactory,
      });
      const embedder = createEmbedder({
        pipelineFactory: nativeDownloader.factory,
        maxInputTokens: NATIVE_MAX_INPUT_TOKENS,
      });
      const nativeEp = createNativeEmbeddingProvider(embedder);
      const nativeStore = registry.storeFor("native-minilm-l6-v2", 384);
      await nativeStore.init();
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

        // Check whether DLC stores are already built from a prior session.
        for (const [key, dim] of [
          ["embedding-gemma-300m", 768],
          ["multilingual-e5-base", 768],
        ] as const) {
          const dlcStore = registry.storeFor(key, dim);
          await dlcStore.init();
          if (dlcStore.size() > 0) registry.markReady(key);
        }

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
              })
            : createLiveIndexer({
                vault: ssVault,
                chunker: nativeChunker,
                embedder: nativeEp,
                store: nativeStore,
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

          const work = existing
            ? dlcIndexer.rebuildAll()
            : dlcIndexer.start();

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
          const dim = 768;
          const dlcStore = registry.storeFor(key, dim);
          // Auto-subscribe only when the provider is currently active AND
          // its store is ready (size > 0 was set by the earlier init loop
          // via registry.markReady). Inactive providers stay dormant —
          // the user can switch into them, which routes through
          // startRebuildFor and lazily starts the indexer at that point.
          const isActive =
            settingToRegistryKey[state.settings.provider] === key;
          if (isActive && dlcStore.size() > 0) {
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

    // Migration UX (Phase 4 T8) — detect leftover 0.3.x state and,
    // if found, queue the migration modal at workspace.onLayoutReady.
    // Pure no-op for fresh installs and for users who already
    // dismissed the modal (skippedAt persisted in data.json).
    const migrationResult = await setupMigration(this);
    if (!migrationResult.success) {
      logger.warn("Migration setup failed (non-fatal)", {
        error: migrationResult.error,
      });
    }

    // Local REST API: optional in 0.4.0.
    //
    // In 0.3.x the binary mcp-server called back into the plugin via
    // three LRA-mounted endpoints (/search/smart, /templates/execute,
    // /mcp-tools/command-permission/). In 0.4.0 the MCP server runs
    // in-process and calls Obsidian APIs directly — most of those
    // endpoints are dead. One exception: `/templates/execute` is
    // re-registered as a thin compat shim onto the in-process
    // `executeTemplateHandler`, because users who upgrade silently can
    // keep a residual custom-id MCP server entry in their Claude
    // Desktop config that still spawns the 0.3.x binary, and that
    // binary's only path to render a template is the LRA route. See
    // `features/mcp-tools/services/templatesCompat.ts` and issue #73.
    //
    // The single LRA consumer that survives directly is the
    // `search_vault` tool (DQL / JsonLogic via Dataview), which uses
    // LRA's `/search/` endpoint with an apiKey. If LRA is not
    // installed, that tool returns an actionable error to the MCP
    // client; the rest of the 19 tools work without LRA. Hence: load
    // best-effort, log debug, never show a "required" Notice.
    lastValueFrom(loadLocalRestAPI(this))
      .then((localRestApi) => {
        this.localRestApi = localRestApi;
        if (this.localRestApi.api) {
          logger.info("Local REST API detected — `search_vault` is available");
          registerTemplatesCompatRoute(this);
        } else {
          logger.debug(
            "Local REST API not installed — `search_vault` will return an actionable error if invoked; the other 19 tools are unaffected",
          );
        }
      })
      .catch((error: unknown) => {
        logger.debug("Local REST API load skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

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

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
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
    this.localRestApi.api?.unregister();
  }
}
