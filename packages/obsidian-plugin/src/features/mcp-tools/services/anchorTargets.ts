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
 */
export function resolveHeadingEntries(
  entries: HeadingEntry[],
  segments: string[],
  totalLines: number,
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
          : `under "${segments.slice(0, segIdx).join("::")}"`;
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
 * Derive the ancestor chain of `entries[index]`: every enclosing heading, from
 * the outermost one down to the entry itself, found by walking backwards and
 * keeping each heading strictly shallower than the last one kept.
 */
function ancestorPath(entries: HeadingEntry[], index: number): HeadingEntry[] {
  const path = [entries[index]];
  let level = entries[index].level;
  for (let i = index - 1; i >= 0 && level > 1; i--) {
    if (entries[i].level < level) {
      path.unshift(entries[i]);
      level = entries[i].level;
    }
  }
  return path;
}

/**
 * Does `segments` still describe the heading at `entries[index]`? The last
 * segment must be that heading's own text, and the earlier ones must appear,
 * in order, among its ancestors — the same relation `resolveHeadingEntries`
 * enforces while walking (each segment strictly deeper than, and inside the
 * section of, the previous one), re-checked here against a chain derived from
 * the current content. Intermediate levels may be skipped in the request
 * (`"A::X"` for `A > B > X`), so the ancestors match as an ordered
 * subsequence, not as an exact chain. Comparison is case-insensitive, like
 * every other heading compare in this module.
 */
function pathMatchesSegments(
  entries: HeadingEntry[],
  index: number,
  segments: string[],
): boolean {
  const path = ancestorPath(entries, index);
  if (segments.length === 0 || segments.length > path.length) return false;

  const leaf = path[path.length - 1];
  if (
    normalizeHeadingText(leaf.heading) !==
    normalizeHeadingText(segments[segments.length - 1])
  ) {
    return false;
  }

  let seg = segments.length - 2;
  for (let i = path.length - 2; i >= 0 && seg >= 0; i--) {
    if (
      normalizeHeadingText(path[i].heading) ===
      normalizeHeadingText(segments[seg])
    ) {
      seg--;
    }
  }
  return seg < 0;
}

/**
 * Resolve a nested heading path for a write-path caller: cache-first with a
 * content fallback (R-07). The cache leg is trusted only when the *whole*
 * requested path still holds in `lines`: the resolved line must carry a
 * non-fenced heading matching the last segment, and its ancestor chain, as
 * re-derived from the current content, must still contain the earlier
 * segments in order. Checking the leaf alone would accept a restructured
 * document where a same-named heading has moved under a different parent, and
 * the write would silently land in the wrong section — the defect class
 * ADR-0024 exists to close. Any disagreement (rename since indexing,
 * just-created file, rapid double-write, reparented heading) falls through to
 * a fresh scan of `lines` via `headingEntriesFromContent`, which is itself
 * fence-aware. An ambiguous cache result is reported immediately; it is not
 * something a content rescan can resolve more precisely.
 */
export function resolveHeadingForWrite(
  cache: Parameters<typeof headingEntriesFromCache>[0],
  lines: string[],
  segments: string[],
): HeadingResolution {
  const cacheResult = resolveHeadingEntries(
    headingEntriesFromCache(cache),
    segments,
    lines.length,
  );

  if (cacheResult.kind === "ambiguous") {
    return cacheResult;
  }

  // Fence-aware and heading-shaped by construction: an entry exists at a line
  // only if that line is a real, unfenced heading in the current content.
  const contentEntries = headingEntriesFromContent(lines);

  if (cacheResult.kind === "found") {
    const cachedLine = cacheResult.line;
    const index = contentEntries.findIndex((h) => h.line === cachedLine);
    if (index !== -1 && pathMatchesSegments(contentEntries, index, segments)) {
      return cacheResult;
    }
  }

  return resolveHeadingEntries(contentEntries, segments, lines.length);
}
