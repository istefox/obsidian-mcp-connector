import { Notice, Plugin } from "obsidian";
import { type SmartConnections } from "shared";
import { checkCommandPermission as runCommandPermissionCheck } from "./features/command-permissions/services/checkCommandPermission";
import {
  createBrokerHost,
  startDiscovery,
  type BrokerHost,
  type DiscoveryRuntime,
} from "./features/mcp-client-config/services/discoveryBroker";
import {
  createRouteQueue,
  replaceRoute,
  restartTransport,
  RouteQueueClosed,
} from "./features/mcp-client-config/services/routeLifecycle";
import { BROKER_PORT } from "./features/mcp-transport/constants";
import type { SetupResult } from "./features/mcp-transport/services/setup";
import { SettingsStore } from "./shared/settingsStore";
import {
  disableSettingsReadCache,
  enableSettingsReadCache,
} from "./shared/settingsReadCache";
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
  refreshAutoProvider,
  teardown as semanticSearchTeardown,
  type SemanticSearchState,
} from "./features/semantic-search";
import { wireSemanticSearch } from "./features/semantic-search/services/productionWiring";
import { loadSmartSearchAPI } from "./shared";
import { createGuardedApp, isGuardedApp } from "./shared/guardedApp";
import { pathPolicyFor } from "./shared/policyProvider";
import { logger } from "./shared/logger";

export default class McpToolsPlugin extends Plugin {
  mcpTransportState?: McpTransportState;

  /**
   * Hosts the shared broker when this vault wins the port, for as long as
   * the plugin is loaded (ADR-0027). Outlives route restarts, so a retry
   * or move in this vault never takes the broker from the others.
   */
  brokerHost?: BrokerHost;

  /** This vault's broker route, registered for every client. */
  discoveryState?: DiscoveryRuntime;

  /**
   * Runs transport starts and restarts and route changes one at a time.
   * Obsidian awaits neither onload nor onunload, so onunload closes it and
   * an operation that settles afterwards tears down what it created.
   */
  readonly routeQueue = createRouteQueue();

  promptsState?: PromptsFeatureState;

  semanticSearchState?: SemanticSearchState;

  /**
   * Resolved Smart Connections search API, populated best-effort at
   * onload by the `loadSmartSearchAPI` poll. The
   * SmartConnectionsProvider + provider factory read this field to
   * decide readiness and to dispatch `search_vault_smart` queries when
   * the user picks the "smart-connections" (or "auto") provider.
   * Undefined until the loader resolves, or permanently if Smart
   * Connections is not installed (#99).
   */
  smartSearch?: SmartConnections.SmartSearch;

  /**
   * Cancels the Smart Connections detection poll (up to 5s at onload).
   * Kept so onunload can stop it — without this, disabling the plugin
   * inside the poll window leaves the timer running against an unloaded
   * plugin instance.
   */
  private cancelSmartSearchPoll?: () => void;

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

  /**
   * Start or restart the MCP transport and this vault's broker route, see
   * restartTransport. Rejects with RouteQueueClosed after unload.
   */
  restartTransport(): Promise<SetupResult> {
    return restartTransport(this, {
      setup: (stale) => mcpTransportSetup(this, stale),
      teardown: mcpTransportTeardown,
      startRoute: (port) => this.startRoute(port),
    });
  }

  /**
   * Restart this vault's broker route around `update`, a change to its
   * saved identity, see replaceRoute. Resolves whether a route started.
   */
  replaceRoute(update?: () => Promise<void>): Promise<boolean> {
    return replaceRoute(this, {
      update,
      startRoute: (port) => this.startRoute(port),
    });
  }

  private startRoute(transportPort: number): Promise<DiscoveryRuntime> {
    const host = this.brokerHost;
    if (!host) return Promise.reject(new RouteQueueClosed());
    return startDiscovery(this, { host, transportPort });
  }

