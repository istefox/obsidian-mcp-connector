/**
 * The structured payload the two search tools stamp onto a successful
 * result's `_meta`, for the `ui://` view to render (ADR-0018 D5/D6).
 *
 * Pure: no `App` dependency beyond a vault name the caller already has.
 */

/** Naming and limits fixed by ADR-0018 D6 — do not derive or re-invent. */
export const SEARCH_RESULTS_PAYLOAD_KEY =
  "io.github.istefox.mcp-connector/searchResults";
export const SEARCH_RESULTS_ROW_CAP = 50;
export const SEARCH_RESULTS_EXCERPT_CLIP = 400;

export type SearchResultRow = {
  filePath: string;
  excerpt: string;
  line: number | null;
  score: number | null;
  heading: string | null;
};

export type SearchResultsPayload = {
  vaultName: string;
  totalRows: number;
  truncated: boolean;
  rows: SearchResultRow[];
};

/** Shape `search_vault_simple`'s per-file matches need to project a row. */
export type SimpleSearchFile = {
  filename: string;
  matches: ReadonlyArray<{ context: string; line: number }>;
};

/** Shape `search_vault_smart`'s `SearchResult` needs to project a row. */
export type SmartSearchResult = {
  filePath: string;
  heading: string | null;
  excerpt: string;
  line: number | null;
  score: number;
};

function clipExcerpt(excerpt: string): string {
  return excerpt.length > SEARCH_RESULTS_EXCERPT_CLIP
    ? excerpt.slice(0, SEARCH_RESULTS_EXCERPT_CLIP)
    : excerpt;
}

/** Caps at SEARCH_RESULTS_ROW_CAP (leading rows, source order) and clips
 * each surviving row's excerpt — the excerpt is clipped only on rows that
 * survive the cap. */
function buildPayload(
  vaultName: string,
  rows: readonly SearchResultRow[],
): SearchResultsPayload {
  const totalRows = rows.length;
  const truncated = totalRows > SEARCH_RESULTS_ROW_CAP;
  const cappedRows = rows.slice(0, SEARCH_RESULTS_ROW_CAP).map((row) => ({
    ...row,
    excerpt: clipExcerpt(row.excerpt),
  }));
  return { vaultName, totalRows, truncated, rows: cappedRows };
}

/**
 * `search_vault_simple` flattens file × match into rows: `filePath` from
 * `filename`, `excerpt` from `context`, `line` kept, `score` and `heading`
 * omitted (ADR-0018 D6).
 */
export function projectSimpleSearchResults(
  files: readonly SimpleSearchFile[],
  vaultName: string,
): SearchResultsPayload {
  const rows: SearchResultRow[] = [];
  for (const file of files) {
    for (const match of file.matches) {
      rows.push({
        filePath: file.filename,
        excerpt: match.context,
        line: match.line,
        score: null,
        heading: null,
      });
    }
  }
  return buildPayload(vaultName, rows);
}

/**
 * `search_vault_smart` maps its `SearchResult` field for field (ADR-0018
 * D6).
 */
export function projectSmartSearchResults(
  results: readonly SmartSearchResult[],
  vaultName: string,
): SearchResultsPayload {
  const rows: SearchResultRow[] = results.map((result) => ({
    filePath: result.filePath,
    excerpt: result.excerpt,
    line: result.line,
    score: result.score,
    heading: result.heading,
  }));
  return buildPayload(vaultName, rows);
}

/**
 * Stamps the payload onto the result's `_meta`, under the fixed key,
 * alongside whatever `_meta` the result already carries. A no-op on an
 * `isError` result — the tool has no results payload to stamp on that
 * branch, `index_building` included (ADR-0018 D5).
 */
export function withSearchResultsPayload<
  T extends {
    content: unknown;
    isError?: true;
    _meta?: Record<string, unknown>;
  },
>(result: T, payload: SearchResultsPayload): T & { isError?: true } {
  if (result.isError) return result;
  return {
    ...result,
    _meta: { ...result._meta, [SEARCH_RESULTS_PAYLOAD_KEY]: payload },
  } as T & { isError?: true };
}
