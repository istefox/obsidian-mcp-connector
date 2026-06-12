import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { App } from "obsidian";

export const getBacklinksSchema = type({
  name: '"get_backlinks"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path of the target file. The tool returns every file that links to this path.",
    ),
    "includeUnresolved?": type('"true" | "false"').describe(
      'When `"true"`, also includes sources whose link does not resolve (typo or broken-link sources matching by path or filename). Default `"false"`: unresolved backlinks are usually noise.',
    ),
    "limit?": type("number>0").describe("Max results returned (default 200)."),
  },
}).describe(
  "Lists every file linking to the target, with per-source link count, sorted by count descending. Works even if the target does not exist (backlinks can outlive it). Read-only.",
);

export type GetBacklinksContext = {
  arguments: {
    path: string;
    includeUnresolved?: "true" | "false";
    limit?: number;
  };
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

  const limit = Math.min(
    1000,
    Math.max(1, Math.floor(ctx.arguments.limit ?? 200)),
  );
  const truncated = backlinks.length > limit;

  const output = {
    target,
    totalBacklinks: backlinks.length,
    ...(truncated ? { truncated: true } : {}),
    backlinks: truncated ? backlinks.slice(0, limit) : backlinks,
  };

  return successText(JSON.stringify(output));
}
