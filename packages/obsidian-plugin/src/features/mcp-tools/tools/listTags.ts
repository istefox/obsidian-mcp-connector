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
 * One file's tags, inline and frontmatter, each occurrence listed
 * separately (never deduped) and each normalised to carry the leading
 * `#`, matching `MetadataCache.getTags()`'s key format. Mirrors the
 * counting logic in `getFilesByTag.ts` — `getAllTags()` would dedupe to
 * a binary present/absent per file, losing the occurrence count.
 */
function tagOccurrencesInFile(cache: unknown): string[] {
  const out: string[] = [];
  const inline = (cache as { tags?: Array<{ tag: string }> })?.tags ?? [];
  for (const t of inline) {
    const raw = t.tag ?? "";
    out.push(raw.startsWith("#") ? raw : `#${raw}`);
  }
  const fmTags = (cache as { frontmatter?: Record<string, unknown> })
    ?.frontmatter?.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t !== "string") continue;
      out.push(t.startsWith("#") ? t : `#${t}`);
    }
  } else if (typeof fmTags === "string") {
    out.push(fmTags.startsWith("#") ? fmTags : `#${fmTags}`);
  }
  return out;
}

/**
 * `MetadataCache.getTags()` returns a `Record<string, number>` keyed by
 * tag (with the leading `#`), value = aggregated count across the vault.
 * The signature is part of Obsidian's public API but the cast through
 * `unknown` keeps us aligned with the codebase pattern used for other
 * metadata-cache accessors that the bundled `obsidian.d.ts` does not
 * surface directly (see listObsidianCommands.ts). Exported so other
 * tools (get_vault_overview) can reuse the same lookup, unsorted.
 *
 * A guarded `App` under a non-empty exclusion policy makes `getTags()`
 * throw rather than return unfiltered counts, because tag counts carry
 * no file attribution to filter by (ADR-0020 D10). That throw is the
 * rebuild signal: fall back to counting occurrences from the guarded,
 * already-filtered file list, so an excluded file's tags are absent
 * rather than merely uncounted. With nothing excluded (or an unguarded
 * `App`), the native call above already succeeded and this branch never
 * runs — output stays byte-identical to pre-feature behaviour.
 */
export function getTagCounts(app: App): Array<{ tag: string; count: number }> {
  try {
    const tagCounts = (
      app.metadataCache as unknown as {
        getTags: () => Record<string, number>;
      }
    ).getTags();
    return Object.entries(tagCounts).map(([tag, count]) => ({ tag, count }));
  } catch {
    const counts = new Map<string, number>();
    for (const file of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache.getFileCache(file);
      if (!cache) continue;
      for (const tag of tagOccurrencesInFile(cache)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts, ([tag, count]) => ({ tag, count }));
  }
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
