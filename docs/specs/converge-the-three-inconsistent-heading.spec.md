# SPEC — Converge the three inconsistent heading/block anchor matchers on resolveSubpath

**Topic slug:** converge-the-three-inconsistent-heading

Tracks GitHub issue #527 / OMC-041 (P3, roadmap technical debt), filed after PR #526 fixed #525.

## Objectives

The plugin currently ships four independent implementations that each answer "does this
heading/block anchor exist, and where" — one correct (`resolveLinkTarget.ts`, built on
Obsidian's own `resolveSubpath`/`parseLinktext`), three hand-rolled and mutually inconsistent.
This SPEC converges the three hand-rolled matchers onto the semantics `resolveLinkTarget.ts`
already established, without regressing the correctness properties each hand-rolled matcher
earned through its own history of fork issues (table-safety, fence-safety, ambiguity detection).

## Scope

**In scope:**
1. `patchHelpers.ts` — `resolveHeadingPath` + `findLeafHeadingLine` (heading write path) and
   `findBlockPositionFromCache` + `findBlockReferenceInContent` (block write path, `^` handling).
2. `getVaultFilePartial.ts` — `findHeadingSection` (heading read path) and the block-mode `^`
   stripping (read path).
3. `appendToPeriodicNote.ts` — consumer of `patchHelpers.ts`'s `resolveHeadingPath` /
   `findLeafHeadingLine`; changes there flow through automatically, but its `vault.process`
   synchronous-callback constraint (identical to `patchHelpers.ts`'s own) must keep holding.
4. `getNoteOutline.ts` — `toAnchor()`. Confirmed real bug, in scope per the issue's own request
   to review it: the tool's own description promises anchors usable to "construct
   `[[note#heading]]` links", but Obsidian wikilinks resolve on the literal heading text, not on
   a lowercase slug. A slug anchor can never actually resolve in a wikilink. Fix: return the
   literal heading text as the anchor (matching what `[[note#Heading]]` actually needs); remove
   or reduce `toAnchor()` accordingly.
5. Existing tests asserting the previous per-tool behavior (case sensitivity, no ambiguity
   detection in the write path, `toAnchor()`'s slug output) — updated to the converged semantics.

**Out of scope:**
- `resolveLinkTarget.ts` itself — it is the reference implementation this work converges onto,
  not a target of change.
- Any behavior change to `find_broken_links` (the tool `resolveLinkTarget.ts` was built for) beyond
  what naturally follows from sharing implementation with the converged matchers.
- Fence-safety (`computeFenceOpenState`, `isInsideTableOrFencedCodeAt`,
  `isBlockRangeStructurallyUnsafe`) and root-heading-ambiguity (`hasParentH1`/`hasAnyH1`,
  `allowRootHeadings`) logic in `patchHelpers.ts` — orthogonal safety checks, unaffected by how
  the target heading/block position itself is resolved.

## Stack

TypeScript, Bun test runner, Obsidian Plugin API (`resolveSubpath`, `parseLinktext`,
`MetadataCache`), no new external dependencies.

## Architecture — converged semantics

Established via interview, binding on the architect/plan:

1. **Case sensitivity.** Heading matching becomes case-insensitive everywhere (aligns to
   `resolveSubpath`'s real behavior, confirmed at `resolveLinkTarget.test.ts:134-142`). Both
   `patchHelpers.ts`'s and `getVaultFilePartial.ts`'s matchers are case-sensitive today
   (`===` / `h.heading === seg`) — this is an intentional behavior change.
2. **Nested-path delimiter.** The public MCP contract keeps `targetDelimiter` (default `::`) —
   no breaking change to `patch_active_file`/`patch_vault_file`/`get_vault_file_partial`'s
   arguments. Internally, a `::`-joined path is translated to Obsidian's native `#`-chained
   subpath syntax (`"Parent::Child"` → `"Parent#Child"`, the form `resolveSubpath` expects for
   `[[Note#Parent#Child]]`-style nested heading targets — confirmed at
   `resolveLinkTarget.test.ts:144-155`) before resolution.
3. **Ambiguity detection.** Preserved and made consistent everywhere: both the read path
   (already does this today) and the write path (does NOT today — `resolveHeadingPath` silently
   takes the first document-order match) explicitly error when a target matches more than one
   heading in scope. `resolveSubpath` alone gives no ambiguity signal (it returns a single
   `current` heading) — ambiguity detection is a layer this project owns on top of it, not
   something `resolveSubpath` provides.
4. **Write-path resolution strategy.** `patchHelpers.ts`'s heading branch adopts the same
   cache-first-with-regex-fallback pattern its own block branch already uses successfully
   (`findBlockPositionFromCache` → `findBlockReferenceInContent`): try `resolveSubpath` against
   `app.metadataCache.getFileCache(file)` first; fall back to content-based regex scanning of
   the literal `rawContent` passed into the `vault.process` callback when the cache is stale,
   absent, or does not agree with the position expected. `computePatchedContent` must remain
   synchronous and side-effect-free inside `vault.process` — this is unchanged; `getFileCache` is
   itself a synchronous call, so it fits the existing constraint. This is the same trade-off
   already accepted and shipped for blocks (issue #71), extended to headings for consistency.
   A secondary benefit: the current pure-regex heading scan in `findLeafHeadingLine` has no
   fence-awareness (unlike `findHeadingSectionEnd`, which does) — a `# text` line inside a fenced
   code block could false-positive as a real heading. Cache-based resolution does not have this
   gap, since Obsidian's own indexer excludes fenced content from `cache.headings`.
5. **Block `^` handling.** A single shared normalizer for stripping/validating the leading `^`
   on a block target, used by every call site that accepts a block identifier (today: only
   `getVaultFilePartial.ts` strips `^+` explicitly; `patchHelpers.ts`'s two block-lookup
   functions assume the caller already stripped it; `resolveLinkTarget.ts` delegates to
   `resolveSubpath`'s own handling). No externally observable change expected for well-formed
   input (`^id` or `id`); tightens/unifies edge-case behavior (e.g. `^^^id`, empty after strip).
6. **`getNoteOutline.ts` anchor fix.** `anchor` becomes the literal heading text (trimmed), not
   a lowercase slug. The tool description already promises `[[note#heading]]`-usable anchors;
   this makes the promise true. `toAnchor()` is removed or reduced to a trim-only helper.

## Data model / API impact

No MCP tool schema changes (argument shapes, `targetDelimiter` default, mode enums all unchanged).
Observable response-shape changes are confined to:
- `get_note_outline`'s `anchor` field per-heading (slug → literal heading text).
- Error message text for previously-silent ambiguous-heading writes (`patch_active_file`,
  `patch_vault_file`, `append_to_periodic_note`) — these calls newly return an explicit
  `isError: true` ambiguity error instead of silently patching/appending under the first
  document-order match.
- Case-insensitive heading matches that previously failed (`Heading not found`) now succeed, for
  every heading-accepting tool (`patch_active_file`, `patch_vault_file`, `get_vault_file_partial`,
  `append_to_periodic_note`).

## Edge cases

- Heading text differing only by case, in `patch_*`, `get_vault_file_partial`, and
  `append_to_periodic_note` — must now resolve (previously: not found).
- Two or more headings sharing the same leaf text at the same effective scope, in every
  heading-accepting write tool — must now error with an explicit ambiguity message (previously:
  `patch_*`/`append_to_periodic_note` silently took the first one).
- A `# text`-shaped line inside a fenced code block, matching a requested heading target, in the
  write path — cache-first resolution must not false-positive on it; the regex fallback path (used
  only when the cache disagrees or is absent) still must not either, since
  `isBlockRangeStructurallyUnsafe`/fence-awareness logic downstream depends on correct heading
  line identification.
- Block reference inside a markdown table, across all three block call sites — must keep
  resolving via the existing regex-fallback path (cache does not index it) with the existing
  table-safety refusal (`isBlockRangeStructurallyUnsafe`) intact.
- Metadata cache absent or stale relative to `rawContent` at write time (e.g., very first write to
  a just-created file, or a rapid double-write) — write path must fall back correctly rather than
  operate on stale line numbers.
- `^` variants: bare id, single `^id`, multiple `^^^id`, empty-after-strip — identical outcome
  across every block call site after the shared normalizer lands.
- Non-markdown files with a subpath (e.g. `diagram.png#page=3`) — unaffected; this path already
  bypasses subpath validation entirely in `resolveLinkTarget.ts` and must keep doing so.
- Nested heading path where an intermediate segment does not exist vs. where only the leaf does
  not exist — error message must still name which segment failed (existing behavior in
  `getVaultFilePartial.ts`; must not regress when write-path ambiguity/case-insensitivity changes
  land next to it).

## Success criteria

- [ ] R-01 — `patch_active_file`/`patch_vault_file` heading targets resolve case-insensitively.
- [ ] R-02 — `get_vault_file_partial` (`mode: "heading"`) resolves heading targets
      case-insensitively.
- [ ] R-03 — `append_to_periodic_note`'s `underHeading` resolves case-insensitively.
- [ ] R-04 — `targetDelimiter`-joined nested heading paths (default `::`) keep working identically
      from the caller's perspective across `patch_active_file`, `patch_vault_file`, and
      `append_to_periodic_note`, with no change to the public argument contract.
- [ ] R-05 — A heading target that matches more than one heading in scope produces an explicit
      ambiguity error from `patch_active_file`, `patch_vault_file`, and `append_to_periodic_note`
      (does not today).
- [ ] R-06 — `get_vault_file_partial`'s existing ambiguity-error behavior for heading targets is
      preserved unchanged.
- [ ] R-07 — The write-path heading resolution (`patchHelpers.ts`) tries the metadata cache first
      and falls back to regex scanning of the literal `rawContent` being written, mirroring the
      existing block-branch pattern; `computePatchedContent` stays synchronous inside
      `vault.process`.
- [ ] R-08 — A heading-shaped line (`# text`) inside a fenced code block is never matched as a
      real heading by the write-path resolution, in either the cache-first or regex-fallback leg.
- [ ] R-09 — Block reference resolution inside a markdown table keeps working via the existing
      regex-fallback path across all in-scope call sites, with the existing table-safety refusal
      intact.
- [ ] R-10 — A single shared function normalizes/validates a block target's leading `^` across
      every in-scope call site (`patchHelpers.ts`'s two block-lookup functions,
      `getVaultFilePartial.ts`'s block mode); well-formed input (`id` or `^id`) behaves
      identically to today.
- [ ] R-11 — `get_note_outline`'s `anchor` field returns the literal (trimmed) heading text
      instead of a lowercase slug; `toAnchor()` is removed or reduced to a trim-only helper.
- [ ] R-12 — Existing tests asserting the previous case-sensitive, non-ambiguity-checked, or
      slug-anchor behavior are updated to assert the converged semantics; no test is deleted
      without a replacement assertion covering the same call site.
- [ ] R-13 — `find_broken_links` and any other consumer of `resolveLinkTarget.ts` shows no
      behavior change from this work (it is the reference implementation, not a change target).
- [ ] R-14 — The ADR produced at Step 2 records, for each of the four convergence points above (case sensitivity, delimiter translation, ambiguity detection, cache-first-with-fallback), which specific functions/call sites were unified vs. which remained intentionally separate and why (no-test: this is a documentation completeness requirement on the ADR artifact itself, not an assertion a test can check).
