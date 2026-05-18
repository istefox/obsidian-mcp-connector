/**
 * Pure walker for `rename_heading` — produces a rewrite plan (source file
 * patch + per-backlinker patches) without touching the Obsidian app or
 * the filesystem. The MCP tool wrapper in `tools/renameHeading.ts` is the
 * I/O layer that loads texts, calls into this module, then applies the
 * resulting plan via `vault.modify`.
 *
 * Design contract (issue #68, @folotp RFC + @istefox triage 2026-04-29 +
 * bridge 2026-05-13 + gate-cleared 2026-05-16):
 *
 * - Option A (manual reference walk via documented APIs). No minified-modal
 *   hack, no UI driving.
 * - Tool surface: `{ path, from: { text, level? }, to }` → `{ ok,
 *   updatedFiles, linkRewriteCount }` on success; `errorCode` discriminator
 *   on failure (`heading-not-found`, `ambiguous-heading` with `candidates`,
 *   `heading-collision`).
 * - Seven edge cases triagged in the RFC close-out, all addressed here:
 *   (1) heading collision → `heading-collision`; (2) headings inside code
 *   fences/callouts → skipped during the source scan via
 *   `isInsideTableOrFencedCode`; (3) case-sensitive heading match; (4)
 *   subheading-path links (`[[note#Parent > heading]]`) → rewrite the
 *   matching path component; (5) frontmatter aliases out of scope for v1;
 *   (6) atomicity handled by the tool wrapper's two-phase commit (`plan` →
 *   `apply`); (7) special-char tokenizer for pipe and the literal ` > `
 *   subheading separator.
 */

import { isInsideTableOrFencedCode } from "./patchHelpers";

/** Match descriptor for the heading the caller wants to rename. */
export type HeadingFrom = {
  text: string;
  /** When omitted, ambiguity across levels surfaces as `ambiguous-heading`. */
  level?: number;
};

/** One candidate heading in a multi-match scenario. */
export type HeadingCandidate = {
  line: number;
  level: number;
  text: string;
};

export type RenameError =
  | {
      errorCode: "heading-not-found";
      message: string;
    }
  | {
      errorCode: "ambiguous-heading";
      message: string;
      candidates: HeadingCandidate[];
    }
  | {
      errorCode: "heading-collision";
      message: string;
    };

/** Per-backlinker rewrite descriptor produced by `planRename`. */
export type BacklinkerPatch = {
  path: string;
  newText: string;
  /** Count of distinct link occurrences rewritten in this file. */
  rewriteCount: number;
};

/** Source-file rewrite descriptor. */
export type SourcePatch = {
  path: string;
  newText: string;
  matchedHeading: HeadingCandidate;
};

export type RenamePlan = {
  source: SourcePatch;
  backlinkers: BacklinkerPatch[];
  /** Sum of `rewriteCount` across all backlinkers, NOT including the source heading replacement itself. */
  linkRewriteCount: number;
};

/**
 * Minimal shape from Obsidian's `MetadataCache.getFileCache().headings`.
 * Pinned here so this module stays decoupled from `obsidian.d.ts` and is
 * unit-testable with raw fixtures.
 */
export type HeadingCacheEntry = {
  heading: string;
  level: number;
  position: { start: { line: number } };
};

/**
 * Signature the walker uses to ask "does this link path resolve to the
 * source file?" The wrapper in `tools/renameHeading.ts` passes a closure
 * around `app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)`
 * so default-shortest-path resolution works exactly like Obsidian's. In
 * tests, a simple basename-match implementation is enough.
 *
 * Returns the canonical vault-relative path of the resolved target, or
 * `null` when the link does not resolve.
 */
export type ResolveLinkpath = (
  linkpath: string,
  fromPath: string,
) => string | null;

// ────────────────────────────────────────────────────────────────────────────
// Heading match in source file
// ────────────────────────────────────────────────────────────────────────────

/**
 * Find the heading in the source file matching `from`. Respects the
 * RFC's case-sensitive contract and skips entries that the metadata
 * cache emits for lines inside fenced code blocks (defensive — Obsidian
 * normally excludes those, but `isInsideTableOrFencedCode` is the
 * project's canonical guard and we apply it here for consistency).
 *
 * Returns either a unique match, an ambiguity error with candidates, or
 * a not-found error.
 */
