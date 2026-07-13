/**
 * Shared helpers for patch operations (heading resolution, body normalization,
 * block reference lookup). Pure functions — no Obsidian API calls here.
 *
 * Used by patch_active_file (T6) and patch_vault_file (T13).
 */

import type { App, TFile } from "obsidian";
import { withVaultWriteLock } from "./vaultWriteLock";

export type PatchOperation = "append" | "prepend" | "replace";

/**
 * Parse markdown content and resolve a partial heading name to its full
 * hierarchical path (e.g., "Section A" -> "Top Level::Section A"). Returns
 * the full path of the first matching heading by document order, or null
 * if no heading with that exact name exists in the content.
 *
 * Ported verbatim from packages/mcp-server/src/features/local-rest-api/index.ts.
 *
 * Args:
 *   content: Full markdown file content as a string.
 *   leafName: Exact heading text to search for (without leading #).
 *   delimiter: Separator used to join the ancestor chain (e.g. "::").
 *
 * Returns:
 *   The full hierarchical path string, or null if no match found.
 */
export function resolveHeadingPath(
  content: string,
  leafName: string,
  delimiter: string,
): string | null {
  const lines = content.split("\n");
  // Stack of heading names at each indentation level. stack[level-1] holds
  // the name of the heading at that level. When we encounter a heading at
  // level N, all deeper levels become stale and are truncated.
  const stack: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const level = match[1].length;
    const headingText = match[2].trim();

    // Drop any stack entries deeper than the current level, then set the
    // current level's slot. This keeps `stack.slice(0, level)` a valid
    // ancestor path for any subsequent match at a deeper level.
    stack.length = level - 1;
    stack[level - 1] = headingText;

    if (headingText === leafName) {
      // Join the full ancestor chain (including the match itself) with the
      // delimiter the caller will also pass as the Target-Delimiter header.
      return stack.slice(0, level).join(delimiter);
    }
  }

  return null;
}

/**
 * Find the first line that is a heading (`#`–`######` followed by a space and
 * text) whose trimmed text equals `leafHeading`. Returns the 0-based line
 * index and the heading level (count of leading `#`), or `null` if absent.
 *
 * Shared by `patch_vault_file` and `append_to_periodic_note` so both locate a
 * leaf heading identically. The level is the `#{1,6}` capture length, which
 * for any line that matches equals a separate `/^(#+)/` count.
 */
export function findLeafHeadingLine(
  lines: string[],
  leafHeading: string,
): { line: number; level: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (m && m[2].trim() === leafHeading) {
      return { line: i, level: m[1].length };
    }
  }
  return null;
}

/**
 * Ensure appended content ends with whitespace so the next section in the
 * document remains visually separated. markdown-patch does not insert any
 * separation on its own, so `**bold**` appended under a heading would
 * collide with the following `## Next Heading` line.
 *
 * Only modifies content when operation is "append" and content does not
 * already end with a newline.
 *
 * Args:
 *   content: The body text to be patched into the document.
 *   operation: The patch operation type.
 *
 * Returns:
 *   The content, possibly with "\n\n" appended.
 */
export function normalizeAppendBody(
  content: string,
  operation: PatchOperation,
): string {
  if (operation === "append" && !content.endsWith("\n")) {
    return content + "\n\n";
  }
  return content;
}

/**
 * Find a block reference (^id) in markdown content via regex. Used as a
 * fallback when Obsidian's metadataCache hasn't indexed the file yet.
 *
 * Walks the lines looking for a line that is exactly `^blockId` (after
 * trimming trailing whitespace). When found, walks backwards to find the
 * start of the containing paragraph (stops at empty lines).
 *
 * Args:
 *   content: Full markdown file content as a string.
 *   blockId: The block identifier to look for (without the leading ^).
 *
 * Returns:
 *   An object with startLine and endLine (0-indexed), or null if not found.
 */
