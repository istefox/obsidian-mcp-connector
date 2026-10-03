import { type } from "arktype";
import { errorJson, successText } from "../services/responseBuilders";
import { compileSafeRegex, makeScopeFilter } from "../services/safeRegex";
import type { App } from "obsidian";
import {
  projectSimpleSearchResults,
  withSearchResultsPayload,
} from "$/features/mcp-apps/services/searchResultsPayload";
import { buildObsidianUri } from "../services/buildObsidianUri";

const DEFAULT_CONTEXT = 100;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_MATCHES_PER_FILE = 5;

export const searchVaultSimpleSchema = type({
  name: '"search_vault_simple"',
  arguments: {
    query: type("string>0").describe(
      "Text to search for. A literal substring by default; a JavaScript regex source (no surrounding `/`) when `regex` is `true`.",
    ),
    "regex?": type("boolean").describe(
      "When `true`, `query` is a JavaScript regular expression (`g` is added for you; `i` unless `caseSensitive`). Patterns with nested quantifiers are refused (`unsafe_regex`). Default `false`.",
    ),
    "caseSensitive?": type("boolean").describe(
      "When `true`, letter case must match. Default `false`.",
    ),
    "scope?": type("string[]").describe(
      "Restrict the search to these vault-relative file paths (with or without `.md`) or folders (recursive). Omitted: the whole vault.",
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
  "Text search across the markdown files of the vault, or of a `scope` of files and folders: a case-insensitive literal substring by default, case-sensitive with `caseSensitive`, a JavaScript regex with `regex`. Returns each matching file with surrounding context for each hit, including the 0-indexed line each match starts at and, for regex searches, the matched `text`.",
);

export type SearchVaultSimpleContext = {
  arguments: {
    query: string;
    regex?: boolean;
    caseSensitive?: boolean;
    scope?: string[];
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
   * Only an explicit `false` withholds the payload. `undefined` must never
   * be read as "declared: false" — the legacy era's unconditional attach
   * depends on that distinction.
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
    /** The matched text; present for regex searches only, where it varies. */
    text?: string;
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
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const query = ctx.arguments.query;
  const isRegex = ctx.arguments.regex ?? false;
  const caseSensitive = ctx.arguments.caseSensitive ?? false;
  const contextLength = ctx.arguments.contextLength ?? DEFAULT_CONTEXT;
  const limit = ctx.arguments.limit ?? DEFAULT_LIMIT;
  const maxMatchesPerFile =
    ctx.arguments.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE;
  const flags = caseSensitive ? "g" : "gi";
  const patternSource = isRegex ? query : escapeRegExp(query);
  if (isRegex) {
    const compiled = compileSafeRegex(patternSource, flags);
    if (!compiled.ok) {
      return errorJson(compiled.message, compiled.errorCode, {
        pattern: query,
        flags,
      });
    }
  }

  const inScope = makeScopeFilter(ctx.arguments.scope);
  const files = ctx.app.vault.getMarkdownFiles().filter((f) => inScope(f.path));
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
        const scanner = new RegExp(patternSource, flags);
        while ((m = scanner.exec(content)) !== null) {
          // One match past the cap is enough to know there are more: stop
          // scanning there instead of collecting a file's worth of hits
          // that are about to be dropped (R-02, ADR-0023 D2).
          if (matches.length >= maxMatchesPerFile) {
            moreMatches = true;
            break;
          }
          const idx = m.index;
          // A literal pattern always matches exactly `query.length`
          // characters; a regex match varies and may be empty.
          const matchLength = isRegex ? m[0].length : query.length;
          const start = Math.max(0, idx - contextLength);
          const end = Math.min(
            content.length,
            idx + matchLength + contextLength,
          );
          matches.push({
            context: content.slice(start, end),
            line: content.slice(0, idx).split("\n").length - 1,
            ...(isRegex ? { text: m[0] } : {}),
          });
          // Step past the match (at least one character, so an empty
          // regex match cannot loop forever).
          scanner.lastIndex = idx + Math.max(1, matchLength);
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

  const vaultName = ctx.app.vault.getName();
  const wireResults = results.map((r) => ({
    ...r,
    uri: buildObsidianUri(vaultName, r.filename),
  }));
  const result = successText(JSON.stringify({ results: wireResults }));
  // `=== false` and not `!ctx.hasUiCapability`: only an explicit, declared
  // NON-support withholds the payload (R-09, ADR-0023 D9). `undefined` is
  // "no signal" — the legacy era, which is stateless and POST-only and
  // therefore cannot have one — and keeps attaching unconditionally.
  if (ctx.hasUiCapability === false) return result;
  return withSearchResultsPayload(
    result,
    projectSimpleSearchResults(results, ctx.app.vault.getName()),
  );
}
