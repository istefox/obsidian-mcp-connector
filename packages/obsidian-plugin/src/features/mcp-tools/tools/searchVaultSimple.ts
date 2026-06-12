import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { App } from "obsidian";

const DEFAULT_CONTEXT = 100;
const DEFAULT_LIMIT = 50;

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
  },
}).describe(
  "Plain-text substring search across all markdown files in the vault. Returns each matching file with surrounding context for each hit.",
);

export type SearchVaultSimpleContext = {
  arguments: { query: string; contextLength?: number; limit?: number };
  app: App;
};

type FileResult = {
  filename: string;
  matches: Array<{ context: string; match: { start: number; end: number } }>;
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
        const scanner = new RegExp(patternSource, "gi");
        while ((m = scanner.exec(content)) !== null) {
          const idx = m.index;
          const start = Math.max(0, idx - contextLength);
          const end = Math.min(
            content.length,
            idx + query.length + contextLength,
          );
          matches.push({
            context: content.slice(start, end),
            match: { start: idx, end: idx + query.length },
          });
          // Match length equals query length (literal pattern), so this
          // mirrors the previous `idx += query.length` stepping.
          scanner.lastIndex = idx + query.length;
        }

        return matches.length > 0 ? { filename: file.path, matches } : null;
      }),
    );

    for (const r of batchResults) {
      if (r === null) continue;
      if (results.length >= limit) break; // #62 fix: client-side truncation
      results.push(r);
    }
  }

  return successText(JSON.stringify({ results }));
}
