import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { App, TFile } from "obsidian";
import { logger } from "$/shared/logger";

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

// Module-scope flag for the one-shot warning when Obsidian's runtime
// `isUserIgnored` accessor cannot be found. If the API ever gets
// renamed or removed in a future Obsidian release, this surfaces the
// regression in the plugin log on first call (rather than silently
// returning user-ignored entries in `files` and `totalFiles`). Reset
// helper is exported for tests; production callers should not touch
// it.
let _warnedMissingIsUserIgnored = false;

/** @internal — test-only reset of the one-shot warning flag. */
export function _resetMissingIsUserIgnoredWarning(): void {
  _warnedMissingIsUserIgnored = false;
}

/**
 * Returns every visible (non-`isUserIgnored`) markdown file in the vault,
 * sorted by `mtime` descending with a locale-pinned `path` ascending
 * tiebreaker. Unsliced — callers apply their own limit. Exported so
 * get_vault_overview reuses the same exclusion + sort instead of
 * duplicating the one-shot missing-API warning below (a second copy
 * would need its own module flag and could double-fire the warning).
 */
export function getSortedVisibleMarkdownFiles(app: App): TFile[] {
  // `MetadataCache.isUserIgnored(path)` is part of Obsidian's runtime API
  // but is not surfaced by the bundled `obsidian.d.ts`. The cast through
  // `unknown` keeps us aligned with the codebase pattern used for other
  // metadata-cache accessors (see listTags.ts:30). Treated as optional so
  // tests that do not stub it keep working.
  const isUserIgnored = (
    app.metadataCache as unknown as {
      isUserIgnored?: (path: string) => boolean;
    }
  ).isUserIgnored?.bind(app.metadataCache);

  if (!isUserIgnored && !_warnedMissingIsUserIgnored) {
    _warnedMissingIsUserIgnored = true;
    // One-shot per process. If Obsidian renames or drops the runtime
    // accessor, the filter degrades to "no exclusion applied" — this
    // warn makes the regression observable in the log instead of
    // silently surfacing user-ignored entries to the agent.
    logger.warn(
      "get_recent_files: app.metadataCache.isUserIgnored is unavailable — `Files & Links → Excluded files` filtering disabled for this session. If you see this in production, the Obsidian runtime API may have changed.",
    );
  }

  const allMarkdown = app.vault.getMarkdownFiles();
  const visible = isUserIgnored
    ? allMarkdown.filter((f: TFile) => !isUserIgnored(f.path))
    : allMarkdown;

  // Pinned locale + sensitivity for cross-platform deterministic order
  // on the tiebreaker (matches the contract used by `list_tags` /
  // `get_files_by_tag`). Without this, the default `Intl.Collator`
  // reads the OS locale, which can shift Unicode ordering between
  // macOS / Linux / Windows test runs.
  const comparePath = (a: string, b: string): number =>
    a.localeCompare(b, "en", { sensitivity: "variant" });

  return visible.slice().sort((a, b) => {
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
