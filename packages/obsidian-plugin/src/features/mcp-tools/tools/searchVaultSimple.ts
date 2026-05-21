import { type } from "arktype";
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

/**
 * Search vault files for plain-text substring matches. Iterates over all
 * markdown files, performs case-insensitive search, extracts context
 * windows around each match, and respects the client-side limit truncation
 * (fix for issue #62).
 */
export async function searchVaultSimpleHandler(
  ctx: SearchVaultSimpleContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = ctx.arguments.query;
  const contextLength = ctx.arguments.contextLength ?? DEFAULT_CONTEXT;
  const limit = ctx.arguments.limit ?? DEFAULT_LIMIT;
  const lowerQuery = query.toLowerCase();

  const files = ctx.app.vault.getMarkdownFiles();
  const results: FileResult[] = [];

  for (const file of files) {
    if (results.length >= limit) break; // #62 fix: client-side truncation

    const content = await ctx.app.vault.cachedRead(file);
    const lower = content.toLowerCase();
    const matches: FileResult["matches"] = [];

    let idx = 0;
    while ((idx = lower.indexOf(lowerQuery, idx)) !== -1) {
      const start = Math.max(0, idx - contextLength);
      const end = Math.min(content.length, idx + query.length + contextLength);
      matches.push({
        context: content.slice(start, end),
        match: { start: idx, end: idx + query.length },
      });
      idx += query.length;
    }

    if (matches.length > 0) {
      results.push({ filename: file.path, matches });
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
  };
}
