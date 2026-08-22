import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { App, TFile } from "obsidian";
import { createExclusionFilter } from "$/shared/isUserIgnored";

export const getRecentFilesSchema = type({
  name: '"get_recent_files"',
  arguments: {
    "limit?": type("1<=number.integer<=100").describe(
      "Maximum number of files to return (1-100, default 20). Values outside this range, zero, negative, or non-integer numbers are rejected at schema validation.",
    ),
  },
}).describe(
  "Returns the most recently modified markdown files in the vault, ordered by `mtime` descending with a `path` ascending tiebreaker on equal `mtime`. Each entry includes `path`, `mtime`, `ctime` (Unix epoch milliseconds), and `size` (bytes). Honours Obsidian's `Files & Links → Excluded files` configuration via `MetadataCache.isUserIgnored`; markdown-only via `vault.getMarkdownFiles()`. Useful for agent-recency context. Always read-only.",
);

export type GetRecentFilesContext = {
  arguments: { limit?: number };
  app: App;
};

/**
 * Returns every visible (non-`isUserIgnored`) markdown file in the vault,
 * sorted by `mtime` descending with a locale-pinned `path` ascending
 * tiebreaker. Unsliced — callers apply their own limit. Exported so
 * get_vault_overview reuses the same exclusion + sort rather than
 * growing a third copy of either.
 */
export function getSortedVisibleMarkdownFiles(app: App): TFile[] {
  // The shared primitive, not a second copy of it. This function used to
  // hand-roll the `isUserIgnored` lookup, its own one-shot warning and
  // its own module flag — identical in behaviour to
  // `createExclusionFilter` and free to drift from it, which is exactly
  // what ADR-0020 found while mapping the exclusion surface.
  //
  // Note what this filter is NOT. It honours Obsidian's own
  // `Files & Links → Excluded files`, which stays independent of the
  // hidden-folder policy (ADR-0020 §D4): the policy is enforced above
  // this function, on the guarded `App` that `app.vault` here already
  // is, and deliberately does not also apply `isUserIgnored`.
  const isUserIgnored = createExclusionFilter(app);
  const visible = app.vault
    .getMarkdownFiles()
    .filter((f: TFile) => !isUserIgnored(f.path));

  // Pinned locale + sensitivity for cross-platform deterministic order
  // on the tiebreaker (matches the contract used by `list_tags` /
  // `get_files_by_tag`). Without this, the default `Intl.Collator`
  // reads the OS locale, which can shift Unicode ordering between
  // macOS / Linux / Windows test runs.
  const comparePath = (a: string, b: string): number =>
    a.localeCompare(b, "en", { sensitivity: "variant" });

  return visible.sort((a, b) => {
    // Primary: mtime descending (most-recent first).
    if (b.stat.mtime !== a.stat.mtime) return b.stat.mtime - a.stat.mtime;
    // Secondary: path ascending. `Array.prototype.sort` stability is
    // guaranteed by ES2019 (V8 / Bun honour it) but the response
    // contract should not rely on that — an explicit tiebreaker keeps
    // the API deterministic across repeat calls when several files
    // share an `mtime` (common on bulk imports / sync events).
    return comparePath(a.path, b.path);
  });
}

export async function getRecentFilesHandler(
  ctx: GetRecentFilesContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const limit = ctx.arguments.limit ?? 20;

  const visible = getSortedVisibleMarkdownFiles(ctx.app);

  // `totalFiles` reports the size of the visible (post-exclusion) set,
  // before the recency slice. Matches the contract of `get_files_by_tag`
  // where `totalFiles` is the total match count, not the page size.
  const totalFiles = visible.length;

  const files = visible.slice(0, limit).map((f) => ({
    path: f.path,
    mtime: f.stat.mtime,
    ctime: f.stat.ctime,
    size: f.stat.size,
  }));

  const output = { totalFiles, files };

  return successText(JSON.stringify(output));
}