export function findBlockReferenceInContent(
  content: string,
  blockId: string,
): { startLine: number; endLine: number } | null {
  const lines = content.split("\n");
  const blockMarker = `^${blockId}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === blockMarker) {
      // Block markers point to the preceding paragraph.
      // Walk backwards to find the start of the block.
      let start = i;
      while (start > 0 && lines[start - 1].trim() !== "") {
        start--;
      }
      return { startLine: start, endLine: i };
    }
  }
  return null;
}

/**
 * Detect whether a level-2-or-deeper heading at the given line has a
 * level-1 (#) parent above it. Used by the heading branch of `applyPatch`
 * to reject root-orphan H2+ headings when `createTargetIfMissing=false`,
 * matching the `0.3.x` legacy chain behavior (Local REST API + markdown-patch
 * indexer enforced this implicitly; the in-process port missed the gate
 * on the `0.4.0` rewrite). See fork issue #80 + folotp's round-3 retest on
 * the actual HTTP-embedded chain.
 *
 * Args:
 *   lines: The file content split on `\n` (already a per-line array).
 *   headingLine: 0-indexed line where the target heading was resolved.
 *
 * Returns:
 *   true if any line in `lines[0..headingLine-1]` is a level-1 heading
 *   (matches `/^#\s/`), false otherwise.
 */
export function hasParentH1(lines: string[], headingLine: number): boolean {
  for (let i = 0; i < headingLine; i++) {
    if (/^#\s/.test(lines[i])) return true;
  }
  return false;
}

/**
 * Whether the document contains any level-1 (`# `) heading at all. Used by
 * the #139 narrowed-A relaxation of the H2-root guard: a root-orphan H2 is
 * only structurally ambiguous when an H1 exists *elsewhere* (a mixed
 * document). An entirely H1-free file — the common Obsidian
 * frontmatter-`title:` pattern, body starting at `##` — has an
 * unambiguous root and is safe to patch.
 *
 * Args:
 *   lines: The file content split on `\n`.
 *
 * Returns:
 *   true if any line is a level-1 heading (`/^#\s/`), false otherwise.
 */
export function hasAnyH1(lines: string[]): boolean {
  return lines.some((l) => /^#\s/.test(l));
}

/**
 * Precompute, in a single O(n) pass, whether each line sits inside an
 * open fenced code block — i.e. `fenceOpen[i]` is the value the old
 * `count ``` up to lineIdx` loop would have produced for `lineIdx = i`.
 * Used so a range scan does not rescan from line 0 per line (was O(n²)).
 *
 * Exported for callers that check many lines of the same document
 * (e.g. headingRename's per-line backlink rewrite): precompute once and
 * pass to `isInsideTableOrFencedCodeAt` — calling the single-shot
 * `isInsideTableOrFencedCode` in a per-line loop is the O(n²) trap this
 * pass exists to avoid.
 */
export function computeFenceOpenState(lines: string[]): boolean[] {
  const fenceOpen = new Array<boolean>(lines.length);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    // The toggle at line `i` affects lines AFTER `i`, exactly matching
    // the original `for (i = 0; i < lineIdx; i++)` semantics.
    fenceOpen[i] = inFence;
    // CommonMark §4.5: ``` and ~~~ are both fence delimiters. Naive toggle
    // (no fence-char/length matching) — matches the existing simplification
    // and is sufficient for the block (#84) and heading (#137) guards.
    const t = lines[i].trim();
    if (t.startsWith("```") || t.startsWith("~~~")) inFence = !inFence;
  }
  return fenceOpen;
}

/**
 * The per-line table/fence check, consulting a precomputed fence-open
 * array instead of rescanning from line 0. Behaviour is byte-identical
 * to the original single-function form.
 */
export function isInsideTableOrFencedCodeAt(
  lines: string[],
  lineIdx: number,
  fenceOpen: boolean[],
): boolean {
  if (lineIdx < 0 || lineIdx >= lines.length) return false;

  // Boundary case: the line itself is a fence delimiter. The splice would
  // either consume the opener (orphaning the closer) or vice versa, leaving
  // the file structurally invalid. Treat as "inside" for gating purposes.
  // Surfaced by fork #84 where the regex fallback findBlockReferenceInContent
  // walks back from `^block-id` and captures the opening fence as startLine
  // — the count-up-to-lineIdx loop below misses it because the toggle would
  // happen AT lineIdx, not before. Symmetric to the table separator-row
  // handling at the bottom of this function.
  if (lines[lineIdx].trim().startsWith("```")) return true;

  // Fenced code block: precomputed open-state up to lineIdx.
  if (fenceOpen[lineIdx]) return true;

  // Markdown table: target line itself must be a table row.
  const target = lines[lineIdx].trim();
  const isTableRow = (s: string) => s.startsWith("|") && s.endsWith("|");
  // Separator row signature: pipes + dashes + optional colons (alignment),
  // no other content. Matches `|---|---|`, `| --- | --- |`, `|:--:|---:|`.
  const isSeparator = (s: string) =>
    /^\|[\s:|-]+\|$/.test(s) && s.includes("---");
  if (!isTableRow(target)) return false;
  // Target is itself the separator row → trivially inside a table.
  if (isSeparator(target)) return true;

  // Walk up looking for separator (the data-row case: target is below it).
  for (let i = lineIdx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === "" || !isTableRow(t)) break;
    if (isSeparator(t)) return true;
  }
  // Walk down looking for separator (the header-row case: target is above it).
  for (let i = lineIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "" || !isTableRow(t)) break;
    if (isSeparator(t)) return true;
  }
  return false;
}

