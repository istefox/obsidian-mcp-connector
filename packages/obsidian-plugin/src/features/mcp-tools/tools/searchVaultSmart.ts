import { type } from "arktype";
import { errorJson, successText } from "../services/responseBuilders";
import type { App } from "obsidian";
import type McpToolsPlugin from "$/main";
import { isSmartConnectionsAvailable } from "$/features/semantic-search/services/providerFactory";
import { createExclusionFilter } from "$/shared/isUserIgnored";
import {
  projectSmartSearchResults,
  withSearchResultsPayload,
} from "$/features/mcp-apps/services/searchResultsPayload";
import { buildObsidianUri } from "../services/buildObsidianUri";

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
    "excerptLength?": type("number.integer>=0").describe(
      "Truncate each excerpt to this many characters, adding an ellipsis when cut. 0 drops the excerpt. Omit for the full excerpt.",
    ),
    "compact?": type("boolean").describe(
      "Return only filePath and score for each result, the shortest output. Takes precedence over excerptLength.",
    ),
  },
}).describe(
  "Semantic search through the configured provider, native Transformers.js or Smart Connections. Returns notes ranked by similarity to the query, each with the line the match starts at (null when unresolvable, e.g. under Smart Connections). While the index is still building, the error carries filesIndexed/filesTotal/percent and, when a build rate is known, an estimated retryAfterSeconds.",
);

export type SearchVaultSmartContext = {
  arguments: {
    query: string;
    filter?: { includeFolders?: string[]; excludeFolders?: string[] };
    limit?: number;
    excerptLength?: number;
    compact?: boolean;
  };
  app: App;
  plugin: McpToolsPlugin;
  /** Client-supplied `_meta.progressToken` from the original request, if
   * any (#344). A `notifications/progress` push is spec-legal only when
   * this is present. */
  progressToken?: string | number;
  /** SDK-provided, request-scoped notification sender (see
   * mcp-transport/services/toolRegistry.ts's `HandlerContext`). Absent in
   * partial test fixtures and non-HTTP call sites. */
  sendNotification?: (notification: {
    method: string;
    params?: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * R-09 (ADR-0023 D9) capability signal, threaded from
   * `HandlerContext.hasUiCapability` the same way `sendNotification` above
   * already is. `true`/`false` on the modern era, `undefined` on the
   * legacy era (no per-request signal exists there) and in partial test
   * fixtures / non-HTTP call sites.
   *
   * Only an explicit `false` withholds the payload. `undefined` must never
   * be read as "declared: false" — the legacy era's unconditional attach
   * depends on that distinction.
   */
  hasUiCapability?: boolean;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

/**
 * Estimate seconds remaining from elapsed build time and files-indexed
 * percent (#344). Returns `null` rather than a fabricated number when
 * there's no rate data yet (no start timestamp, or 0% so far — a 0%
 * elapsed/percent division would blow up, not just be imprecise).
 * Bounded to [1, 600] so noise at the extremes (a few ms elapsed, or a
 * near-0% sample) never produces an absurd estimate.
 */
function estimateRetryAfterSeconds(
  startedAt: number | null | undefined,
  percent: number,
  now: number,
): number | null {
  if (!startedAt || percent <= 0) return null;
  const elapsedSeconds = (now - startedAt) / 1000;
  if (elapsedSeconds <= 0) return null;
  if (percent >= 100) return 0;
  const estimate = (elapsedSeconds / percent) * (100 - percent);
  return Math.max(1, Math.min(600, Math.round(estimate)));
}

/**
 * Compute the files-indexed/total/percent triple used by both the native
 * and DLC "still building" branches.
 */
function computeIndexProgress(
  app: App,
  store: { hasRecords(path: string): boolean } | null | undefined,
): { filesIndexed: number; filesTotal: number; percent: number } {
  const files = app.vault.getMarkdownFiles();
  const filesTotal = files.length;
  const filesIndexed = store
    ? files.filter((f) => store.hasRecords(f.path)).length
    : 0;
  const percent =
    filesTotal > 0 ? Math.round((filesIndexed / filesTotal) * 100) : 0;
  return { filesIndexed, filesTotal, percent };
}

/**
 * Send a `notifications/progress` push on the same POST's SSE stream
 * (#344), mirroring activate_tool's `list_changed` mechanism. Spec-legal
 * only when the client's original request carried `_meta.progressToken` —
 * never fabricated. A notification-send failure must never fail the tool
 * call, so failures are swallowed (same defensive pattern as
 * activateTool.ts).
 */
async function maybeSendProgress(
  ctx: SearchVaultSmartContext,
  percent: number,
  retryAfterSeconds: number | null,
): Promise<void> {
  if (!ctx.progressToken || !ctx.sendNotification) return;
  const message =
    retryAfterSeconds !== null
      ? `Indexing… ${percent}% — retry in ~${retryAfterSeconds}s`
      : `Indexing… ${percent}%`;
  try {
    await ctx.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: ctx.progressToken,
        progress: percent,
        total: 100,
        message,
      },
    });
  } catch {
    // Swallowed by design — see doc comment above.
  }
}

/**
 * Wire shape of the text result. `compact` keeps only `filePath` and
 * `score`; otherwise `excerptLength` shortens each excerpt (0 drops it).
 * The MCP Apps payload is built from the untouched results, so the
 * rendered view is unaffected by either option.
 */
