import { type } from "arktype";
import type { App } from "obsidian";
import { logger } from "$/shared/logger";

export const findBrokenLinksSchema = type({
  name: '"find_broken_links"',
  arguments: {
    "exclude_folders?": type("string[]").describe(
      'Vault-relative folder prefixes to skip. Default: `["templates","attachments","_archive"]`. Override is complete (not additive): passing `["custom"]` scans templates too.',
    ),
    "scope?": type("string[]").describe(
      "Optional list of vault-relative paths or folder prefixes to limit the scan. A folder prefix matches any file under it. Omit for vault-wide scan.",
    ),
  },
}).describe(
  "Scans the vault (or a scoped subset) for unresolved links (wiki-links, markdown links, embeds, frontmatter links) and returns every broken link with its source file, 1-based line number, link target, original syntax, and link type. Uses Obsidian's metadata cache — no file I/O. Always read-only.",
);

export type FindBrokenLinksContext = {
  arguments: { exclude_folders?: string[]; scope?: string[] };
  app: App;
};

const DEFAULT_EXCLUDE = ["templates", "attachments", "_archive"];

type BrokenLinkEntry = {
  source_path: string;
  line_number: number;
  link_target: string;
  display_text?: string;
  link_type: "link" | "embed" | "frontmatter";
  original: string;
};

type RawCacheLink = {
  link: string;
  original: string;
  displayText?: string;
  position?: { start: { line: number } };
};

export async function findBrokenLinksHandler(
  ctx: FindBrokenLinksContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const rawExcludes = ctx.arguments.exclude_folders ?? DEFAULT_EXCLUDE;
  // Normalise: strip trailing slash for consistent prefix-match.
  const excludes = rawExcludes.map((e) => e.replace(/\/+$/, ""));
  const scope = ctx.arguments.scope?.map((s) => s.replace(/\/+$/, ""));

  const isExcluded = (path: string): boolean =>
    excludes.some((ex) => path === ex || path.startsWith(ex + "/"));

  const inScope = (path: string): boolean =>
    scope === undefined ||
    scope.some((s) => path === s || path.startsWith(s + "/"));

  const files = ctx.app.vault.getMarkdownFiles();
  const broken: BrokenLinkEntry[] = [];
  let scannedFiles = 0;

  for (const file of files) {
    if (isExcluded(file.path)) continue;
    if (!inScope(file.path)) continue;
    scannedFiles++;

    const cache = ctx.app.metadataCache.getFileCache(file);
    if (!cache) {
      logger.warn("find_broken_links: no cache for file, skipping", {
        path: file.path,
      });
      continue;
    }

    const check = (
      raw: RawCacheLink,
      kind: "link" | "embed" | "frontmatter",
    ): void => {
      const dest = ctx.app.metadataCache.getFirstLinkpathDest(
        raw.link,
        file.path,
      );
      if (dest !== null) return; // resolved — not broken
      const entry: BrokenLinkEntry = {
        source_path: file.path,
        // frontmatterLinks have no position; use 0 as sentinel.
        line_number: raw.position != null ? raw.position.start.line + 1 : 0,
        link_target: raw.link,
        link_type: kind,
        original: raw.original,
      };
      if (raw.displayText !== undefined) entry.display_text = raw.displayText;
      broken.push(entry);
    };

    const c = cache as {
      links?: RawCacheLink[];
      embeds?: RawCacheLink[];
      frontmatterLinks?: RawCacheLink[];
    };
    for (const l of c.links ?? []) check(l, "link");
    for (const e of c.embeds ?? []) check(e, "embed");
    for (const f of c.frontmatterLinks ?? []) check(f, "frontmatter");
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total_broken_links: broken.length,
            scanned_files: scannedFiles,
            excluded_folders: excludes,
            ...(scope !== undefined ? { scope } : {}),
            broken_links: broken,
          },
          null,
          2,
        ),
      },
    ],
  };
}