export function findSourceHeading(
  headings: HeadingCacheEntry[],
  lines: string[],
  from: HeadingFrom,
): HeadingCandidate | RenameError {
  const matches: HeadingCandidate[] = [];
  for (const h of headings) {
    if (h.heading !== from.text) continue;
    if (from.level !== undefined && h.level !== from.level) continue;
    // Defensive code-fence skip. Obsidian's cache already excludes
    // fenced-code lines from `headings`, but if a future bug or a
    // synthetic test fixture inserts one, treat it as not-a-heading.
    if (isInsideTableOrFencedCode(lines, h.position.start.line)) continue;
    matches.push({
      line: h.position.start.line,
      level: h.level,
      text: h.heading,
    });
  }

  if (matches.length === 0) {
    const levelClause =
      from.level !== undefined ? ` at level ${from.level}` : "";
    return {
      errorCode: "heading-not-found",
      message: `Heading not found: "${from.text}"${levelClause}.`,
    };
  }
  if (matches.length > 1) {
    return {
      errorCode: "ambiguous-heading",
      message: `Ambiguous heading match for "${from.text}": ${matches.length} candidates. Pass \`from.level\` to disambiguate.`,
      candidates: matches,
    };
  }
  return matches[0];
}

/**
 * Check whether the target heading text already exists in the source
 * file at the SAME level as the matched heading. RFC edge case #1: same
 * fail-loud bias as `rename_vault_file` destination-exists. Only the
 * same-level check matters — a level-1 "Notes" and a level-3 "Notes" are
 * distinct headings in Obsidian's link resolution.
 */