  async onload() {
    // Every MCP request reads data.json three to four times (auth, tool
    // policy, folder-exclusion policy). Coalesce them before anything
    // else starts reading; writes still go to disk (settingsReadCache.ts).
    enableSettingsReadCache(this);
    // Before the first await, so onunload always has it to close
    this.brokerHost = createBrokerHost({ pluginId: this.manifest.id });

    // Initialize features in order
    await setupCore(this);

    // 0.4.0 HTTP transport — in-process MCP server, and its broker route.
    let mcpResult: SetupResult;
    try {
      mcpResult = await this.restartTransport();
    } catch (error) {
      // onunload ran first, and the queue tore down whatever had started
      if (error instanceof RouteQueueClosed) return;
      throw error;
    }
    if (mcpResult.success) {
      if (mcpResult.state.server.port === BROKER_PORT) {
        // A fixed port saved before the broker took this port. It keeps
        // working directly, but no vault can host the broker meanwhile.
        new Notice(
          `MCP Connector: This vault's fixed port ${BROKER_PORT} is reserved for the shared broker, so client configs that use the broker cannot connect to any open vault. Change the fixed port in Access Control`,
        );
      }
      // ADR-0020 D1: prompts are a separate registry that never reaches
      // toolRegistry.dispatch, so this is the second and last place the
      // guarded App has to be installed. `expandEmbeds` transcludes
      // arbitrary `![[...]]` targets vault-wide and would otherwise read
      // straight through an exclusion.
      const promptsApp = createGuardedApp(this.app, () =>
        pathPolicyFor(this).current(),
      );
      if (!isGuardedApp(promptsApp)) {
        throw new Error(
          "onload: refusing to wire prompts against an unguarded App (ADR-0020 D1).",
        );
      }
      const promptsResult = await promptsSetup(
        mcpResult.state.mcp.promptRegistry,
        promptsApp,
        {
          // ADR-0017: the prompts feature decides WHEN the list changed, the
          // transport owns HOW it is published. Wiring it here rather than
          // inside the transport keeps the vault-watching in the feature
          // that already watches the vault.
          notifyPromptsChanged: () =>
            mcpResult.state.mcp.notifyPromptsChanged(),
        },
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

    // 0.4.0 semantic search — Phase 3 production wiring, extracted to
    // services/productionWiring.ts for testability.
    try {
      this.semanticSearchState = await wireSemanticSearch(this);
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
    // The returned cancel function lets onunload stop the poll if the
    // plugin is disabled inside the 5s detection window.
    this.cancelSmartSearchPoll = loadSmartSearchAPI(this, {
      onNext: (dep) => {
        this.smartSearch = dep.api;
        // #430: `wireSemanticSearch` above already cached a provider
        // choice before this binding could exist, so "auto" was pinned
        // to the native fallback regardless of how fast Smart
        // Connections loaded. Reconsider now that the binding is real.
        // `semanticSearchState` is guaranteed set-or-absent by this
        // point: this subscription is not created until the `await
        // wireSemanticSearch(this)` above has already resolved.
        if (this.semanticSearchState) {
          refreshAutoProvider(this.semanticSearchState);
        }
      },
      onComplete: () => {
        if (this.smartSearch) {
          logger.info(
            "Smart Connections detected — `search_vault_smart` can use it",
          );
        } else {
          logger.debug(
            "Smart Connections not installed — `search_vault_smart` falls back to the native provider unless reconfigured",
          );
        }
      },
      onError: (error: unknown) => {
        logger.debug("Smart Connections load skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    logger.info("MCP Tools Plugin loaded");
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Obsidian calls onunload synchronously; the returned Promise is not awaited by the plugin lifecycle
  async onunload() {
    // First and synchronous: no queued transport or route operation runs
    // after this, and one still running tears down what it creates
    this.routeQueue.close();
    disableSettingsReadCache(this);
    this.cancelSmartSearchPoll?.();
    this.cancelSmartSearchPoll = undefined;
    if (this.promptsState) {
      promptsTeardown(this.promptsState);
      this.promptsState = undefined;
    }
    // Both calls close their sockets and listener before their first
    // await, so the broker port is released even though Obsidian never
    // awaits this method. Every other vault then re-elects a host.
    const discoveryStopped = this.discoveryState?.stop();
    const brokerClosed = this.brokerHost?.close();
    this.discoveryState = undefined;
    this.brokerHost = undefined;
    await discoveryStopped;
    await brokerClosed;
    // A route still registering is not in discoveryState yet. Its
    // operation stops it on seeing the closed queue; release the
    // transport only after that, or the broker could briefly forward
    // this vault's clients to a port it no longer holds.
    await this.routeQueue.idle();
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
