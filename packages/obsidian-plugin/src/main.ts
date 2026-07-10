import { Notice, Plugin } from "obsidian";
import type { Subscription } from "rxjs";
import { type SmartConnections } from "shared";
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
  teardown as semanticSearchTeardown,
  type SemanticSearchState,
} from "./features/semantic-search";
import { wireSemanticSearch } from "./features/semantic-search/services/productionWiring";
import { loadSmartSearchAPI } from "./shared";
import { logger } from "./shared/logger";

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
   * Subscription of the Smart Connections detection poll (up to 5s at
   * onload). Kept so onunload can cancel it — without this, disabling
   * the plugin inside the poll window leaves the timer running against
   * an unloaded plugin instance.
   */
  private smartSearchSub?: Subscription;

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
    // Subscribed (not lastValueFrom) so onunload can cancel the poll if
    // the plugin is disabled inside the 5s detection window.
    this.smartSearchSub = loadSmartSearchAPI(this).subscribe({
      next: (dep) => {
        this.smartSearch = dep.api;
      },
      complete: () => {
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
      error: (error: unknown) => {
        logger.debug("Smart Connections load skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    logger.info("MCP Tools Plugin loaded");
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Obsidian calls onunload synchronously; the returned Promise is not awaited by the plugin lifecycle
  async onunload() {
    this.smartSearchSub?.unsubscribe();
    this.smartSearchSub = undefined;
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