export function checkHeadingCollision(
  headings: HeadingCacheEntry[],
  lines: string[],
  to: string,
  matchedLevel: number,
  matchedLine: number,
): RenameError | null {
  for (const h of headings) {
    if (h.position.start.line === matchedLine) continue;
    if (h.heading !== to) continue;
    if (h.level !== matchedLevel) continue;
    if (isInsideTableOrFencedCode(lines, h.position.start.line)) continue;
    return {
      errorCode: "heading-collision",
      message: `Heading collision: "${to}" already exists at level ${matchedLevel} on line ${h.position.start.line + 1}. Refusing to rename; resolve the collision first or rename the existing heading instead.`,
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Source-file rewrite
// ────────────────────────────────────────────────────────────────────────────

/**
 * Replace the heading text on its line, preserving the leading `#`
 * markers, any leading whitespace, and any trailing block-id (e.g. ` ^id`)
 * or trailing whitespace. Returns the new full source text.
 *
 * RFC edge-case-adjacent: heading lines can carry a `^block-id` sibling
 * (`## Foo ^abc`). The block id must be preserved verbatim — the
 * regex captures the heading body between the `#` prefix and an optional
 * trailing ` ^id` suffix.
 */
export function rewriteSourceHeadingLine(
  lines: string[],
  matchedLine: number,
  newText: string,
): string[] {
  const original = lines[matchedLine];
  // ^(\s*#{1,6}\s+) — `#` markers + required space after
  // (.+?)             — heading text (lazy, so the trailing parts don't
  //                     get swallowed)
  // (\s+\^\S+)?       — optional block id `^abc` suffix
  // (\s*)$            — optional trailing whitespace
  const re = /^(\s*#{1,6}\s+)(.+?)(\s+\^\S+)?(\s*)$/;
  const m = original.match(re);
  if (!m) {
    // Should not happen in practice — Obsidian's cache only flags lines
    // whose plain-text form matches this shape — but if a synthetic
    // fixture violates it, fall back to a whole-line replace using the
    // matched-heading's level (inferred elsewhere; here we conservatively
    // overwrite with `# newText` which is incorrect for non-h1 but at
    // least observable in tests). The handler guard in `findSourceHeading`
    // is the primary defense.
    const out = lines.slice();
    out[matchedLine] = `# ${newText}`;
    return out;
  }
  const [, prefix, , blockId = "", trailing = ""] = m;
  const out = lines.slice();
  out[matchedLine] = `${prefix}${newText}${blockId}${trailing}`;
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Link rewrite in backlinkers
// ────────────────────────────────────────────────────────────────────────────

const SUBHEADING_SEP = " > ";

/**
 * URL-decode the heading fragment of a markdown link, if present. Obsidian
 * encodes spaces and special characters in markdown-link targets (e.g.
 * `[text](note.md#My%20Heading)`). The tokenizer compares decoded text
 * against the heading we're renaming.
 */
function decodeHeadingFragment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * URL-encode the heading fragment back for use in a markdown link.
 * Obsidian uses `%20` for spaces; mirror that.
 */
function encodeHeadingFragment(raw: string): string {
  // `encodeURIComponent` is too aggressive (encodes `!` `'` `(` `)`
  // which Obsidian leaves alone). Apply a narrow subset.
  return raw
    .replace(/%/g, "%25") // must be first
    .replace(/ /g, "%20")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F")
    .replace(/&/g, "%26");
}

/**
 * Split a heading path string on the ` > ` separator. Empty segments
 * collapse — `"Parent  >  Child"` (extra spaces) still resolves to
 * `["Parent", "Child"]` because we trim each segment.
 *
 * Returns the segment list and the boolean `hadPath` (true if there was
 * at least one separator).
 */
function splitHeadingPath(raw: string): {
  segments: string[];
  hadPath: boolean;
} {
  if (!raw.includes(SUBHEADING_SEP)) {
    return { segments: [raw], hadPath: false };
  }
  const segments = raw.split(SUBHEADING_SEP).map((s) => s.trim());
  return { segments, hadPath: true };
}

/**
 * Rewrite any segment of the heading-path that equals `oldHeading` to
 * `newHeading`. Edge case (#4): a renamed heading can appear as the leaf
 * OR as a non-leaf node in a path link.
 *
 * Returns the rewritten heading reference, or `null` if no segment
 * matched (caller skips the link).
 */
function rewriteHeadingPath(
  raw: string,
  oldHeading: string,
  newHeading: string,
): string | null {
  const { segments, hadPath } = splitHeadingPath(raw);
  let changed = false;
  const rewritten = segments.map((s) => {
    if (s === oldHeading) {
      changed = true;
      return newHeading;
    }
    return s;
  });
  if (!changed) return null;
  return hadPath ? rewritten.join(SUBHEADING_SEP) : rewritten[0];
}

/**
 * Rewrite all matching heading-links inside a single backlinker file.
 * Returns the new text and the count of distinct links rewritten.
 *
 * Patterns handled (RFC + 2026-04-29 triage edge case #7 tokenizer):
 *  - `[[note#heading]]`
 *  - `[[note#heading|alias]]`
 *  - `[text](note.md#heading)` (with URL-encoded heading fragments)
 *  - Subheading paths in either of the above
 *
 * Out of scope (v1, per RFC edge case #5): frontmatter aliases.
 */
export function rewriteBacklinker(
  text: string,
  oldHeading: string,
  newHeading: string,
  sourcePath: string,
  backlinkerPath: string,
  resolve: ResolveLinkpath,
): { newText: string; rewriteCount: number } {
  let rewriteCount = 0;

  // ── Wikilinks `[[note#heading]]` and `[[note#heading|alias]]` ─────────────
  //
  // Tokenizer approach (RFC edge case #7): scan for `[[` … `]]`, split on
  // the FIRST `#` (note part vs heading part), then on the LAST `|` (alias).
  // Regex-only solutions struggle with `|` inside the alias text; the
  // first-`#`/last-`|` split is unambiguous in Obsidian's grammar.
  //
  // We bail to a single regex first to find candidate spans, then parse
  // each candidate by hand.
  const wikilinkRe = /\[\[([^\]]+?)\]\]/g;
  let textAfterWikilinks = text.replace(wikilinkRe, (full, inner) => {
    const hashIdx = (inner as string).indexOf("#");
    if (hashIdx === -1) return full; // no heading fragment → leave it
    const notePart = (inner as string).slice(0, hashIdx);
    const rest = (inner as string).slice(hashIdx + 1);
    const pipeIdx = rest.lastIndexOf("|");
    const headingPart = pipeIdx === -1 ? rest : rest.slice(0, pipeIdx);
    const aliasPart = pipeIdx === -1 ? "" : rest.slice(pipeIdx);

    // Resolve `notePart` to a vault path. Empty notePart (`[[#heading]]`)
    // is a same-file reference — resolve against the backlinker itself.
    const linkpath = notePart === "" ? backlinkerPath : notePart;
    const resolved = resolve(linkpath, backlinkerPath);
    if (resolved !== sourcePath) return full;

    const rewritten = rewriteHeadingPath(headingPart, oldHeading, newHeading);
    if (rewritten === null) return full;

    rewriteCount++;
    return `[[${notePart}#${rewritten}${aliasPart}]]`;
  });

  // ── Markdown links `[text](note.md#heading)` ──────────────────────────────
  //
  // Pattern: `[…](…)`. The URL portion can be a vault path with optional
  // `#fragment`. We do NOT match autolinks (`<url>`) — those don't carry
  // heading fragments in Obsidian's link surface.
  const mdLinkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  textAfterWikilinks = textAfterWikilinks.replace(
    mdLinkRe,
    (full, linkText, url) => {
      const hashIdx = (url as string).indexOf("#");
      if (hashIdx === -1) return full;
      const notePart = (url as string).slice(0, hashIdx);
      const headingPartEncoded = (url as string).slice(hashIdx + 1);
      // Strip a trailing `.md` for resolution; the link target on disk
      // includes it but `getFirstLinkpathDest` accepts either form.
      const resolved = resolve(notePart, backlinkerPath);
      if (resolved !== sourcePath) return full;

      const headingPart = decodeHeadingFragment(headingPartEncoded);
      const rewritten = rewriteHeadingPath(headingPart, oldHeading, newHeading);
      if (rewritten === null) return full;

      rewriteCount++;
      return `[${linkText}](${notePart}#${encodeHeadingFragment(rewritten)})`;
    },
  );

  return { newText: textAfterWikilinks, rewriteCount };
}

// ────────────────────────────────────────────────────────────────────────────
// Plan generator
// ────────────────────────────────────────────────────────────────────────────

export type PlanRenameArgs = {
  sourcePath: string;
  sourceText: string;
  sourceHeadings: HeadingCacheEntry[];
  from: HeadingFrom;
  to: string;
  /** Map of vault-relative path → file text for every backlinker file. */
  backlinkers: Record<string, string>;
  resolve: ResolveLinkpath;
};

/**
 * Produce a complete rewrite plan or return a single typed error.
 * Two-phase commit (RFC edge case #6) is the wrapper's responsibility:
 * this function only computes the plan; the wrapper applies it and
 * surfaces `partial-failure` on mid-walk write errors.
 */
export function planRename(args: PlanRenameArgs): RenamePlan | RenameError {
  const lines = args.sourceText.split("\n");

  const matched = findSourceHeading(args.sourceHeadings, lines, args.from);
  if ("errorCode" in matched) return matched;

  // Same heading text + same level → no-op; treat as collision since
  // applying the rename would leave the file unchanged and confuse the
  // updatedFiles contract.
  if (matched.text === args.to) {
    return {
      errorCode: "heading-collision",
      message: `Heading "${args.to}" is already the current heading text (line ${matched.line + 1}, level ${matched.level}). No-op rename.`,
    };
  }

  const collision = checkHeadingCollision(
    args.sourceHeadings,
    lines,
    args.to,
    matched.level,
    matched.line,
  );
  if (collision) return collision;

  const newSourceLines = rewriteSourceHeadingLine(lines, matched.line, args.to);
  const sourceTextAfterLineRewrite = newSourceLines.join("\n");

  // Also rewrite any self-references inside the source file (e.g.
  // TOC entries like `[[#Old]]` or `[[source#Old]]` that point back to
  // this file's own heading). The source patch incorporates both the
  // heading-line replacement and the self-link rewrites in one go.
  const selfRefRewrite = rewriteBacklinker(
    sourceTextAfterLineRewrite,
    matched.text,
    args.to,
    args.sourcePath,
    args.sourcePath,
    args.resolve,
  );

  const sourcePatch: SourcePatch = {
    path: args.sourcePath,
    newText: selfRefRewrite.newText,
    matchedHeading: matched,
  };

  const backlinkers: BacklinkerPatch[] = [];
  let linkRewriteCount = selfRefRewrite.rewriteCount;

  for (const [path, text] of Object.entries(args.backlinkers)) {
    // Skip the source file itself if the wrapper accidentally included it
    // in the backlinker map — self-refs are handled above as part of the
    // source patch.
    if (path === args.sourcePath) continue;
    const { newText, rewriteCount } = rewriteBacklinker(
      text,
      matched.text,
      args.to,
      args.sourcePath,
      path,
      args.resolve,
    );
    if (rewriteCount === 0) continue; // backlinker reference was structural
    // but did not target this heading
    backlinkers.push({ path, newText, rewriteCount });
    linkRewriteCount += rewriteCount;
  }

  return {
    source: sourcePatch,
    backlinkers,
    linkRewriteCount,
  };
}
