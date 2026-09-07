/**
 * Converged heading/block anchor resolution, shared by `patch_active_file`,
 * `patch_vault_file`, `append_to_periodic_note`, `get_vault_file_partial`, and
 * `get_note_outline`. Replaces three independently hand-rolled matchers.
 * See docs/architecture/ADR-0024-converge-anchor-matchers.md.
 *
 * Pure and synchronous — no Obsidian API calls, no I/O.
 */

import { computeFenceOpenState } from "./patchHelpers";

export type HeadingEntry = { heading: string; level: number; line: number };

export type BlockIdResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export type HeadingResolution =
  | { kind: "found"; line: number; level: number; endLine: number }
  | { kind: "not-found"; segment: string; where: string }
  | {
      kind: "ambiguous";
      segment: string;
      candidates: HeadingEntry[];
      message: string;
    };

const INVALID_BLOCK_TARGET =
  'Invalid block target: input is empty or contains only "^" characters.';

const HEADING_LINE = /^(#{1,6})\s+(.+)$/;

function normalizeHeadingText(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Strip leading `^` characters (and surrounding whitespace) from a block
 * target. Obsidian addresses blocks without the caret in the metadata
 * cache; callers may pass either form. Shared across every block-lookup
 * call site (R-10).
 */
export function normalizeBlockId(target: string): BlockIdResult {
  const id = target.trim().replace(/^\^+/, "");
  if (!id) {
    return { ok: false, error: INVALID_BLOCK_TARGET };
  }
  return { ok: true, id };
}

/**
 * Split a `targetDelimiter`-joined nested heading path into its segments,
 * trimming whitespace and dropping blanks (so a repeated delimiter, e.g.
 * `"A::::B"`, does not produce an empty segment). (R-04)
 */
export function splitHeadingPath(target: string, delimiter: string): string[] {
  return target
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Convert a `targetDelimiter`-joined nested heading path into the `#`-chained
 * subpath form `resolveSubpath` expects (e.g. `"A::B"` -> `"#A#B"`). Used by
 * the differential test against `resolveSubpath`, not on the hot path. (R-04)
 */
export function headingPathToSubpath(
  target: string,
  delimiter: string,
): string {
  return splitHeadingPath(target, delimiter)
    .map((segment) => `#${segment}`)
    .join("");
}

/**
 * Scan raw file content for heading-shaped lines, skipping any line inside a
 * fenced code block (R-08). A line without a space after the `#` run (e.g.
 * `"#hashtag"`) is not a heading.
 */
export function headingEntriesFromContent(lines: string[]): HeadingEntry[] {
  const fenceOpen = computeFenceOpenState(lines);
  const entries: HeadingEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenceOpen[i]) continue;
    const m = lines[i].match(HEADING_LINE);
    if (m) {
      entries.push({ heading: m[2].trim(), level: m[1].length, line: i });
    }
  }
  return entries;
}

/**
 * Convert Obsidian's metadata-cache heading list into the shared
 * `HeadingEntry` shape. Tolerates an absent or empty cache.
 */
export function headingEntriesFromCache(
  cache:
    | {
        headings?: Array<{
          heading: string;
          level: number;
          position: { start: { line: number } };
        }>;
      }
    | null
    | undefined,
): HeadingEntry[] {
  if (!cache?.headings) return [];
  return cache.headings.map((h) => ({
    heading: h.heading,
    level: h.level,
    line: h.position.start.line,
  }));
}

/**
 * Resolve a nested heading path against a flat list of heading entries.
 * Generalised from `getVaultFilePartial.ts`'s `findHeadingSection`: same
 * `prevStartLine` / `prevEndLine` / `prevLevel` bounds, same closer
 * computation for `endLine`, same ambiguity and not-found message text —
 * with exact-text equality replaced by a case-insensitive compare. (R-01,
 * R-02, R-05)
 *
 * Walking the segments: for each one, a candidate must match the segment
 * text case-insensitively, sit after the previous segment's match (or
 * anywhere in the file for the first segment) and before the previous
 * segment's section closes, and (past the first segment) be strictly
 * deeper than the previous match's level.
 *
 * `delimiter` is only used to re-join the resolved ancestors in the
 * not-found message, so it reads back in the form the caller wrote the
 * path in (`"A > B"` for a caller that split on `" > "`). It defaults to
 * `"::"`, the default `targetDelimiter`.
 */
export function resolveHeadingEntries(
  entries: HeadingEntry[],
  segments: string[],
  totalLines: number,
  delimiter: string = "::",
): HeadingResolution {
  if (segments.length === 0) {
    return { kind: "not-found", segment: "", where: "in the file" };
  }

  let prevStartLine = -1;
  let prevEndLine = totalLines;
  let prevLevel = 0;
  let lastMatch: HeadingEntry | null = null;

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const candidates = entries.filter(
      (h) =>
        normalizeHeadingText(h.heading) === normalizeHeadingText(seg) &&
        h.line > prevStartLine &&
        h.line < prevEndLine &&
        (segIdx === 0 || h.level > prevLevel),
    );

    if (candidates.length === 0) {
      const where =
        segIdx === 0
          ? "in the file"
          : `under "${segments.slice(0, segIdx).join(delimiter)}"`;
      return { kind: "not-found", segment: seg, where };
    }
    if (candidates.length > 1) {
      const lines = candidates
        .map((c) => `level ${c.level} at line ${c.line}`)
        .join(", ");
      return {
        kind: "ambiguous",
        segment: seg,
        candidates,
        message: `Ambiguous heading target: "${seg}" matches multiple headings (${lines}). Use a nested path with \`targetDelimiter\` to disambiguate.`,
      };
    }

    const match = candidates[0];
    lastMatch = match;
    prevStartLine = match.line;
    prevLevel = match.level;

    // The section under `match` ends at the next heading with level <=
    // match.level (or EOF), the boundary the next segment must respect.
    const closer = entries.find(
      (h) => h.line > match.line && h.level <= match.level,
    );
    prevEndLine = closer ? closer.line : totalLines;
  }

  if (!lastMatch) {
    return {
      kind: "not-found",
      segment: segments[segments.length - 1],
      where: "in the file",
    };
  }

  return {
    kind: "found",
    line: lastMatch.line,
    level: lastMatch.level,
    endLine: prevEndLine,
  };
}