/**
 * Detect whether a given line is inside a markdown table (between a header
 * row and the surrounding data rows, with a `|---|...|` separator) or
 * inside a fenced code block (between matching ``` markers). Used by the
 * block branch of `applyPatch` to reject block references resolved inside
 * structural contexts that the splice logic cannot safely modify — the
 * `0.3.x` legacy chain enforced this via markdown-patch's indexer (HTTP
 * 400 invalid-target); the in-process port missed it on the `0.4.0`
 * rewrite, leading to silent destruction of the surrounding table when
 * `^block-id` resolves inside a table cell. See fork issue #81 + folotp's
 * round-3 retest on the actual HTTP-embedded chain.
 *
 * Detection rules:
 * - **Fenced code**: count ``` markers in `lines[0..lineIdx-1]`. Odd count
 *   means `lineIdx` is inside an open fence.
 * - **Table**: `lines[lineIdx]` must itself be a table row (starts with
 *   `|`, ends with `|`); then walk up and walk down looking for a
 *   separator row (`|---|...|` shape) without crossing a blank line or
 *   non-table line. Either direction matching is sufficient — a block
 *   reference can sit on the header row above the separator, on the
 *   separator itself (degenerate but possible), or on any data row below.
 *
 * False-positive guard: a stray line starting with `|` in plain prose
 * (e.g. an indented quote) without a separator above or below returns
 * false — the table check requires the structural separator signature.
 *
 * Args:
 *   lines: The file content split on `\n` (already a per-line array).
 *   lineIdx: 0-indexed line where the block reference was resolved.
 *
 * Returns:
 *   true if `lineIdx` is structurally inside a table or fenced code block,
 *   false otherwise.
 */
export function isInsideTableOrFencedCode(
  lines: string[],
  lineIdx: number,
): boolean {
  return isInsideTableOrFencedCodeAt(
    lines,
    lineIdx,
    computeFenceOpenState(lines),
  );
}

/**
 * Defense-in-depth wrapper around `isInsideTableOrFencedCode` for the block
 * branch of `applyPatch`: checks every line in the resolved block range
 * `[startLine, endLine]` (inclusive). Even if `startLine` lands on a line
 * the per-line helper considers safe, any unsafe line within the range
 * triggers the reject.
 *
 * Why a range check matters: `findBlockReferenceInContent` walks backward
 * from the `^id` line stopping at blank lines, which can capture an opening
 * fence delimiter as `startLine` when the block lives inside a fenced code
 * block (fork #84). With the boundary-case extension to
 * `isInsideTableOrFencedCode` (fence-delimiter line itself returns true),
 * `startLine` alone is enough for #84's specific shape — but the range
 * check adds protection against future cache-resolution shapes where the
 * resolved block spans a fence boundary in a different layout.
 *
 * Args:
 *   lines: The file content split on `\n`.
 *   startLine, endLine: Inclusive 0-indexed range from the block resolver.
 *
 * Returns:
 *   true if any line in `[startLine, endLine]` is structurally unsafe to
 *   splice, false otherwise.
 */
export function isBlockRangeStructurallyUnsafe(
  lines: string[],
  startLine: number,
  endLine: number,
): boolean {
  // Single O(n) fence pass shared across the range — previously each
  // iteration rescanned from line 0, making this O(n²) on large files.
  const fenceOpen = computeFenceOpenState(lines);
  for (let i = startLine; i <= endLine; i++) {
    if (isInsideTableOrFencedCodeAt(lines, i, fenceOpen)) return true;
  }
  return false;
}

