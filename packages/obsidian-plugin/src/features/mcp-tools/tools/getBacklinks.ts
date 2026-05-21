import { type } from "arktype";
import type { App } from "obsidian";

export const getBacklinksSchema = type({
  name: '"get_backlinks"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path of the target file. The tool returns every file that links to this path.",
    ),
    "includeUnresolved?": type('"true" | "false"').describe(
      'When `"true"`, also include backlinks where the source uses a linkpath that does not actually resolve to this file (typo or broken-link sources matching the target by path or filename). Default `"false"` because unresolved backlinks are usually noise; opt in when auditing or fixing broken links. For richer per-link context (display text, raw syntax) call `get_outgoing_links` from each source instead.',
    ),
  },
}).describe(
  "Returns every file that links to the given target, with per-source link count. Aggregates resolved backlinks via Obsidian's `metadataCache.resolvedLinks` reverse-index; opt-in `includeUnresolved` extends with broken-link sources matched by path or filename. Sorted by count descending with path tiebreaker for determinism. Always read-only. Does not error if the target file doesn't currently exist on disk — backlinks can outlive their target.",
);

export type GetBacklinksContext = {
  arguments: { path: string; includeUnresolved?: "true" | "false" };
  app: App;
};

export async function getBacklinksHandler(ctx: GetBacklinksContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const target = ctx.arguments.path;
  const includeUnresolved =
    (ctx.arguments.includeUnresolved ?? "false") === "true";

  const compareName = (a: string, b: string): number =>
    a.localeCompare(b, "en", { sensitivity: "variant" });

  // Per-source aggregated count → resolved + (optionally) unresolved
  // matches collapse into a single count for that source.
  const aggregated = new Map<string, number>();

  const resolvedLinks =
    (
      ctx.app.metadataCache as unknown as {
        resolvedLinks?: Record<string, Record<string, number>>;
      }
    ).resolvedLinks ?? {};
  for (const [source, targets] of Object.entries(resolvedLinks)) {
    const count = targets[target] ?? 0;
    if (count > 0) {
      aggregated.set(source, (aggregated.get(source) ?? 0) + count);
    }
  }

  if (includeUnresolved) {
    const unresolvedLinks =
      (
        ctx.app.metadataCache as unknown as {
          unresolvedLinks?: Record<string, Record<string, number>>;
        }
      ).unresolvedLinks ?? {};
    // Match by full path, by path without `.md`, or by filename — that
    // covers the common shapes of what an unresolved link looks like.
    const targetWithoutExt = target.replace(/\.md$/, "");
    const targetBasename =
      target.split("/").pop()?.replace(/\.md$/, "") ?? target;
    for (const [source, linkpaths] of Object.entries(unresolvedLinks)) {
      for (const [linkpath, count] of Object.entries(linkpaths)) {
        if (count <= 0) continue;
        if (
          linkpath === target ||
          linkpath === targetWithoutExt ||
          linkpath === targetBasename
        ) {
          aggregated.set(source, (aggregated.get(source) ?? 0) + count);
        }
      }
    }
  }

  const backlinks = Array.from(aggregated, ([path, count]) => ({
    path,
    count,
  }));
  backlinks.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return compareName(a.path, b.path);
  });

  const output = {
    target,
    totalBacklinks: backlinks.length,
    backlinks,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
  };
}