/**
 * Resolve a nested heading path for a write-path caller: cache-first, with
 * the current content as the arbiter (R-07). The metadata cache can lag the
 * bytes on disk in either direction, so the whole path is resolved twice —
 * once over the cache, once over a fresh scan of `lines` via
 * `headingEntriesFromContent`, which is itself fence-aware — and the cache
 * answer is kept only when the two agree exactly: both `found`, same line,
 * same level. Anything else returns the content resolution.
 *
 * Comparing full resolutions, rather than re-checking the cached line in
 * isolation, is what makes the lag safe in both directions. A cache hit whose
 * heading has since been duplicated must become ambiguous even though the
 * cached line still carries the requested text (otherwise the write silently
 * picks one of two candidates), and a cache that is ambiguous only because it
 * still lists a heading the file no longer has must resolve to the single
 * surviving match instead of erroring. A reparented heading — same leaf text,
 * different ancestor — falls out of the same comparison: the content
 * resolution disagrees, so it wins, which is the wrong-section write ADR-0024
 * exists to close.
 *
 * `delimiter` is the one the caller split `segments` with; it only shapes the
 * not-found message (see `resolveHeadingEntries`).
 */
export function resolveHeadingForWrite(
  cache: Parameters<typeof headingEntriesFromCache>[0],
  lines: string[],
  segments: string[],
  delimiter: string = "::",
): HeadingResolution {
  const cacheResult = resolveHeadingEntries(
    headingEntriesFromCache(cache),
    segments,
    lines.length,
    delimiter,
  );

  // Fence-aware and heading-shaped by construction: an entry exists at a line
  // only if that line is a real, unfenced heading in the current content.
  const contentResult = resolveHeadingEntries(
    headingEntriesFromContent(lines),
    segments,
    lines.length,
    delimiter,
  );

  if (
    cacheResult.kind === "found" &&
    contentResult.kind === "found" &&
    cacheResult.line === contentResult.line &&
    cacheResult.level === contentResult.level
  ) {
    return cacheResult;
  }

  return contentResult;
}