/**
 * Compute the exclusive end line of a heading's section: the first
 * subsequent line that is a heading of the same level or shallower
 * (level number <= `headingLevel`), skipping any line inside a fenced
 * code block.
 *
 * A `## …` line inside a ``` or ~~~ fence is opaque text (CommonMark
 * §4.5), not a section boundary. Treating it as one silently truncates
 * a `replace` and leaves the rest of the fence (further `##` lines, the
 * closing delimiter, the section postamble) orphaned after the new body
 * — the heading-branch analog of the #84 block-branch bug (fork #137).
 * The block branch already guards via `isInsideTableOrFencedCode`; this
 * is the symmetric guard for the heading section walker.
 *
 * Args:
 *   lines: File content split on "\n".
 *   headingLine: 0-indexed line of the resolved target heading.
 *   headingLevel: The target heading's level (1-6).
 *
 * Returns:
 *   Exclusive 0-indexed end index; `lines.length` if the section runs
 *   to EOF.
 */
export function findHeadingSectionEnd(
  lines: string[],
  headingLine: number,
  headingLevel: number,
): number {
  const fenceOpen = computeFenceOpenState(lines);
  for (let i = headingLine + 1; i < lines.length; i++) {
    if (fenceOpen[i]) continue;
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= headingLevel) return i;
  }
  return lines.length;
}

/**
 * Find a block reference position from Obsidian's metadataCache. Preferred
 * over `findBlockReferenceInContent` because it respects the markdown-patch
 * indexer's block detection rules (e.g., does not search inside markdown
 * tables — see issue #71). Returns null on miss; callers MUST
 * decide whether to fail loud or fall back to EOF append based on the
 * `createTargetIfMissing` flag.
 *
 * Args:
 *   cache: An Obsidian CachedMetadata-shaped object (or null/undefined).
 *   blockId: The block identifier to look up (without the leading ^).
 *
 * Returns:
 *   An object with startLine and endLine (0-indexed), or null if not found.
 */
export function findBlockPositionFromCache(
  cache:
    | {
        blocks?: Record<
          string,
          { position: { start: { line: number }; end: { line: number } } }
        >;
      }
    | null
    | undefined,
  blockId: string,
): { startLine: number; endLine: number } | null {
  if (!cache?.blocks) return null;
  const entry = cache.blocks[blockId];
  if (!entry) return null;
  return {
    startLine: entry.position.start.line,
    endLine: entry.position.end.line,
  };
}

// === Frontmatter plan helpers (shared by T6 and T13) ============================
//
// Pure / synchronous decision functions that decide what to do when a
// `targetType: "frontmatter"` patch lands on a field. They exist as separate,
// unit-testable helpers because the frontmatter branch of `applyPatch` is a
// known regression hotspot (issues #12 / #13 on the istefox fork): the 0.3.x
// line had to add hardening against silent array→scalar coercion and against
// HTTP-500-on-JSON-scalar; the 0.4.0 in-process port was a fresh write and
// missed both. Putting the policy in pure helpers keeps the regression tests
// simple and the production branch a thin dispatch.

/**
 * Decision returned by `planFrontmatterReplace`.
 *
 * - `ok` — caller should assign `value` (which is either `null` or an array)
 *   to the frontmatter field.
 * - `ok-string` — existing field is not array-shaped, so the safe behaviour
 *   is to assign `args.content` verbatim (the legacy scalar-replace path).
 * - `reject` — refuse the call with `message`. Used for the array+scalar
 *   mismatch that previously corrupted data silently.
 */
export type FrontmatterReplacePlan =
  | { kind: "ok"; value: unknown }
  | { kind: "ok-string" }
  | { kind: "reject"; message: string };

