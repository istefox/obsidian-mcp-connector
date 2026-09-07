# ADR-0024: Converge the hand-rolled heading/block anchor matchers on one resolver

**Status:** Accepted, not yet implemented
**Date:** 2026-09-07
**Deciders:** Stefano Ferri
**Issue:** [#527](https://github.com/istefox/obsidian-mcp-connector/issues/527) (OMC-041, P3 roadmap technical debt), filed after PR #526 closed #525
**Supersedes:** ADR-0004 Decision 4 (`get_note_outline`'s anchor slug algorithm)
**Relates to:** ADR-0019 / ADR-0022 (write preconditions — the guards that sit downstream of target resolution)

---

## Context

Four independent implementations in this plugin answer the same question — *does this
heading or block anchor exist in this note, and on which line*. One is correct; three
are hand-rolled and mutually inconsistent.

**The correct one.** `services/resolveLinkTarget.ts` delegates to Obsidian's own
`parseLinktext` + `resolveSubpath`. It was written for `find_broken_links` and has since
absorbed two real fork bugs (#522: `[[#Heading]]` means *this document*; #525: an absent
cache is not evidence of a missing heading). Its semantics are the ones a user's wikilinks
actually follow, because they are Obsidian's.

**The three hand-rolled ones.**

1. `services/patchHelpers.ts` — the write path. `resolveHeadingPath(content, leafName,
   delimiter)` walks the raw markdown with `/^(#{1,6})\s+(.+)$/`, comparing
   `headingText === leafName`, and returns the ancestor chain of the *first* document-order
   match. `findLeafHeadingLine(lines, leafHeading)` then re-scans for the first line whose
   text equals the leaf. Consumed by `patch_active_file`, `patch_vault_file` (via
   `computePatchedContent`, inside the `app.vault.process` callback) and directly by
   `tools/appendToPeriodicNote.ts` under the same synchronous constraint. The block half of
   the same file — `findBlockPositionFromCache` → `findBlockReferenceInContent` — already
   runs cache-first-with-regex-fallback (issue #71), which is the pattern this ADR extends.

2. `tools/getVaultFilePartial.ts` — the read path. `findHeadingSection(headings, target,
   delimiter, totalLines)` walks `cache.headings` segment by segment, honours ancestry
   (`h.position.start.line > prevStartLine && < prevEndLine && h.level > prevLevel`),
   compares `h.heading === seg`, and **errors explicitly on ambiguity**. Block mode strips
   `/^\^+/` and validates the remainder is non-empty.

3. `tools/getNoteOutline.ts` — `toAnchor()`, a lowercase-slug generator
   (`toLowerCase` → strip non-`\p{L}\p{N}\s-` → spaces to hyphens).

Three axes of divergence, and one of them is an outright defect.

**Case sensitivity.** `resolveSubpath` matches headings case-insensitively (pinned by
`resolveLinkTarget.test.ts:134`). Both hand-rolled heading matchers use `===`. A heading a
user can reach with `[[Note#heading]]` in the editor cannot be reached with
`patch_vault_file target: "heading"`.

**Nested paths — the defect.** `computePatchedContent` resolves a `::`-joined target, then
**discards every ancestor segment** and looks the leaf up with `findLeafHeadingLine`:

```ts
const targetParts = resolvedTarget.split(targetDelimiter);
const leafHeading = targetParts[targetParts.length - 1];
const found = findLeafHeadingLine(lines, leafHeading);   // ancestors dropped
```

For `# A / ## X / # B / ## X`, an explicit `target: "B::X"` resolves to the `X` under `A`
and patches the wrong section. `appendToPeriodicNote.ts:127-130` carries the identical
code. The read path has never had this bug — `findHeadingSection` walks the ancestors. This
is not a theoretical inconsistency; it is a silent wrong-target write, and it is the reason
this refactor is worth doing rather than deferring.

**Ambiguity.** The read path errors. The write path silently takes the first document-order
match. Two `## Notes` headings in a daily note and `append_to_periodic_note` picks one
without saying which.

**`get_note_outline`'s anchor.** The tool's own `.describe()` says *"Use the anchors to
construct `[[note#heading]]` links"*. Obsidian resolves a wikilink subpath against the
heading text, not against a slug — so `[[note#hello-world-2026]]` does not resolve to
`## Hello World 2026`. The field has never been usable for its documented purpose.
ADR-0004 Decision 4 called the slug "advisory, best-effort, matching Obsidian's own"; the
premise was wrong, because Obsidian has no anchor-slug concept in link resolution at all.

Two further facts constrain the design, both verified against `obsidian@1.13.1`'s
`obsidian.d.ts` rather than assumed:

- `resolveSubpath(cache, subpath)` returns `HeadingSubpathResult | BlockSubpathResult |
  FootnoteSubpathResult | null`, and `HeadingSubpathResult` exposes only `current`/`next`
  (plus `start`/`end` from `SubpathResult`). **There is no ambiguity signal in the API.** A
  second heading with the same text is invisible to the caller.
- `stripHeading()` is documented as *"normalizes headings for link matching"*. Obsidian's
  own matching therefore runs over a normalised form, not the literal text.

`computePatchedContent` must stay synchronous and side-effect-free: it executes inside
`app.vault.process`, and every line number it produces has to describe the exact
`rawContent` handed to that callback, not a cache that may be one keystroke behind.
`getFileCache` is synchronous, so consulting the cache from inside the callback is
allowed — trusting it blindly is not.

## Decision

**1. One shared module, `services/anchorTargets.ts`, owns target resolution for every
in-scope call site.** It is a new services module rather than more exports bolted onto
`patchHelpers.ts`, because `getVaultFilePartial.ts` (a read-only tool) and
`getNoteOutline.ts` would otherwise import from a file whose name and docblock both say
"helpers for patch operations". Its public surface:

| Export | Purpose |
| --- | --- |
| `normalizeBlockId(target)` | Trim, strip leading `^`+, reject empty. The single `^` policy (R-10). |
| `splitHeadingPath(target, delimiter)` | `"A::B"` → `["A", "B"]`, trimmed, blanks dropped. |
| `headingPathToSubpath(target, delimiter)` | `"A::B"` → `"#A#B"` — the form `resolveSubpath` expects. Used by the differential test and available to future callers; not on the hot path (see Decision 2). |
| `headingEntriesFromContent(lines)` | Fence-aware scan of raw markdown → `HeadingEntry[]`. |
| `headingEntriesFromCache(cache)` | `cache.headings` → `HeadingEntry[]`. |
| `resolveHeadingEntries(entries, segments, totalLines)` | The one segment walker. Case-insensitive, ancestry-respecting, ambiguity-reporting. |
| `resolveHeadingForWrite(cache, lines, segments)` | Cache-first, content-fallback, with an agreement check (R-07). |

`HeadingEntry` is `{ heading: string; level: number; line: number }` — deliberately not
Obsidian's `HeadingCache`, so the same walker consumes cache entries and content-scanned
entries without a shape adapter at each call site.

**2. The hot path scans `cache.headings` itself; it does not call `resolveSubpath`.**
`resolveSubpath` stays the *semantic reference* and stays the runtime dependency of
`resolveLinkTarget.ts`, which this ADR does not touch. Three reasons the converged resolver
re-derives its semantics instead of calling it:

- It cannot report ambiguity (`current` is a single heading), so a scan over
  `cache.headings` is required anyway. Calling `resolveSubpath` *and* scanning means two
  code paths to reconcile, not one to share — the opposite of convergence.
- The fallback leg has no `CachedMetadata` to pass it. `rawContent` inside `vault.process`
  is a string; synthesising a fake `CachedMetadata` to satisfy the signature would be
  fabricating the very thing the fallback exists because we do not trust.
- The write path must land on a line in `rawContent`. `resolveSubpath` matches through
  `stripHeading` normalisation, so a heading containing markdown can match a subpath that
  is not its literal text — a position we could not then locate in the content leg.

The cost is that a future change to Obsidian's matching semantics will not propagate
automatically. That is bought back explicitly, not ignored: a differential test asserts
`resolveHeadingEntries` and `resolveSubpath` agree across a fixture matrix, with the two
known divergences (ambiguity, `stripHeading` normalisation) recorded as expected
divergences rather than silently absent. R-07's success criterion is stated against "the
metadata cache", not against `resolveSubpath`, so this satisfies it as written.

**3. Heading matching becomes case-insensitive everywhere in scope.** Comparison is
`a.trim().toLowerCase() === b.trim().toLowerCase()`, on both the cache leg and the content
leg, in both the read and the write path. This aligns to `resolveSubpath` and is an
intentional behaviour change: targets that returned `Heading not found` now resolve.

**4. Ambiguity is an error on every in-scope path, and it outranks
`createTargetIfMissing`.** More than one candidate at the same effective scope returns a
typed error naming the candidates' levels and lines. Critically, an ambiguous target is
*not* routed to the `createTargetIfMissing: true` EOF-append branch: appending at
end-of-file because the real target was ambiguous is the same silent-wrong-write class the
ambiguity check exists to close. The read path's existing message text
(`Ambiguous heading target: "X" matches multiple headings (level N at line M, …)`) becomes
the shared text, so `getVaultFilePartial`'s existing assertion keeps passing unchanged
(R-06).

The message text is shared; the *envelope* is not. The write path returns the new
`ambiguous_heading` through `errorJson` (structured, matching how `stale_precondition` is
already surfaced there per ADR-0019); the read path keeps `errorResponse`'s plain text,
because R-06 requires its current observable behaviour preserved and its test asserts on
that string. Unifying the envelopes would be a gratuitous break of a tool this ADR
otherwise only extends.

**5. Nested paths keep `::` at the MCP boundary and gain real ancestry honouring
internally.** `targetDelimiter` (default `::`) is unchanged in every tool schema.
Internally `splitHeadingPath` produces segments and `resolveHeadingEntries` walks them,
which fixes the ancestor-dropping defect described above. The `#`-chained subpath form is
produced by `headingPathToSubpath` only where an Obsidian-facing subpath string is actually
needed (the differential test today).

**6. Write-path resolution is cache-first with a content fallback *and an agreement
check*.** `resolveHeadingForWrite` resolves against `cache.headings`; if that yields a hit,
it verifies `lines[hit.line]` is a heading line whose text matches the resolved segment
case-insensitively. On mismatch — a stale cache, a just-created file, a rapid double-write —
the cache result is discarded and the resolution is redone against
`headingEntriesFromContent(lines)`. A cache miss falls back the same way. This is the block
branch's shipped pattern (issue #71) extended to headings, plus the verification step the
block branch does not need because `isBlockRangeStructurallyUnsafe` re-reads the content
anyway.

The secondary win: `headingEntriesFromContent` consults `computeFenceOpenState` and skips
heading-shaped lines inside a fence. The current `findLeafHeadingLine` has no
fence-awareness at all, so a ` ``` / # text / ``` ` block could be selected as the patch
target — the heading-branch analogue of #84. The cache leg has never had this gap, because
Obsidian's indexer excludes fenced content from `cache.headings` (R-08 on both legs).

**7. Block `^` handling routes through `normalizeBlockId` at every in-scope call site.**
`getVaultFilePartial`'s `^`-stripping moves into the shared function verbatim, including its
error text. `patchHelpers.ts`'s block branch, which today assumes the caller already
stripped, gains it: `patch_vault_file` with `target: "^abc"` currently fails on both legs
(the cache is keyed without the caret; the regex builds `^^abc`) and will now resolve.
Well-formed `id` input is byte-identical to today.

**8. `get_note_outline`'s `anchor` becomes the trimmed literal heading text; `toAnchor()`
is deleted.** The `.describe()` is amended from "Obsidian-compatible anchor slug" to name
the literal text. `[[note#<anchor>]]` becomes true for the common case, which is what the
description already promised.

**9. Section-end computation is left where it is.** `findHeadingSectionEnd` (fence-aware,
used by the write path and `append_to_periodic_note`) and the read path's cache-derived
closer both stay. `resolveHeadingEntries` returns the entries-derived exclusive `endLine`
for the read path; the write path ignores it and keeps calling `findHeadingSectionEnd`
against the content it is about to splice. Two computations that agree is the correct
outcome here — the write path's boundary must describe `rawContent` exactly, and churning a
tested fence-aware walker to save a few lines is risk with no payoff.

### R-14: what was unified, what stayed separate

| Convergence point | Unified into `anchorTargets.ts` | Left separate, and why |
| --- | --- | --- |
| **Case sensitivity** | `patchHelpers.ts` heading matching, `appendToPeriodicNote.ts` (via `patchHelpers`), `getVaultFilePartial.ts` `findHeadingSection` — all now case-insensitive through `resolveHeadingEntries`. | `resolveLinkTarget.ts` (already correct via `resolveSubpath`, R-13). `services/headingRename.ts` — `rename_heading`'s match is **contractually** case-sensitive (issue #68 RFC edge case 3, asserted at `headingRename.test.ts:61` and stated in `renameHeading.ts`'s `.describe()`). A rename is a destructive whole-vault rewrite; a case-insensitive match there would let `## notes` rename `## Notes` and rewrite every backlink. Different risk profile, deliberately different rule. |
| **Delimiter translation** | `splitHeadingPath` / `headingPathToSubpath` serve `patch_active_file`, `patch_vault_file`, `append_to_periodic_note`, `get_vault_file_partial`. | `headingRename.ts` uses Obsidian's own ` > ` subheading-path separator inside link text, not `::` — that is a wikilink syntax concern, not an MCP argument concern, and merging the two would conflate a wire format with a link format. |
| **Ambiguity detection** | `resolveHeadingEntries` is the single implementation; the write path gains it, the read path's behaviour and message text are preserved. | `headingRename.ts` keeps its own `ambiguous-heading` error because its payload differs — it returns a structured `candidates: HeadingCandidate[]` array as part of the tool's typed error contract, not a prose message. Same concept, different observable shape, already shipped. |
| **Cache-first with content fallback** | `resolveHeadingForWrite` (headings, new) alongside the existing `findBlockPositionFromCache` → `findBlockReferenceInContent` (blocks, unchanged). | The **read** paths stay cache-only. `get_vault_file_partial` and `get_note_outline` reflect what Obsidian's cache sees, on purpose: `getVaultFilePartial.ts`'s frontmatter branch already documents this contract (#138 — "this tool reflects Obsidian's cache and does not re-parse YAML independently"), and a read that disagreed with the app's own index would be a worse failure than one that lags it. The fallback exists because a *write* computes line numbers it is about to act on; a read does not. |

## Alternatives considered

**A. Call `resolveSubpath` on the cache leg of the converged resolver, layering a separate
`cache.headings` scan for ambiguity.** This is the shape SPEC §Architecture point 4
sketches. *Rejected:* the ambiguity layer requires the full scan regardless, so
`resolveSubpath` adds a second resolution path rather than replacing one — and then the two
must be reconciled when they disagree (`resolveSubpath` says found, our scan says
ambiguous; or `stripHeading` normalisation makes `resolveSubpath` match a heading whose
literal text we cannot then locate in `rawContent`). The fallback leg cannot use it at all
for want of a `CachedMetadata`. Net effect: three code paths where the current design has
two. Decision 2 records the mitigation for what this costs us.

**B. Do nothing to the write path; converge only the read path and `toAnchor`.** *Rejected:*
the two worst behaviours — silent first-match-wins on ambiguity, and the ancestor-dropping
nested-path defect — are both on the write path, and the write path is the one that
destroys authored text. Fixing the cheap half would leave the issue's actual motivation
untouched.

**C. Make the write path async and await `metadataCache` freshness before resolving.**
*Rejected:* `computePatchedContent` runs inside `app.vault.process`'s synchronous callback.
Making it async means abandoning the atomic read-modify-write that `vaultWriteLock.ts`'s
docblock and ADR-0019's precondition design both depend on, reintroducing the lost-update
window between resolution and splice. Trading a correct concurrency model for cache
freshness is backwards; the agreement check in Decision 6 gets the freshness guarantee
without giving up atomicity.

**D. Extend `patchHelpers.ts` with the shared functions instead of creating a new module.**
*Rejected:* `getVaultFilePartial.ts` and `getNoteOutline.ts` are read-only tools that would
then depend on a module whose header reads "Shared helpers for patch operations". The
import graph would say the read tools are built on the write tools, which is false and
misleading to the next reader. The cost of a new file is one import line per call site.

**E. Keep `toAnchor()` and add a second `heading_text` field to `get_note_outline`'s
output.** *Rejected:* additive, so it breaks nothing — but the response already carries the
literal text in `text`, so the new field would be a duplicate and the `anchor` field would
remain a value whose documented use case does not work. Two fields, one of them a trap, is
worse than one correct field. The response shape change is acceptable precisely because the
old value was never usable for its stated purpose.

**F. Make matching case-insensitive only on lookup failure (try exact, then retry folded).**
*Rejected:* it hides ambiguity. `## Notes` and `## notes` in one file would resolve exactly
under the two-pass scheme and never trip the ambiguity check, so the write path would keep
its silent first-match-wins behaviour for precisely the inputs where it is most surprising.
One rule, applied once, is also the only version that is testable without enumerating the
fallback order.

## Consequences

### Positive

- The nested-path write defect is fixed: `target: "B::X"` resolves under `B`, not under the
  first `X` in the file. This closes a silent wrong-section write in `patch_active_file`,
  `patch_vault_file` and `append_to_periodic_note`.
- A heading a user can link to in the editor is a heading these tools can reach. The
  case-sensitivity gap between the plugin and the app it runs inside is closed.
- Ambiguous write targets fail loudly instead of guessing, and the failure names the
  candidate lines so the caller can disambiguate with `targetDelimiter` on the retry.
- The write path stops being able to select a heading-shaped line inside a fenced code
  block — a latent #84-class bug in `findLeafHeadingLine` that had no test and no report.
- `patch_*` accepts `^id` for block targets, matching `get_vault_file_partial` and matching
  what a caller who just read a `^`-prefixed id from the document would naturally send.
- `get_note_outline`'s `anchor` becomes usable for the purpose its own description states.
- Four matchers become two: the shared resolver, plus `resolveLinkTarget.ts` for the
  wikilink domain. Each remaining separation is now a recorded decision rather than an
  accident of authoring order.

### Negative

- **Three observable behaviour changes ship together**, which makes the blast radius of a
  mistake wider than any one of them alone: newly-succeeding case-insensitive matches,
  newly-failing ambiguous writes, and `get_note_outline`'s changed `anchor` values. A
  caller with two same-named headings that was quietly patching the first one now gets an
  error. That is the intended fix, and it is still a break for whoever depended on it.
- The nested-path fix redirects writes that previously landed elsewhere. A caller that had
  worked *around* the ancestor-dropping bug by passing a path it knew resolved to the first
  match will now hit the heading it originally named. Correct, and still a change.
- `get_note_outline`'s response shape changes without an MCP schema change, so a client
  cannot detect it by inspecting `tools/list`. Mitigated only by the `.describe()` update
  and the changelog.
- The converged resolver re-derives `resolveSubpath`'s semantics rather than calling it, so
  an upstream change to Obsidian's matching rules will surface as a differential-test
  failure rather than propagating for free.
- `stripHeading` normalisation remains a residual divergence: a heading containing markdown
  (`## **Bold** heading`) is matched literally by the converged resolver and normalised by
  `resolveSubpath`. Out of scope here — modelling it needs a faithful `stripHeading` in
  `test-setup.ts`, and a partial mock of a normaliser invites false confidence. Worth a
  follow-up issue; not worth bundling into a convergence that is already changing three
  observable behaviours.

### Neutral

- No MCP tool schema changes: argument shapes, `targetDelimiter`'s default, and the mode
  enums are all untouched. Nothing in `tools/list` moves.
- `resolveLinkTarget.ts` and `find_broken_links` are unchanged (R-13), guarded by an
  explicit no-diff regression check in the plan rather than by assumption.
- `computeFenceOpenState`, `isInsideTableOrFencedCodeAt` / `isInsideTableOrFencedCode`,
  `isBlockRangeStructurallyUnsafe`, `hasParentH1` / `hasAnyH1` and `findHeadingSectionEnd`
  keep their current signatures and behaviour. They are safety checks applied *to* a
  resolved position; changing how the position is found does not touch them.
- `test-setup.ts`'s `setMockMetadata` already emits `position.start.line` on heading
  entries, which is the whole shape `HeadingEntry` needs. No mock change is required for
  the resolver itself. The mocked `resolveSubpath` returns `current` without `next`, which
  the differential test does not read.
- Block resolution inside a markdown table keeps working exactly as today: the cache does
  not index it, the regex fallback finds it, and `isBlockRangeStructurallyUnsafe` refuses
  the splice (R-09). None of those three steps is on the path this ADR changes.

## References

- Issue [#527](https://github.com/istefox/obsidian-mcp-connector/issues/527) — OMC-041.
- `SPEC.md` (topic `converge-the-three-inconsistent-heading`), success criteria R-01…R-14.
- ADR-0004 §Decision 4 — the superseded anchor-slug decision.
- ADR-0019, ADR-0022 — write preconditions; the guards downstream of target resolution.
- Fork issues #71 (block-in-table, cache-first pattern), #80/#83 (root-orphan H2),
  #84 (block inside a fence), #137 (heading section end inside a fence), #138
  (cache-reflecting reads), #522/#525 (`resolveLinkTarget.ts`'s own history).
- `obsidian@1.13.1` `obsidian.d.ts`: `resolveSubpath` (l. 5500), `HeadingSubpathResult`
  (l. 3394), `SubpathResult` (l. 6846), `stripHeading` (l. 6835), `stripHeadingForLink`
  (l. 6841).
