import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { App } from "obsidian";

export const listTagsSchema = type({
  name: '"list_tags"',
  arguments: {
    "sort?": type('"name" | "count"').describe(
      "Sort by tag name (alphabetical, ascending) or by usage count (descending). Defaults to 'count'.",
    ),
  },
}).describe(
  "Lists all tags used across the vault with their usage counts. Aggregates both inline `#tags` and frontmatter tags via Obsidian's metadata cache. Useful for discovering content categories, finding related notes, and understanding vault organization. Always read-only.",
);

export type ListTagsContext = {
  arguments: { sort?: "name" | "count" };
  app: App;
};

export async function listTagsHandler(
  ctx: ListTagsContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // `MetadataCache.getTags()` returns a `Record<string, number>` keyed by
  // tag (with the leading `#`), value = aggregated count across the vault.
  // The signature is part of Obsidian's public API but the cast through
  // `unknown` keeps us aligned with the codebase pattern used for other
  // metadata-cache accessors that the bundled `obsidian.d.ts` does not
  // surface directly (see listObsidianCommands.ts).
  const tagCounts = (
    ctx.app.metadataCache as unknown as {
      getTags: () => Record<string, number>;
    }
  ).getTags();

  const sortMode = ctx.arguments.sort ?? "count";

  // Pin locale + sensitivity so the order is identical across platforms;
  // the default `Intl.Collator` reads the OS locale, which can shift
  // Unicode ordering between macOS / Linux / Windows test runs.
  const compareName = (a: string, b: string): number =>
    a.localeCompare(b, "en", { sensitivity: "variant" });

  const sorted = Object.entries(tagCounts).sort((a, b) => {
    if (sortMode === "name") return compareName(a[0], b[0]);
    // Count desc with name-asc tiebreaker. Engine sort-stability is
    // guaranteed by ES2019 (V8/Bun honour it), but an explicit
    // tiebreaker keeps the contract independent of that guarantee
    // and gives equal-count tags a deterministic, alphabetical order.
    if (b[1] !== a[1]) return b[1] - a[1];
    return compareName(a[0], b[0]);
  });

  const output = {
    totalTags: sorted.length,
    tags: sorted.map(([tag, count]) => ({ tag, count })),
  };

  return successText(JSON.stringify(output, null, 2));
}