/**
 * Decide what `replace` should do against an existing frontmatter value.
 *
 * Policy (reverse-engineered from the 0.3.8 hardening + adapted to the
 * in-process flow that no longer carries a `contentType` parameter):
 *
 * - existing is **not array** → caller assigns `content` as a string.
 * - existing **is array** + `content` is JSON-decodable as `null` or an
 *   array → caller assigns the parsed value (preserves array shape, or
 *   clears the field via `null`).
 * - existing **is array** + anything else → reject with an actionable
 *   message that names the JSON forms the caller should use.
 *
 * Closes folotp's #12: prior to this, `replace` on an array-valued field
 * with a plain string content silently coerced the field to a scalar and
 * destroyed the array.
 *
 * Args:
 *   existing: The current value of `fm[target]` as read by `processFrontMatter`.
 *   content: The raw `content` string supplied by the MCP caller.
 *   target: The frontmatter key — only used to build the rejection message.
 *
 * Returns:
 *   A `FrontmatterReplacePlan` describing the next step.
 */
export function planFrontmatterReplace(
  existing: unknown,
  content: string,
  target: string,
): FrontmatterReplacePlan {
  if (!Array.isArray(existing)) {
    return { kind: "ok-string" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "reject", message: arrayMismatchMessage(target) };
  }
  if (parsed === null || Array.isArray(parsed)) {
    return { kind: "ok", value: parsed };
  }
  return { kind: "reject", message: arrayMismatchMessage(target) };
}

function arrayMismatchMessage(target: string): string {
  return (
    `Refusing to replace array-valued frontmatter field "${target}" ` +
    `with a scalar value: this would silently destroy the existing array ` +
    `structure. Pass content as a JSON-encoded value — for example ` +
    `'["new"]' to set a single-element array, ` +
    `'["a","b"]' for multiple elements, or ` +
    `'null' to clear the field.`
  );
}

/**
 * Decision returned by `planFrontmatterAppend`.
 *
 * - `array-push` — existing field is array; `values` should be pushed
 *   (`append`) or unshifted (`prepend`) into a copy of it.
 * - `string-concat` — existing field is scalar/null/undefined; the caller
 *   falls back to the legacy `String(existing) + content` path.
 */
export type FrontmatterAppendPlan =
  | { kind: "array-push"; values: unknown[] }
  | { kind: "string-concat" };

/**
 * Decide what `append` / `prepend` should do against an existing frontmatter
 * value. Symmetric to `planFrontmatterReplace`, but never rejects: append on
 * an array has one reasonable interpretation in every input shape.
 *
 * Policy:
 *
 * - existing is **not array** → caller falls back to string concatenation.
 * - existing **is array** + `content` is JSON-decodable as an array →
 *   spread the parsed array's elements.
 * - existing **is array** + `content` is JSON-decodable as a scalar →
 *   push that single parsed scalar (matches the 0.3.8 auto-wrap fix from
 *   `coerceFrontmatterAppendArrayContent`).
 * - existing **is array** + `content` is **not** valid JSON → push the raw
 *   content as a single string element. This is the "DWIM where there is
 *   one reasonable interpretation" branch: an LLM caller that does not
 *   know about JSON encoding will just send `"new-tag"` and reasonably
 *   expect it to land in the array.
 *
 * Closes folotp's #13: prior to this, append/prepend on an array-valued
 * field flattened the array via `String(existing) + content`, producing
 * comma-joined corruption like `tags: existing,new-tag"new-tag"`.
 *
 * Args:
 *   existing: The current value of `fm[target]` as read by `processFrontMatter`.
 *   content: The raw `content` string supplied by the MCP caller.
 *
 * Returns:
 *   A `FrontmatterAppendPlan` describing the next step.
 */
export function planFrontmatterAppend(
  existing: unknown,
  content: string,
): FrontmatterAppendPlan {
  if (!Array.isArray(existing)) {
    return { kind: "string-concat" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "array-push", values: [content] };
  }
  if (Array.isArray(parsed)) {
    return { kind: "array-push", values: parsed };
  }
  return { kind: "array-push", values: [parsed] };
}

// === PatchArgs type and applyPatch function (shared by T6 and T13) ===

export type PatchArgs = {
  operation: PatchOperation;
  targetType: "heading" | "block" | "frontmatter";
  target: string;
  content: string;
  targetDelimiter?: string;
  createTargetIfMissing?: boolean;
  allowRootHeadings?: boolean;
};

