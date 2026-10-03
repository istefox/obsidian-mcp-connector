import { type } from "arktype";
import type { App, TFile } from "obsidian";
import { errorJson, successJson } from "../services/responseBuilders";
import { withVaultWriteLock } from "../services/vaultWriteLock";
import { comparePaths } from "../services/pathUtils";

export const renameTagSchema = type({
  name: '"rename_tag"',
  arguments: {
    tag: type("string>0").describe(
      "Tag to rename, leading `#` optional, matched case-insensitively (Obsidian tags are).",
    ),
    newTag: type("string>0").describe(
      "New tag name, leading `#` optional. Letters, digits, `_`, `-` and `/` only, at least one non-digit.",
    ),
    "includeNested?": type("boolean").describe(
      "When `true` (default) `#project` also renames `#project/active` to `#new/active`. `false` renames the exact tag only.",
    ),
    "scope?": type("string[]").describe(
      "Vault-relative folder or file paths to restrict the rename to. Default: the whole vault.",
    ),
    "dry_run?": type("boolean").describe(
      "`true` (default) only reports what would change. Pass `false` to write.",
    ),
  },
}).describe(
  "Renames a tag everywhere: inline `#tag` occurrences (located through Obsidian's metadata cache, so text inside code blocks, URLs and headings that merely contains the word is left alone) and the `tags` / `tag` frontmatter properties, with nested tags following by default. Dry run by default; pass `dry_run: false` to apply. Each file is rewritten atomically. Returns per-file counts of inline and frontmatter replacements.",
);

export type RenameTagContext = {
  arguments: {
    tag: string;
    newTag: string;
    includeNested?: boolean;
    scope?: string[];
    dry_run?: boolean;
  };
  app: App;
};

type TagCacheEntry = {
  tag: string;
  position: {
    start: { line: number; col?: number };
    end?: { line: number; col?: number };
  };
};

type FileDetail = {
  path: string;
  inline: number;
  frontmatter: number;
};

/** Obsidian's tag alphabet: letters, digits, `_`, `-`, `/`; not all digits. */
const TAG_CHARS = /^[\p{L}\p{N}_\-/]+$/u;
const TAG_CHAR_CLASS = "[\\p{L}\\p{N}_\\-/]";

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "");
}

export function isValidTag(bare: string): boolean {
  return (
    bare.length > 0 &&
    TAG_CHARS.test(bare) &&
    !/^[\p{N}]+$/u.test(bare) &&
    !bare.startsWith("/") &&
    !bare.endsWith("/") &&
    !bare.includes("//")
  );
}

/**
 * The renamed form of one tag value (without `#`), or null when it is
 * not the tag being renamed. Case-insensitive on the matched prefix; the
 * nested suffix keeps its case.
 */
