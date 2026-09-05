import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { App } from "obsidian";
import {
  projectSimpleSearchResults,
  withSearchResultsPayload,
} from "$/features/mcp-apps/services/searchResultsPayload";

const DEFAULT_CONTEXT = 100;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_MATCHES_PER_FILE = 5;

export const searchVaultSimpleSchema = type({
  name: '"search_vault_simple"',
  arguments: {
    query: type("string>0").describe(
      "Substring to search for (case-insensitive).",
    ),
    "contextLength?": type("number.integer>=0").describe(
      "Characters of context to include before/after each match. Default 100.",
    ),
    "limit?": type("number.integer>=1").describe(
      "Max number of files to return matches from. Default 50.",
    ),
    "maxMatchesPerFile?": type("number.integer>=1").describe(
      "Max number of matches to return per file. Default 5.",
    ),
  },
}).describe(
  "Plain-text substring search across all markdown files in the vault. Returns each matching file with surrounding context for each hit, including the 0-indexed line each match starts at.",
);

export type SearchVaultSimpleContext = {
  arguments: {
    query: string;
    contextLength?: number;
    limit?: number;
    maxMatchesPerFile?: number;
  };
  app: App;
  /**
   * R-09 (ADR-0023 D9) capability signal, threaded from
   * `HandlerContext.hasUiCapability` (mcp-transport/services/toolRegistry.ts)
   * the same way `search_vault_smart`'s `sendNotification` already is.
   * `true`/`false` on the modern era, `undefined` on the legacy era (no
   * per-request signal exists there) and in partial test fixtures / non-HTTP
   * call sites.
   *
   * TESTER STUB (task 8): declared so tests compile; NOT yet consulted by
   * `searchVaultSimpleHandler`, which still calls `withSearchResultsPayload`
   * unconditionally. Gating the call on this field is the coder's job.
   */
  hasUiCapability?: boolean;
};

type FileResult = {
  filename: string;
  /**
   * Set when this file had more matches than `maxMatchesPerFile` allowed
   * through (R-02, ADR-0023 D2) — "more than the cap", not "at least the
   * cap". Left absent (never `false`) for a file at or under the cap, so
   * the serialized response carries no key for the common case.
   */
  moreMatches?: boolean;
  matches: Array<{
    context: string;
    /** 0-indexed line the match starts at. */
    line: number;
  }>;
};

/** Reads per batch: bounds memory while hiding cachedRead latency. */
const READ_BATCH_SIZE = 8;

/** Escape a literal string for use inside a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Search vault files for plain-text substring matches. Iterates over all
 * markdown files, performs case-insensitive search, extracts context
 * windows around each match, and respects the client-side limit truncation
 * (fix for issue #62).
 *
 * The scan is a case-insensitive regex over the original content: the
 * previous `content.toLowerCase()` allocated a full copy of every file
 * per query. Files are read in sequential batches of 8 (parallel reads
 * within a batch, batch order preserved) with an early stop once
 * `limit` files have matched.
 */
export async function searchVaultSimpleHandler(
  ctx: SearchVaultSimpleContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = ctx.arguments.query;
  const contextLength = ctx.arguments.contextLength ?? DEFAULT_CONTEXT;
  const limit = ctx.arguments.limit ?? DEFAULT_LIMIT;
  const maxMatchesPerFile =
    ctx.arguments.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE;
  const patternSource = escapeRegExp(query);

  const files = ctx.app.vault.getMarkdownFiles();
  const results: FileResult[] = [];

  for (
    let start = 0;
    start < files.length && results.length < limit;
    start += READ_BATCH_SIZE
  ) {
    const batch = files.slice(start, start + READ_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (file): Promise<FileResult | null> => {
        const content = await ctx.app.vault.cachedRead(file);
        const matches: FileResult["matches"] = [];

        // Per-file scanner: files in a batch scan concurrently, so a
        // shared regex would race on lastIndex.
        let m: RegExpExecArray | null;
        let moreMatches = false;
        const scanner = new RegExp(patternSource, "gi");
        while ((m = scanner.exec(content)) !== null) {
          // One match past the cap is enough to know there are more: stop
          // scanning there instead of collecting a file's worth of hits
          // that are about to be dropped (R-02, ADR-0023 D2).
          if (matches.length >= maxMatchesPerFile) {
            moreMatches = true;
            break;
          }
          const idx = m.index;
          const start = Math.max(0, idx - contextLength);
          const end = Math.min(
            content.length,
            idx + query.length + contextLength,
          );
          matches.push({
            context: content.slice(start, end),
            line: content.slice(0, idx).split("\n").length - 1,
          });
          // Match length equals query length (literal pattern), so this
          // mirrors the previous `idx += query.length` stepping.
          scanner.lastIndex = idx + query.length;
        }

        if (matches.length === 0) return null;
        // `moreMatches` is omitted rather than set to false at or under the
        // cap: the flag is the exception, and every file paying a `false`
        // key back to the client is the cost this change exists to cut.
        return moreMatches
          ? { filename: file.path, matches, moreMatches: true }
          : { filename: file.path, matches };
      }),
    );

    for (const r of batchResults) {
      if (r === null) continue;
      if (results.length >= limit) break; // #62 fix: client-side truncation
      results.push(r);
    }
  }

  return withSearchResultsPayload(
    successText(JSON.stringify({ results })),
    projectSimpleSearchResults(results, ctx.app.vault.getName()),
  );
}