/**
 * Apply a patch operation (append/prepend/replace) to a vault file using the
 * native Obsidian API. Handles three target types:
 *
 * - **heading**: finds the section bounded by the target heading and the next
 *   sibling/parent heading, then inserts or replaces content in that region.
 *   If the heading is not found and `createTargetIfMissing` is true (default),
 *   the content is appended at EOF.
 * - **block**: looks up the block `^id` via metadataCache (preferred) or regex
 *   fallback. Returns an error if not found and `createTargetIfMissing` is
 *   false (the default for blocks — see issue #71).
 * - **frontmatter**: uses `app.fileManager.processFrontMatter` to mutate the
 *   requested key. Array-typed values are handled structurally via the
 *   `planFrontmatterReplace` / `planFrontmatterAppend` helpers — `replace`
 *   on an array rejects scalar input rather than corrupting the structure
 *   (issue #12); `append` / `prepend` on an array push elements
 *   structurally, JSON-decoding the content when valid (issue #13).
 *
 * Args:
 *   app: Obsidian App instance.
 *   file: The TFile to patch.
 *   args: Patch parameters (operation, targetType, target, content, …).
 *
 * Returns:
 *   An MCP-shaped result object. Sets `isError: true` on failure.
 */
export async function applyPatch(
  app: App,
  file: TFile,
  args: PatchArgs,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const targetDelimiter = args.targetDelimiter ?? "::";
  // Default createTargetIfMissing: true for heading/frontmatter, false for block
  // (see issue #71 — block in table is not indexed by metadataCache).
  const defaultCreate = args.targetType !== "block";
  const createIfMissing = args.createTargetIfMissing ?? defaultCreate;

  // ── frontmatter branch ──────────────────────────────────────────────────
  // Dispatches through the pure planners above so the policy stays testable
  // without needing the full `processFrontMatter` machinery. `rejection` is
  // captured out of the closure because `processFrontMatter` returns void —
  // we cannot bubble an Error back without aborting the write entirely (and
  // some Obsidian versions still rewrite the YAML even on throw, which would
  // produce a confusing partial-update). Setting a flag and skipping the
  // mutation keeps the file untouched while letting us return a typed error.
  if (args.targetType === "frontmatter") {
    let rejection: string | null = null;
    await app.fileManager.processFrontMatter(file, (rawFm) => {
      const fm = rawFm as Record<string, unknown>;
      const existing = fm[args.target];
      if (args.operation === "replace") {
        const plan = planFrontmatterReplace(
          existing,
          args.content,
          args.target,
        );
        if (plan.kind === "reject") {
          rejection = plan.message;
          return;
        }
        fm[args.target] = plan.kind === "ok" ? plan.value : args.content;
        return;
      }
      // append / prepend
      const plan = planFrontmatterAppend(existing, args.content);
      if (plan.kind === "array-push") {
        const arr = (existing as unknown[]).slice();
        if (args.operation === "append") arr.push(...plan.values);
        else arr.unshift(...plan.values);
        fm[args.target] = arr;
        return;
      }
      // string-concat: existing is scalar / null / undefined — keep the
      // legacy concatenation semantics for backward compatibility.
      if (existing == null) {
        fm[args.target] = args.content;
        return;
      }
      fm[args.target] =
        args.operation === "append"
          ? String(existing) + args.content
          : args.content + String(existing);
    });
    if (rejection !== null) {
      return {
        content: [{ type: "text", text: rejection }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: "File patched successfully" }] };
  }

  // ── heading / block branch — atomic read-modify-write ────────────────
  // The compute between read and write is pure & synchronous, so it runs
  // inside vault.process: every line number and section boundary is
  // derived from the exact content that is written back, and no
  // concurrent writer (another MCP request, the editor, sync) can
  // interleave between our read and our write (lost update — the bug
  // class vaultWriteLock.ts documents). The vault write lock on top
  // serializes this patch against multi-step operations (create
  // pipelines, rename_heading's multi-file apply). Error paths return
  // the input unchanged (content no-op) and surface the message after.
  let failureText: string | null = null;
  await withVaultWriteLock(() =>
    app.vault.process(file, (rawContent) => {
      const outcome = computePatchedContent(app, file, rawContent, args, {
        targetDelimiter,
        createIfMissing,
      });
      if (outcome.kind === "error") {
        failureText = outcome.text;
        return rawContent;
      }
      return outcome.newContent;
    }),
  );
  if (failureText !== null) {
    return { content: [{ type: "text", text: failureText }], isError: true };
  }
  return { content: [{ type: "text", text: "File patched successfully" }] };
}