export function renameOne(
  value: string,
  from: string,
  to: string,
  includeNested: boolean,
): string | null {
  const lower = value.toLowerCase();
  const fromLower = from.toLowerCase();
  if (lower === fromLower) return to;
  if (includeNested && lower.startsWith(`${fromLower}/`)) {
    return `${to}${value.slice(from.length)}`;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Rewrite the inline occurrences the cache lists for this content. Each
 * entry is checked against the text at its position first; if the cache
 * is a beat behind an edit, the tag is searched on its line instead, and
 * a line where it cannot be found is skipped rather than guessed at.
 */
export function renameInline(
  content: string,
  entries: TagCacheEntry[],
  from: string,
  to: string,
  includeNested: boolean,
): { content: string; count: number } {
  const lines = content.split("\n");
  let count = 0;
  // Right-to-left within a line so earlier columns stay valid.
  const sorted = entries
    .filter(
      (e) => renameOne(normalizeTag(e.tag), from, to, includeNested) !== null,
    )
    .sort((a, b) =>
      a.position.start.line !== b.position.start.line
        ? b.position.start.line - a.position.start.line
        : (b.position.start.col ?? 0) - (a.position.start.col ?? 0),
    );
  const fallback = new RegExp(
    `(?<![#&${TAG_CHAR_CLASS.slice(1, -1)}])#(${escapeRegExp(from)}${
      includeNested ? `(?:/${TAG_CHAR_CLASS}+)?` : ""
    })(?!${TAG_CHAR_CLASS})`,
    "giu",
  );
  for (const entry of sorted) {
    const lineNo = entry.position.start.line;
    const line = lines[lineNo];
    if (line === undefined) continue;
    const bare = normalizeTag(entry.tag);
    const renamed = renameOne(bare, from, to, includeNested)!;
    const startCol = entry.position.start.col;
    const endCol = entry.position.end?.col;
    if (
      startCol !== undefined &&
      endCol !== undefined &&
      entry.position.end?.line === lineNo &&
      line.slice(startCol, endCol).toLowerCase() === `#${bare}`.toLowerCase()
    ) {
      lines[lineNo] =
        `${line.slice(0, startCol)}#${renamed}${line.slice(endCol)}`;
      count++;
      continue;
    }
    fallback.lastIndex = 0;
    let replaced = false;
    lines[lineNo] = line.replace(fallback, (whole, captured: string) => {
      if (replaced || captured.toLowerCase() !== bare.toLowerCase())
        return whole;
      replaced = true;
      return `#${renamed}`;
    });
    if (replaced) count++;
  }
  return { content: lines.join("\n"), count };
}

/** Rewrite a `tags`/`tag` frontmatter value; returns the new value and how many entries changed. */
export function renameFrontmatterValue(
  value: unknown,
  from: string,
  to: string,
  includeNested: boolean,
): { value: unknown; count: number } {
  const one = (s: string): string | null => {
    const hash = s.startsWith("#");
    const renamed = renameOne(normalizeTag(s), from, to, includeNested);
    return renamed === null ? null : `${hash ? "#" : ""}${renamed}`;
  };
  if (Array.isArray(value)) {
    let count = 0;
    const items: unknown[] = value;
    const next = items.map((item) => {
      if (typeof item !== "string") return item;
      const r = one(item);
      if (r === null) return item;
      count++;
      return r;
    });
    return { value: next, count };
  }
  if (typeof value === "string") {
    // Obsidian accepts `tags: a, b c` as a list.
    const parts = value.split(/([,\s]+)/);
    let count = 0;
    const next = parts
      .map((part, i) => {
        if (i % 2 === 1 || part === "") return part;
        const r = one(part);
        if (r === null) return part;
        count++;
        return r;
      })
      .join("");
    return { value: next, count };
  }
  return { value, count: 0 };
}

/**
 * Per-file entries listed in the response. A tag used across thousands of
 * notes would otherwise return one line per note; the totals above stay
 * exact and `detailsTruncated` says the list was cut.
 */
const MAX_DETAILS = 200;

export async function renameTagHandler(ctx: RenameTagContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const from = normalizeTag(ctx.arguments.tag);
  const to = normalizeTag(ctx.arguments.newTag);
  const includeNested = ctx.arguments.includeNested ?? true;
  const dryRun = ctx.arguments.dry_run !== false;
  const scope = ctx.arguments.scope;

  if (!isValidTag(from)) {
    return errorJson(
      `Invalid tag: ${JSON.stringify(ctx.arguments.tag)}.`,
      "invalid_tag",
      { tag: ctx.arguments.tag },
    );
  }
  if (!isValidTag(to)) {
    return errorJson(
      `Invalid new tag: ${JSON.stringify(ctx.arguments.newTag)}. Use letters, digits, "_", "-" and "/", with at least one non-digit.`,
      "invalid_tag",
      { tag: ctx.arguments.newTag },
    );
  }
  if (from.toLowerCase() === to.toLowerCase()) {
    return errorJson(
      "The new tag is the same as the old one (tags are case-insensitive).",
      "invalid_params",
      { tag: from, newTag: to },
    );
  }

  const inScope = (path: string): boolean => {
    if (!scope || scope.length === 0) return true;
    return scope.some(
      (s) =>
        path === s ||
        path === `${s}.md` ||
        path.startsWith(s.endsWith("/") ? s : `${s}/`),
    );
  };

  const details: FileDetail[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  let totalInline = 0;
  let totalFrontmatter = 0;
  let filesMatched = 0;

  const files: TFile[] = ctx.app.vault
    .getMarkdownFiles()
    .filter((f) => inScope(f.path))
    .sort((a, b) => comparePaths(a.path, b.path));

  for (const file of files) {
    const cache = ctx.app.metadataCache.getFileCache(file) as {
      tags?: TagCacheEntry[];
      frontmatter?: Record<string, unknown>;
    } | null;
    if (!cache) continue;
    const inlineEntries = (cache.tags ?? []).filter(
      (e) => renameOne(normalizeTag(e.tag), from, to, includeNested) !== null,
    );
    const fmKeys = (["tags", "tag"] as const).filter(
      (k) =>
        cache.frontmatter &&
        renameFrontmatterValue(cache.frontmatter[k], from, to, includeNested)
          .count > 0,
    );
    if (inlineEntries.length === 0 && fmKeys.length === 0) continue;

    let inline = 0;
    let frontmatter = 0;
    if (dryRun) {
      inline = renameInline(
        await ctx.app.vault.cachedRead(file),
        inlineEntries,
        from,
        to,
        includeNested,
      ).count;
      for (const k of fmKeys) {
        frontmatter += renameFrontmatterValue(
          cache.frontmatter![k],
          from,
          to,
          includeNested,
        ).count;
      }
    } else {
      try {
        await withVaultWriteLock(async () => {
          // Inline first: the cache positions describe the body as it is
          // now. The frontmatter rewrite re-parses YAML on its own and
          // does not depend on them.
          if (inlineEntries.length > 0) {
            await ctx.app.vault.process(file, (current) => {
              const r = renameInline(
                current,
                inlineEntries,
                from,
                to,
                includeNested,
              );
              inline = r.count;
              return r.count === 0 ? current : r.content;
            });
          }
          if (fmKeys.length > 0) {
            await ctx.app.fileManager.processFrontMatter(file, (fm) => {
              const data = fm as Record<string, unknown>;
              for (const k of fmKeys) {
                const r = renameFrontmatterValue(
                  data[k],
                  from,
                  to,
                  includeNested,
                );
                if (r.count === 0) continue;
                data[k] = r.value;
                frontmatter += r.count;
              }
            });
          }
        });
      } catch (error) {
        failed.push({
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    totalInline += inline;
    totalFrontmatter += frontmatter;
    filesMatched += 1;
    if (details.length < MAX_DETAILS) {
      details.push({ path: file.path, inline, frontmatter });
    }
  }

  const body = {
    dry_run: dryRun,
    tag: `#${from}`,
    newTag: `#${to}`,
    includeNested,
    files_matched: filesMatched,
    inline_replacements: totalInline,
    frontmatter_replacements: totalFrontmatter,
    ...(filesMatched > details.length ? { detailsTruncated: true } : {}),
    details,
  };
  if (failed.length > 0) {
    return errorJson(
      `rename_tag updated ${filesMatched} file(s) but ${failed.length} write(s) failed.`,
      "partial_failure",
      { ...body, failedFiles: failed },
    );
  }
  return successJson(body);
}
