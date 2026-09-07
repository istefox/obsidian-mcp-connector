import { parseLinktext, resolveSubpath, type App, type TFile } from "obsidian";

/**
 * Outcome of resolving a wiki-link's full linktext (file portion plus an
 * optional `#heading`/`#^block` subpath) to a concrete target.
 */
export type LinkResolution =
  | { resolved: true; file: TFile }
  | {
      resolved: false;
      file: TFile | null;
      reason: "file_not_found" | "subpath_not_found";
    };

/**
 * Resolves a linktext the way Obsidian does: the file portion must resolve
 * to a vault file, and — when present — the subpath must resolve to an
 * actual heading, block or footnote in that file's cache.
 *
 * `[[#Heading]]` has an empty file portion, which Obsidian treats as "this
 * document" (see #522); `getFirstLinkpathDest` returns null for an empty
 * linkpath, so that case is handled explicitly rather than delegated to it.
 *
 * A destination whose cache isn't available yet (not indexed, or excluded
 * by folder policy) is treated as resolved: absence of a cache entry is not
 * evidence of a missing heading, and a false "broken" report is worse than
 * a missed one (see #525).
 */
export function resolveLinkTarget(
  app: App,
  linktext: string,
  sourceFile: TFile,
): LinkResolution {
  const { path, subpath } = parseLinktext(linktext);

  const dest =
    path === ""
      ? sourceFile
      : app.metadataCache.getFirstLinkpathDest(path, sourceFile.path);
  if (dest === null) {
    return { resolved: false, file: null, reason: "file_not_found" };
  }

  if (subpath === "") return { resolved: true, file: dest };

  // Subpaths only apply to markdown notes (a `#page=3` on a PDF/image embed
  // is not a heading or block reference).
  if (dest.extension !== "md") return { resolved: true, file: dest };

  const cache = app.metadataCache.getFileCache(dest);
  if (cache === null) return { resolved: true, file: dest };

  return resolveSubpath(cache, subpath) !== null
    ? { resolved: true, file: dest }
    : { resolved: false, file: dest, reason: "subpath_not_found" };
}