/** Outcome of the pure patch computation inside `vault.process`. */
type PatchOutcome =
  | { kind: "ok"; newContent: string }
  | { kind: "error"; text: string };

/**
 * Pure, synchronous core of `applyPatch`'s heading/block branches:
 * takes the current file content, returns either the patched content
 * or a typed error — never touches the vault itself. MUST stay
 * synchronous and side-effect-free: it executes inside the
 * `vault.process` callback (the only async-adjacent calls allowed are
 * the sync `metadataCache` lookups).
 */
function computePatchedContent(
  app: App,
  file: TFile,
  rawContent: string,
  args: PatchArgs,
  opts: { targetDelimiter: string; createIfMissing: boolean },
): PatchOutcome {
  const { targetDelimiter, createIfMissing } = opts;
  const lines = rawContent.split("\n");

  if (args.targetType === "heading") {
    // Resolve partial leaf name to full hierarchical path so the lookup
    // matches even when the heading is nested (e.g. "A" → "Top::A").
    let resolvedTarget = args.target;
    if (!args.target.includes(targetDelimiter)) {
      const fullPath = resolveHeadingPath(
        rawContent,
        args.target,
        targetDelimiter,
      );
      if (fullPath) resolvedTarget = fullPath;
    }

    // Find the heading line by comparing the full path.
    const targetParts = resolvedTarget.split(targetDelimiter);
    const leafHeading = targetParts[targetParts.length - 1];
    const found = findLeafHeadingLine(lines, leafHeading);

    if (found === null) {
      // Heading not found — respect createTargetIfMissing.
      if (!createIfMissing) {
        return { kind: "error", text: `Heading not found: ${args.target}` };
      }
      // Append at EOF.
      const body = normalizeAppendBody(args.content, args.operation);
      return { kind: "ok", newContent: rawContent + body };
    }

    const { line: headingLine, level: headingLevel } = found;

    // Find the end of this heading's section: the next heading of same or
    // higher level (lower number means higher in hierarchy), or EOF.

    // 0.3.9 #16 parity: reject root-orphan H2+ when createTargetIfMissing=false
    // (legacy LRA enforced this via markdown-patch's indexer; the 0.4.0
    // in-process port missed it — fork #80, #83). #139 narrowed this: the
    // section boundary is only ambiguous when an H1 exists *elsewhere* (a
    // mixed document). An entirely H1-free file (frontmatter-`title:`
    // pattern) has an unambiguous root and is allowed; `allowRootHeadings`
    // is the explicit opt-in for the mixed case.
    if (
      headingLevel >= 2 &&
      !createIfMissing &&
      !hasParentH1(lines, headingLine) &&
      !args.allowRootHeadings &&
      hasAnyH1(lines)
    ) {
      return {
        kind: "error",
        text: `Heading "${args.target}" is a level-${headingLevel} heading with no level-1 (#) parent, while the document does contain an H1 elsewhere — the section boundary is ambiguous. Refusing to patch. Pass allowRootHeadings:true to target it explicitly, or createTargetIfMissing:true to bypass. (Files with no H1 at all are accepted automatically.)`,
      };
    }
    // Section end is fence-aware: a `## …` line inside a ``` / ~~~ block
    // is not a boundary (fork #137 — silent destruction on `replace`).
    const sectionEnd = findHeadingSectionEnd(lines, headingLine, headingLevel);

    // The section body is the lines between the heading and the next heading.
    // We want to insert content just before sectionEnd (append) or just after
    // headingLine (prepend) or replace the whole body (replace).
    const body = normalizeAppendBody(args.content, args.operation);
    // For `replace`, the original section body absorbed both the leading
    // blank line (between the heading and the first body line) and the
    // trailing blank line (between the last body line and the next sibling
    // heading) that visually separated the section. Splicing `body` in
    // between `headingLine + 1` and `sectionEnd` without re-emitting either
    // separator produces `## A\n<body>\n## B` instead of the expected
    // `## A\n\n<body>\n\n## B`. We re-emit:
    //   - a leading blank when the body does not already start with one
    //     (Linter-correct shape; matches 0.3.x behaviour; closes #76);
    //   - a trailing blank when the tail is another heading and the body
    //     does not already end blank (post-beta.1 fix).
    const tailIsHeading =
      sectionEnd < lines.length && /^#{1,6}\s/.test(lines[sectionEnd]);
    const bodyStartsBlank = body === "" || body.startsWith("\n");
    const bodyEndsBlank = body === "" || body.endsWith("\n");
    let newLines: string[];
    if (args.operation === "replace") {
      const leadingSeparator = bodyStartsBlank ? [] : [""];
      const trailingSeparator = tailIsHeading && !bodyEndsBlank ? [""] : [];
      newLines = [
        ...lines.slice(0, headingLine + 1),
        ...leadingSeparator,
        body,
        ...trailingSeparator,
        ...lines.slice(sectionEnd),
      ];
    } else if (args.operation === "prepend") {
      newLines = [
        ...lines.slice(0, headingLine + 1),
        body,
        ...lines.slice(headingLine + 1),
      ];
    } else {
      // append — insert before the next heading (sectionEnd)
      newLines = [
        ...lines.slice(0, sectionEnd),
        body,
        ...lines.slice(sectionEnd),
      ];
    }
    return { kind: "ok", newContent: newLines.join("\n") };
  }

  // ── block branch ─────────────────────────────────────────────────────
  const cache = app.metadataCache.getFileCache(file);
  let blockPos = findBlockPositionFromCache(cache, args.target);

  if (!blockPos) {
    // Fallback: regex scan (doesn't work for blocks inside tables — #71).
    blockPos = findBlockReferenceInContent(rawContent, args.target);
  }

  if (!blockPos) {
    // Block not found — for blocks the default is fail-loud (createIfMissing=false).
    if (!createIfMissing) {
      return {
        kind: "error",
        text: `Block not found: ^${args.target} (unresolved — block may be inside a table, which is not indexed by Obsidian's metadataCache)`,
      };
    }
    // Caller explicitly opted into createIfMissing — append at EOF.
    const body = normalizeAppendBody(args.content, args.operation);
    return { kind: "ok", newContent: rawContent + body };
  }

  // 0.3.x parity: reject when block resolves inside a table or fenced code
  // block. Legacy LRA chain enforced this via markdown-patch's indexer (HTTP
  // 400 invalid-target); the 0.4.0 in-process port missed it (folotp round-3
  // regression — silent destruction of the surrounding section/table when
  // `^cell-id` is matched inside a `| ... |` row). See fork #81, #83.
  // The check runs after resolution (whether via cache
  // or regex fallback), before any splice, and applies symmetrically to
  // append/prepend/replace — `prepend` would inject before a structural
  // boundary the splice can't honor either.
  //
  // 0.4.3 fix for fork #84: range check `[startLine, endLine]`, not just
  // startLine. The 0.4.2 fix gated correctly when the cache returned the
  // in-fence content line, but missed cache-miss + regex-fallback shapes
  // where `findBlockReferenceInContent` walks back to the opening fence
  // and captures it as startLine. The boundary-case extension to
  // `isInsideTableOrFencedCode` (fence-delimiter line itself returns true)
  // plus the range check together cover both shapes.
  if (
    isBlockRangeStructurallyUnsafe(lines, blockPos.startLine, blockPos.endLine)
  ) {
    return {
      kind: "error",
      text: `Block "^${args.target}" resolved to line ${blockPos.startLine + 1} but it is inside a markdown table or fenced code block. Refusing to patch — replacing or splicing this region would corrupt the surrounding structure. Move the block id outside the table/code block to make it patchable.`,
    };
  }

  // Apply operation to the block region.
  const body = normalizeAppendBody(args.content, args.operation);
  let newLines: string[];
  if (args.operation === "replace") {
    // Replace the block lines entirely (keeps the ^id marker on last line only
    // if the new content doesn't already include it — here we strip the old
    // marker and let the caller own the new content verbatim).
    newLines = [
      ...lines.slice(0, blockPos.startLine),
      body,
      ...lines.slice(blockPos.endLine + 1),
    ];
  } else if (args.operation === "prepend") {
    newLines = [
      ...lines.slice(0, blockPos.startLine),
      body,
      ...lines.slice(blockPos.startLine),
    ];
  } else {
    // append — insert after the last line of the block
    newLines = [
      ...lines.slice(0, blockPos.endLine + 1),
      body,
      ...lines.slice(blockPos.endLine + 1),
    ];
  }
  return { kind: "ok", newContent: newLines.join("\n") };
}
