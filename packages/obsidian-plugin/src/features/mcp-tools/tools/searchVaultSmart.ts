import { type } from "arktype";
import type { App } from "obsidian";
import type McpToolsPlugin from "$/main";
import { isSmartConnectionsAvailable } from "$/features/semantic-search/services/providerFactory";

export const searchVaultSmartSchema = type({
  name: '"search_vault_smart"',
  arguments: {
    query: type("string>0").describe(
      "Natural-language search phrase. Returns notes ranked by semantic similarity.",
    ),
    "filter?": {
      "includeFolders?": type("string[]").describe(
        "Restrict results to notes whose path starts with one of these folder prefixes.",
      ),
      "excludeFolders?": type("string[]").describe(
        "Skip notes whose path starts with one of these folder prefixes.",
      ),
    },
    "limit?": type("number.integer>=1").describe(
      "Maximum number of results to return. Default 10.",
    ),
  },
}).describe(
  "Semantic search through the configured semantic search provider — native Transformers.js (default) or Smart Connections, per Settings → MCP Connector → Semantic Search. Returns notes ranked by similarity to the query.",
);

export type SearchVaultSmartContext = {
  arguments: {
    query: string;
    filter?: { includeFolders?: string[]; excludeFolders?: string[] };
    limit?: number;
  };
  app: App;
  plugin: McpToolsPlugin;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

function errorResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

/**
 * Handler for the `search_vault_smart` MCP tool.
 *
 * Dispatches through `plugin.semanticSearchState.provider`, which is
 * picked by the Phase 3 provider factory based on the user's tri-state
 * setting (native / smart-connections / auto). The tool no longer
 * knows or cares which backend services the search — it only forwards
 * the query and filters to the active provider, then JSON-serializes
 * the unified `SearchResult[]` shape back to the MCP client.
 *
 * Argument mapping:
 *   filter.includeFolders → opts.folders          (provider-side)
 *   filter.excludeFolders → opts.excludeFolders   (provider-side)
 *   limit                 → opts.limit
 *
 * Output (alpha.3 onward, breaking vs alpha.2):
 *   { results: [{ filePath, heading, excerpt, score }, ...] }
 *
 * Until production wiring lands (T15), the default state.provider is
 * a NoopProvider; in that case `provider.isReady() === false` and the
 * tool returns an actionable error pointing at the settings panel.
 */
export async function searchVaultSmartHandler(
  ctx: SearchVaultSmartContext,
): Promise<ToolResult> {
  const state = ctx.plugin.semanticSearchState;
  if (!state) {
    return errorResult(
      "Semantic search is not initialized yet. Reload the MCP Connector plugin and try again, or check the developer console for the setup error.",
    );
  }

  // Which backend will actually serve this query? The native
  // Transformers.js index is only meaningful when the native provider
  // is the one answering — Smart Connections maintains its own index.
  // `settings` is absent only in partial test fixtures; treat that as
  // native (the historical unconditional behaviour) to avoid
  // regressing the native default.
  const settings = state.settings;
  const usingSmartConnections =
    settings?.provider === "smart-connections" ||
    (settings?.provider === "auto" &&
      isSmartConnectionsAvailable(ctx.plugin));

  // Lazy indexer kick (Q4 = lazy on first query). Fire-and-forget:
  // the indexer's start() runs the first full vault build in the
  // background and subscribes to vault events for incremental
  // updates. Subsequent calls are no-ops. Skipped entirely under
  // Smart Connections — kicking the native indexer there triggers a
  // pointless embedding-model download (#99).
  if (!usingSmartConnections) {
    state.startIndexerIfNeeded?.();
  }

  const provider = state.provider;
  if (!provider.isReady()) {
    return errorResult(
      usingSmartConnections
        ? "Semantic search is not ready: the Smart Connections plugin is not loaded or has not finished indexing this vault. Wait for Smart Connections to finish loading, or open Settings → MCP Connector → Semantic Search to switch providers."
        : "Semantic search is not ready. The provider may still be loading the embedding model, or the configured backend is unavailable. Open Settings → MCP Connector → Semantic Search to choose or reconfigure a provider.",
    );
  }

  let results;
  try {
    results = await provider.search(ctx.arguments.query, {
      folders: ctx.arguments.filter?.includeFolders,
      excludeFolders: ctx.arguments.filter?.excludeFolders,
      limit: ctx.arguments.limit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Semantic search failed: ${message}`);
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
  };
}
