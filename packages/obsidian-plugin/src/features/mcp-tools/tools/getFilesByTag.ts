import { type } from "arktype";
import type { App, TFile } from "obsidian";

export const getFilesByTagSchema = type({
  name: '"get_files_by_tag"',
  arguments: {
    tag: type("string>0").describe(
      "Tag to search for. The leading `#` is optional and matching is case-insensitive.",
    ),
    "includeNested?": type('"true" | "false"').describe(
      'When `"true"` (default), `tag="#project"` matches `#project`, `#project/active`, `#project/archived`, etc., mirroring Obsidian\'s hierarchical tag pane behaviour. When `"false"`, only exact matches are returned.',
    ),
  },
}).describe(
  "Returns all vault files tagged with the given tag, with per-file occurrence count. Aggregates inline `#tags` and frontmatter tags via Obsidian's metadata cache (`getAllTags`). Sorted by occurrence count descending, with file path tiebreaker for determinism. Always read-only.",
);

export type GetFilesByTagContext = {
  arguments: { tag: string; includeNested?: "true" | "false" };
  app: App;
};

export async function getFilesByTagHandler(ctx: GetFilesByTagContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  // Strip leading `#` characters and lowercase. The tag pane in
  // Obsidian is case-insensitive at display, so we mirror that for
  // the lookup contract.
  const normalized = ctx.arguments.tag.trim().replace(/^#+/, "").toLowerCase();
  if (!normalized) {
    return {
      content: [
        {
          type: "text",
          text: 'Invalid tag: input is empty or contains only "#" characters.',
        },
      ],
      isError: true,
    };
  }

  const includeNested = (ctx.arguments.includeNested ?? "true") === "true";

  // Pinned locale + sensitivity for cross-platform deterministic order
  // (matches the contract used by `list_tags`).
  const compareName = (a: string, b: string): number =>
    a.localeCompare(b, "en", { sensitivity: "variant" });

  // Count occurrences directly from `cache.tags` (per-occurrence, not
  // deduped) and `cache.frontmatter.tags` so that the resulting
  // `count` represents how many times the tag actually appears in the
  // file. The public `getAllTags()` helper would dedupe and collapse
  // count to a binary present/absent — losing relevance signal.
  const matches = (tagBare: string): boolean => {
    if (tagBare === normalized) return true;
    if (includeNested && tagBare.startsWith(`${normalized}/`)) return true;
    return false;
  };

  const counts: Array<{ path: string; count: number }> = [];
  for (const file of ctx.app.vault.getMarkdownFiles()) {
    const cache = ctx.app.metadataCache.getFileCache(file as TFile);
    if (!cache) continue;

    let n = 0;
    // Inline tags — `cache.tags` is `TagCache[]`, one entry per
    // occurrence in the body of the note.
    const inline = (cache as { tags?: Array<{ tag: string }> }).tags ?? [];
    for (const t of inline) {
      const tagBare = (t.tag ?? "").replace(/^#+/, "").toLowerCase();
      if (matches(tagBare)) n++;
    }
    // Frontmatter tags — array form (`tags: [...]`) or single-string
    // form (`tags: "..."`). Each entry counts as one occurrence.
    const fmTags = (cache as { frontmatter?: Record<string, unknown> })
      .frontmatter?.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t !== "string") continue;
        if (matches(t.replace(/^#+/, "").toLowerCase())) n++;
      }
    } else if (typeof fmTags === "string") {
      if (matches(fmTags.replace(/^#+/, "").toLowerCase())) n++;
    }

    if (n > 0) counts.push({ path: file.path, count: n });
  }

  counts.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return compareName(a.path, b.path);
  });

  const output = {
    tag: `#${normalized}`,
    includeNested,
    totalFiles: counts.length,
    files: counts,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
  };
}
