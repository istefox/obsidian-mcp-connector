import type { App } from "obsidian";
import { logger } from "$/shared/logger";

// One-shot per process. If Obsidian renames or drops the runtime
// `MetadataCache.isUserIgnored` accessor, the predicate degrades to
// "nothing excluded" — this warn makes the regression observable in the
// log instead of silently re-admitting excluded files to the index.
let _warnedMissingIsUserIgnored = false;

/** @internal — test-only reset of the one-shot warning flag. */
export function _resetIsUserIgnoredWarning(): void {
  _warnedMissingIsUserIgnored = false;
}

/**
 * Build a path-exclusion predicate honouring Obsidian's
 * `Files & Links → Excluded files` setting.
 *
 * `MetadataCache.isUserIgnored(path)` is part of Obsidian's runtime API
 * but is not surfaced by the bundled `obsidian.d.ts`; the cast through
 * `unknown` mirrors the codebase pattern used for other metadata-cache
 * accessors (see `listTags.ts` / `getRecentFiles.ts`). When the accessor
 * is unavailable the predicate returns `false` for every path (no
 * exclusion applied) and emits a one-shot warning, so a future Obsidian
 * API change surfaces in the log rather than silently changing
 * behaviour.
 */
export function createExclusionFilter(app: App): (path: string) => boolean {
  const isUserIgnored = (
    app.metadataCache as unknown as {
      isUserIgnored?: (path: string) => boolean;
    }
  ).isUserIgnored?.bind(app.metadataCache);

  if (!isUserIgnored) {
    if (!_warnedMissingIsUserIgnored) {
      _warnedMissingIsUserIgnored = true;
      logger.warn(
        "isUserIgnored unavailable — `Files & Links → Excluded files` filtering disabled for this session. If you see this in production, the Obsidian runtime API may have changed.",
      );
    }
    return () => false;
  }

  return (path: string) => isUserIgnored(path);
}