function shapeWireResults(
  results: ReadonlyArray<{ filePath: string; excerpt: string; score: number }>,
  vaultName: string,
  excerptLength: number | undefined,
  compact: boolean | undefined,
): Array<Record<string, unknown>> {
  if (compact) {
    return results.map((r) => ({ filePath: r.filePath, score: r.score }));
  }
  return results.map((r) => {
    const base: Record<string, unknown> = {
      ...r,
      uri: buildObsidianUri(vaultName, r.filePath),
    };
    if (excerptLength === undefined) return base;
    if (excerptLength === 0) {
      delete base.excerpt;
    } else if (r.excerpt.length > excerptLength) {
      base.excerpt = `${r.excerpt.slice(0, excerptLength)}…`;
    }
    return base;
  });
}

/**
 * Handler for the `search_vault_smart` MCP tool.
 *
 * Dispatches through `plugin.semanticSearchState.provider`, which is
 * picked by the provider factory based on the user's tri-state
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
    return errorJson(
      "Semantic search is not initialized yet. Reload the MCP Connector plugin and try again, or check the developer console for the setup error.",
      "semantic_search_unavailable",
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
    (settings?.provider === "auto" && isSmartConnectionsAvailable(ctx.plugin));

  // Lazy indexer kick (Q4 = lazy on first query). Fire-and-forget:
  // the indexer's start() runs the first full vault build in the
  // background and subscribes to vault events for incremental
  // updates. Subsequent calls are no-ops. Skipped under Smart
  // Connections (#99) and DLC providers (embedding-gemma,
  // multilingual-e5-base) — DLC providers use their own indexer
  // started by startRebuildFor, not the native MiniLM indexer.
  const usingDlcProvider =
    settings?.provider === "embedding-gemma" ||
    settings?.provider === "multilingual-e5-base";
  if (!usingSmartConnections && !usingDlcProvider) {
    state.startIndexerIfNeeded?.();

    // #344: the native provider's own lazy first-time build (or a
    // post-reopen catch-up rebuild) — independent of provider.isReady(),
    // which is hardcoded true for the native provider (see
    // nativeProvider.ts: "even with an empty store the contract is to
    // return zero results, not error"). Gated on the build-in-progress
    // flag, NOT on filesIndexed/filesTotal reaching 100% (unsafe — see
    // nativeIndexBuildInProgress's doc comment on SemanticSearchState).
    if (state.nativeIndexBuildInProgress) {
      const { filesIndexed, filesTotal, percent } = computeIndexProgress(
        ctx.app,
        state.store,
      );
      const retryAfterSeconds = estimateRetryAfterSeconds(
        state.nativeIndexBuildStartedAt,
        percent,
        Date.now(),
      );
      await maybeSendProgress(ctx, percent, retryAfterSeconds);
      return errorJson(
        "Semantic search is not ready: the index is still being built. Retry shortly.",
        "index_building",
        { filesIndexed, filesTotal, percent, retryAfterSeconds },
      );
    }
  }

  const provider = state.provider;
  if (!provider.isReady()) {
    if (state.pendingProvider) {
      const { filesIndexed, filesTotal, percent } = computeIndexProgress(
        ctx.app,
        state.store,
      );
      const retryAfterSeconds = estimateRetryAfterSeconds(
        state.pendingProviderStartedAt,
        percent,
        Date.now(),
      );
      await maybeSendProgress(ctx, percent, retryAfterSeconds);
      return errorJson(
        `Semantic search is not ready: the "${state.pendingProvider}" index is still being built. Open Settings → MCP Connector → Semantic Search and click "Rebuild now" if the build has not started yet.`,
        "index_building",
        { filesIndexed, filesTotal, percent, retryAfterSeconds },
      );
    }
    return errorJson(
      usingSmartConnections
        ? "Semantic search is not ready: the Smart Connections plugin is not loaded or has not finished indexing this vault. Wait for Smart Connections to finish loading, or open Settings → MCP Connector → Semantic Search to switch providers."
        : "Semantic search is not ready. The provider may still be loading the embedding model, or the configured backend is unavailable. Open Settings → MCP Connector → Semantic Search to choose or reconfigure a provider.",
      "semantic_search_unavailable",
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
    return errorJson(
      `Semantic search failed: ${message}`,
      "semantic_search_failed",
    );
  }

  // Query-time exclusion (RFC #238, D3): drop hits in folders the user
  // has excluded via `Files & Links → Excluded files`. The indexer no
  // longer admits excluded files, but chunks indexed *before* a folder
  // was excluded can linger until the next manual Rebuild — this filter
  // keeps them from surfacing meanwhile. Applied uniformly across
  // providers (native / DLC / Smart Connections, which keeps its own
  // index) so the exclusion setting is honoured regardless of backend.
  const isExcluded = createExclusionFilter(ctx.app);
  results = results.filter((r) => !isExcluded(r.filePath));

  const vaultName = ctx.app.vault.getName();
  const wireResults = shapeWireResults(
    results,
    vaultName,
    ctx.arguments.excerptLength,
    ctx.arguments.compact,
  );
  const result = successText(JSON.stringify({ results: wireResults }));
  // Same rule as `search_vault_simple` (R-09, ADR-0023 D9): only a
  // declared NON-support withholds the payload. `undefined` means "no
  // signal" — the legacy era, and every caller predating this field — and
  // keeps attaching. Every `isError` return above short-circuits before
  // reaching here, so the error branch still carries no key on either era.
  if (ctx.hasUiCapability === false) return result;
  return withSearchResultsPayload(
    result,
    projectSmartSearchResults(results, ctx.app.vault.getName()),
  );
}
