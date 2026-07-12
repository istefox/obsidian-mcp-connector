import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { App } from "obsidian";

export const listTagsSchema = type({
  name: '"list_tags"',
  arguments: {
    "sort?": type('"name" | "count"').describe(
      "Sort by tag name (alphabetical, ascending) or by usage count (descending). Defaults to 'count'.",
    ),
    "limit?": type("number>0").describe("Max results returned (default 200)."),
  },
}).describe(
  "Lists all tags used across the vault with their usage counts. Aggregates both inline `#tags` and frontmatter tags via Obsidian's metadata cache. Useful for discovering content categories, finding related notes, and understanding vault organization. Always read-only.",
);

export type ListTagsContext = {
  arguments: { sort?: "name" | "count"; limit?: number };
  app: App;
};

/**
 * `MetadataCache.getTags()` returns a `Record<string, number>` keyed by
 * tag (with the leading `#`), value = aggregated count across the vault.
 * The signature is part of Obsidian's public API but the cast through
 * `unknown` keeps us aligned with the codebase pattern used for other
 * metadata-cache accessors that the bundled `obsidian.d.ts` does not
 * surface directly (see listObsidianCommands.ts). Exported so other
 * tools (get_vault_overview) can reuse the same lookup, unsorted.
 */
export function getTagCounts(app: App): Array<{ tag: string; count: number }> {
  const tagCounts = (
    app.metadataCache as unknown as {
      getTags: () => Record<string, number>;
    }
  ).getTags();
  return Object.entries(tagCounts).map(([tag, count]) => ({ tag, count }));
}

export async function listTagsHandler(
  ctx: ListTagsContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const tagCounts = getTagCounts(ctx.app);

  const sortMode = ctx.arguments.sort ?? "count";

  // Pin locale + sensitivity so the order is identical across platforms;
  // the default `Intl.Collator` reads the OS locale, which can shift
  // Unicode ordering between macOS / Linux / Windows test runs.
  const compareName = (a: string, b: string): number =>
    a.localeCompare(b, "en", { sensitivity: "variant" });

  const all = tagCounts.slice().sort((a, b) => {
    if (sortMode === "name") return compareName(a.tag, b.tag);
    // Count desc with name-asc tiebreaker. Engine sort-stability is
    // guaranteed by ES2019 (V8/Bun honour it), but an explicit
    // tiebreaker keeps the contract independent of that guarantee
    // and gives equal-count tags a deterministic, alphabetical order.
    if (b.count !== a.count) return b.count - a.count;
    return compareName(a.tag, b.tag);
  });

  const limit = Math.min(
    1000,
    Math.max(1, Math.floor(ctx.arguments.limit ?? 200)),
  );
  const truncated = all.length > limit;

  const output = {
    totalTags: all.length,
    ...(truncated ? { truncated: true } : {}),
    tags: truncated ? all.slice(0, limit) : all,
  };

  return successText(JSON.stringify(output));
}
