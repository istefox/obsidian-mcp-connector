import { type } from "arktype";
import { Notice, Plugin, TFile } from "obsidian";
import { lastValueFrom } from "rxjs";
import { LocalRestAPI, Templater, type SmartConnections } from "shared";
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
  setup as semanticSearchSetup,
  teardown as semanticSearchTeardown,
  createModelDownloader,
  type SemanticSearchState,
} from "./features/semantic-search";
import {
  createEmbedder,
  realPipelineFactory,
} from "./features/semantic-search/services/embedder";
import { createEmbeddingStore } from "./features/semantic-search/services/store";
import type { VaultAdapter } from "./features/semantic-search/services/store";
import {
  createLiveIndexer,
  createLowPowerIndexer,
  type VaultLike,
} from "./features/semantic-search/services/indexer";
import { chunk as semanticChunk } from "./features/semantic-search/services/chunker";
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
      };

      const ssVault: VaultLike = {
        getMarkdownFiles: () =>
          this.app.vault.getMarkdownFiles().map((f) => ({
            path: f.path,
            mtime: f.stat.mtime,
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

      const downloader = createModelDownloader({
        innerFactory: realPipelineFactory,
      });
      const embedder = createEmbedder({
        pipelineFactory: downloader.factory,
      });

      const pluginDir =
        this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
      const store = createEmbeddingStore({
        adapter: ssAdapter,
        binPath: `${pluginDir}/embeddings.bin`,
        indexPath: `${pluginDir}/embeddings.index.json`,
        vectorDim: 384,
      });
      await store.init();

      const semanticResult = await semanticSearchSetup(this, {
        factoryDeps: {
          plugin: this,
          embedder,
          store,
          excerptResolver: ssExcerpt,
        },
      });

      if (semanticResult.success) {
        const state = semanticResult.state;
        state.downloader = downloader;
        state.store = store;

        // Construct the indexer matching the saved indexing mode but
        // do NOT auto-start (Q4 = lazy). The search tool will call
        // startIndexerIfNeeded() on first use, kicking off the full
        // build + the model download in background.
        const indexer =
          state.settings.indexingMode === "low-power"
            ? createLowPowerIndexer({
                vault: ssVault,
                chunker: semanticChunk,
                embedder,
                store,
              })
            : createLiveIndexer({
                vault: ssVault,
                chunker: semanticChunk,
                embedder,
                store,
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

        state.teardown = async () => {
          if (indexerStarted) {
            try {
              await indexer.stop();
            } catch {
              // best-effort: don't block plugin unload
            }
          }
          try {
            await embedder.unload();
          } catch {
            // best-effort
          }
          try {
            await store.close();
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
