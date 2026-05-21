/**
 * SmartConnectionsProvider — wraps the Smart Connections plugin's
 * SmartSearch API behind the SemanticSearchProvider interface so the
 * factory (T8) can dispatch through a single contract regardless of
 * whether the user picks native or Smart Connections.
 *
 * Lifted from the inline logic in `mcp-tools/tools/searchVaultSmart.ts`:
 *   - filter mapping camelCase → SmartSearch snake_case
 *   - lazy access to `plugin.smartSearch` (set by the existing
 *     `loadSmartSearchAPI` reactive loader; v2 `window.SmartSearch`
 *     and v3+ `smartEnv.smart_sources` both surface here)
 *   - result transformation from SC's `{ item: { path, breadcrumbs,
 *     read }, score }` to the unified `SearchResult` shape
 *
 * The tool itself keeps its current call shape until T11 wires it
 * through `plugin.semanticSearchState.provider`. T7 only extracts the
 * filter mapping helper so both the tool and the provider use the
 * same conversion (and the provider's behavior is independently
 * testable).
 */

import type McpToolsPlugin from "$/main";
import type { SmartConnections } from "shared";
import type {
  SearchOpts,
  SearchResult,
  SemanticSearchProvider,
} from "$/features/semantic-search";

const EXCERPT_MAX_LENGTH = 200;

/**
 * Pure helper: convert the user-facing `SearchOpts` shape into the
 * filter object Smart Connections's `search()` expects. Only the
 * keys actually provided are emitted — SC distinguishes
 * `key_starts_with_any: []` from "key not present".
 */
export function mapFolderFilter(opts: SearchOpts): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (opts.folders && opts.folders.length > 0) {
    filter.key_starts_with_any = [...opts.folders];
  }
  if (opts.excludeFolders && opts.excludeFolders.length > 0) {
    filter.exclude_key_starts_with_any = [...opts.excludeFolders];
  }
  if (opts.limit !== undefined) {
    filter.limit = opts.limit;
  }
  return filter;
}

type RawSmartSearchResult = {
  item: {
    path: string;
    breadcrumbs?: string;
    read: () => Promise<string>;
  };
  score: number;
};

/**
 * Read the `plugin.smartSearch` field through an `unknown` cast so
 * the McpToolsPlugin public type stays narrow. The field is injected
 * by the existing `loadSmartSearchAPI` helper (v2/v3 wrapper); this
 * function does not care which version surfaced it.
 */
function getSmartSearch(
  plugin: McpToolsPlugin,
): SmartConnections.SmartSearch | undefined {
  return (plugin as unknown as { smartSearch?: SmartConnections.SmartSearch })
    .smartSearch;
}

export class SmartConnectionsUnavailableError extends Error {
  constructor() {
    super(
      "Smart Connections plugin is not installed or not yet loaded with an indexed vault. Install Smart Connections from Obsidian community plugins, let it index, then retry.",
    );
    this.name = "SmartConnectionsUnavailableError";
  }
}

class SmartConnectionsProviderImpl implements SemanticSearchProvider {
  constructor(private plugin: McpToolsPlugin) {}

  isReady(): boolean {
    const sc = getSmartSearch(this.plugin);
    return typeof sc?.search === "function";
  }

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const sc = getSmartSearch(this.plugin);
    if (!sc) throw new SmartConnectionsUnavailableError();

    const filter = mapFolderFilter(opts);
    const raw = (await sc.search(
      query,
      filter as Parameters<SmartConnections.SmartSearch["search"]>[1],
    )) as RawSmartSearchResult[];

    return Promise.all(
      raw.map(async (r): Promise<SearchResult> => {
        const heading = r.item.breadcrumbs ?? null;
        const body = await r.item.read();
        return {
          filePath: r.item.path,
          heading,
          excerpt: makeExcerpt(heading, body),
          score: r.score,
        };
      }),
    );
  }
}

function makeExcerpt(heading: string | null, body: string): string {
  if (heading) {
    const prefix = `${heading}: `;
    const remaining = Math.max(0, EXCERPT_MAX_LENGTH - prefix.length);
    const tail = body.slice(0, remaining);
    const out = prefix + tail;
    return out.length > EXCERPT_MAX_LENGTH
      ? out.slice(0, EXCERPT_MAX_LENGTH)
      : out;
  }
  if (body.length === 0) return "(no preview)";
  return body.length > EXCERPT_MAX_LENGTH
    ? body.slice(0, EXCERPT_MAX_LENGTH)
    : body;
}

export function createSmartConnectionsProvider(
  plugin: McpToolsPlugin,
): SemanticSearchProvider {
  return new SmartConnectionsProviderImpl(plugin);
}
