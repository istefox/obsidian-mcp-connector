# ADR-0026: An `obsidian://open` URI field on the note-identifying tools

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Stefano Ferri
**Issue:** [#533](https://github.com/istefox/obsidian-mcp-connector/issues/533) — return the
Obsidian URI of a note
**Spec:** `SPEC.md` (topic `issue-533-return-the-obsidian-uri-of-a`), R-01 … R-11
**Relates to:** ADR-0018 (no `outputSchema` on a polymorphic tool; the `ui://` search payload),
ADR-0020 (folder exclusion — the guarded `App` this feature deliberately does not touch),
ADR-0023 (token budget — what a new field and a new parameter cost), ADR-0024 (the one converged
heading resolver this feature reuses instead of writing a fifth)

---

## Context

A client that has just read or found a note through this server has the note's vault-relative
path and nothing else. To hand the user a clickable link it must know the vault's name, the
`obsidian://open` grammar, and the encoding rules — three things an LLM guesses wrong often
enough to matter, and two of which it cannot know at all (the vault name is not in any tool
result today except the `ui://` search payload's `vaultName`, which is `_meta` and not addressed
to the model).

Five tools already return a result that names exactly one file, or one file per row:

| Tool | Success shape today | Reads content? |
| --- | --- | --- |
| `get_vault_file` | polymorphic: raw text, `format=json` object (via `successJson`), `text_truncated` hint, `binary_file` hint, native image/audio block | yes |
| `get_active_file` | raw markdown via `successText`, or `successText(JSON.stringify(body))` for `format=json` | yes |
| `get_or_create_daily_note` | `successText`-shaped, but hand-built: `JSON.stringify({path, content, created})` | yes |
| `search_vault_simple` | `{results: [{filename, matches, moreMatches?}]}` | yes (per file) |
| `search_vault_smart` | `{results: SearchResult[]}` | provider-side |

Four facts from the current code constrain every option below. All four were read, not assumed.

**1. `readVaultFileAsJson` is shared with `get_vault_files`.** `getVaultFile.ts:191` exports it and
`getVaultFiles.ts:90` consumes it. `get_vault_files` is out of scope (R-09). Any `uri` added inside
that function lands in a tool this feature is required to leave alone.

**2. The `ui://` search payload's projection is guarded by a type-level exhaustiveness assertion.**
`searchResultsPayload.ts:70-77` computes `Unprojected = Exclude<keyof SearchResult, keyof
SearchResultRow | NotProjected>` and fails the build, naming the offending key, when `SearchResult`
grows a field that no row carries. So adding `uri` to `SearchResult` (the semantic-search type, also
implemented by every provider) does not merely widen a type — it breaks `bun run check` until the
`ui://` payload shape is also changed, and that shape is fixed by ADR-0018 D6 and baked into the
generated `searchResultsAppSource.ts`.

**3. Heading resolution is already converged, once, deliberately.** ADR-0024 replaced three
hand-rolled matchers with `services/anchorTargets.ts`. It is case-insensitive
(`normalizeHeadingText`), fence-aware on the content leg (`headingEntriesFromContent` →
`computeFenceOpenState`), ancestry-respecting, and ambiguity-reporting. `get_vault_file_partial`
resolves over the cache leg (`getVaultFilePartial.ts:210`); the write path resolves cache-first with
the content as arbiter (`resolveHeadingForWrite`). A `heading` input that hand-rolls
`headings.some(h => h.heading === heading)` would be the fifth matcher, six days after the fourth
was deleted.

**4. Two existing colocated tests assert a single content block.**
`getVaultFile.test.ts:31` and `getActiveFile.test.ts:28` both assert
`expect(result.content).toHaveLength(1)` on the default text branch. Any change to the number of
content blocks on that branch is an observable-contract change with known call sites, not a silent
addition.

### What was verified about Obsidian's URI grammar, and how

R-03 and R-04 turn on one question the SPEC deliberately left open ("verified against actual
Obsidian behavior during implementation, not assumed from the query-parameter encoding rule"):
**where does a heading go in an `obsidian://open` URI?**

Checked on 2026-09-13 against Obsidian's own help page for the URI scheme
(`help.obsidian.md/Extending+Obsidian/Obsidian+URI`, which 301-redirects to
`obsidian.md/help/Extending+Obsidian/Obsidian+URI`). Two statements are load-bearing, quoted from
that page:

- On encoding: *"Ensure that your values are properly URI encoded. For example, forward slash
  characters `/` must be encoded as `%2F` and space characters must be encoded as `%20`."* — and
  *"an improperly encoded 'reserved' character may break the interpretation of the URI."*
- On headings: *"With proper URI encoding, you can navigate to a heading or block within a note.
  `Note%23Heading` would navigate to the heading called 'Heading', whereas `Note%23%5EBlock` would
  navigate to the block called 'Block'."*

So the heading is **part of the `file` parameter's value**, with `#` encoded as `%23` — it is not a
URI fragment appended after the query string. The SPEC's URI-construction sketch
(`…&file=<encoded path>[#<encoded heading>]`, a bare `#` after the query) is therefore wrong as
written: a literal `#` at that position opens a fragment, which is not part of the query Obsidian's
handler parses, and the heading would be silently dropped. This ADR corrects it; see D2.

Confidence: high on the grammar (primary source, quoted). **Best-effort, not verified end-to-end,
on resolution behaviour for exotic values**: no live `obsidian://` round trip was performed from
this session (it needs a running Obsidian and a real vault, neither reachable from here), so the
claims below about what Obsidian *does* with an ambiguous or `#`-containing heading are reasoned
from its documented link-resolution semantics (`parseLinktext` + `resolveSubpath`, which this repo
already depends on in `resolveLinkTarget.ts`), not observed. R-03's end-to-end leg is a manual check
in a real vault, listed as such in the plan.

A second, weaker corroboration: this repo's own `headingRename.ts:260-271` deliberately does *not*
use `encodeURIComponent` for heading fragments, on the grounds that Obsidian leaves `!`, `'`, `(`
and `)` alone. That is about markdown-link text written *into* a note — bytes a human reads and
Obsidian round-trips — and is not evidence about a URI handed *to* a URI parser. See D3.

---

## Decision

### D1 — A `uri` field on the existing results. No `get_note_uri` tool.

Every candidate tool already returns a result that names the file, so the URI is a field on
something that already exists. A dedicated tool would add an input schema to every session's
`tools/list` for all 52 tools' worth of budget — directly against ADR-0023, which just cut the
session-fixed surface from ~10.9k to ~3.7k tokens for a new client — and would cost a second round
trip to get a string the first call could have carried. (SPEC scope; R-01, R-08.)

### D2 — One shared constructor: `services/buildObsidianUri.ts`.

```
obsidian://open?vault=<encodeURIComponent(vaultName)>&file=<encodeURIComponent(path[#heading])>
```

The heading, when present, is joined to the path with a literal `#` **before** encoding, so the
single `encodeURIComponent` call emits `%23` for the separator, `%2F` for every path slash and
`%20` for every space — exactly the form Obsidian's help page documents. One call site for the
grammar, five consumers, no encoding logic duplicated. The module is pure: no `obsidian` import, no
`App`, no I/O, so it is unit-testable without a vault fixture (same property `searchResultsPayload.ts`
claims in its own header). (R-01, R-03, R-04.)

The vault name is read fresh from `app.vault.getName()` at construction time, never cached. It is a
`PASSTHROUGH` member of the guarded `App` (ADR-0020 D2 lists it explicitly as provably path-free),
so it is reachable from every tool handler without touching the policy seam.

### D3 — `encodeURIComponent`, not `headingRename.ts`'s narrow subset.

Over-encoding is lossless for a value that is about to be percent-decoded by a URI parser: `%21`
decodes back to `!`. Under-encoding is not: an unencoded `&`, `#` or `?` in a vault name or path
truncates or re-partitions the URI. The two rules live in the same repo for a reason and must not be
merged: `headingRename.ts` produces link text that is written into a note and read by a human,
where matching Obsidian's own sparse encoding keeps diffs clean; this module produces a URI consumed
by Obsidian's handler, where maximal encoding is strictly safer. Both files carry a comment pointing
at the other. (R-03.)

### D4 — Raw-text results get a **second** content block, not an appended line.

`get_vault_file` (default/text) and `get_active_file` (default/markdown) return
`content: [{type: "text", text: <note content>}]`. The URI is added as `content[1] = {type: "text",
text: "URI: obsidian://…"}`.

R-02 requires the leading content block to be byte-identical to before this change, and the SPEC's
own rationale says "the appended block is at the end" — only a second block satisfies both. Mutating
`content[0].text` to `content + "\n\n---\nURI: …"` (the form the SPEC's illustrative snippet shows)
would corrupt every caller that treats the first block as the file's bytes, including any hash,
byte-count or write-precondition comparison built on a previous read (ADR-0019's territory). The
`---` separator from that snippet is dropped: a block boundary already separates the two, and a bare
`---` at the start of a text block is ambiguous with a YAML frontmatter fence.

The block is emitted by a shared `withUriBlock(result, uri)` helper, shape-preserving and
no-op-on-`isError`, mirroring `withSearchResultsPayload`'s established pattern (ADR-0018 D5).

**This is an observable-contract change with two known call sites**, both listed in the plan:
`getVaultFile.test.ts:31` and `getActiveFile.test.ts:28` assert `toHaveLength(1)` and must be
updated to assert the new two-block shape. (R-02.)

### D5 — JSON-shaped results get a sibling `uri` key, added at the handler, never inside `readVaultFileAsJson`.

`get_vault_file`'s `format=json` branch spreads the shared reader's output and adds the key:
`successJson({ ...json, uri })`. `VaultFileJson` itself is unchanged, so `get_vault_files` keeps
emitting exactly what it emits today (R-09). `getVaultFileOutputSchema` — the internal-only contract
type that documents the `format=json` response and is asserted against real handler output by
`getVaultFile.test.ts:122` — gains `uri: "string"`, because it describes `get_vault_file`'s response
and would otherwise drift from it. It is still **not** declared as the tool's MCP `outputSchema`
(ADR-0018; the 0.27.2–0.27.6 breakage), and `index.test.ts`'s registry-wide
"no registered tool declares an MCP outputSchema" guard stays as the enforcement. (R-01, R-07, R-09.)

`get_active_file` (`format=json`) and `get_or_create_daily_note` add `uri` to the object they already
`JSON.stringify`.

### D6 — `uri` also lands on `get_vault_file`'s two JSON hint branches, and deliberately not on the native image/audio blocks.

The `text_truncated` and `binary_file` hints are JSON objects that name the file and tell the caller
what to do next — `binary_file`'s hint text already says "use `show_file_in_obsidian`", which is the
very action a URI performs. Leaving them out would make the field's presence depend on a file's size
or extension for no reason a caller could predict, so both gain `uri`.

The native `image` and `audio` branches return a single non-text content block. They get nothing: a
second text block there changes a shape whose whole point is "one binary block", and a client
rendering an image would have to learn to skip a trailing text sibling. Recorded as a decision so
the asymmetry is not read later as an oversight.

This is one step beyond R-01's literal wording ("`format=json`"); it is bounded to branches of the
same tool and is tested in the same task.

### D7 — The optional `heading` input is validated through ADR-0024's resolver, content-first with a cache fallback.

New optional input on `get_vault_file`, `get_active_file`, `get_or_create_daily_note`:
`"heading?": type("string>0")`. A new export in `anchorTargets.ts` — not a new module and not a
fourth matcher — resolves it:

```
resolveHeadingForUri(cache, lines, heading) -> {ok: true, heading: <canonical text>} | {ok: false}
```

It calls `resolveHeadingEntries` over `headingEntriesFromContent(lines)` first, and only if that
says `not-found` does it retry over `headingEntriesFromCache(cache)`. Found in either leg wins.

- **Content first**, because the content is already in hand in all three tools (they read it for
  their own response), because the SPEC says validation is against "the note's content", and because
  it is the only leg that is correct for a just-created daily note, whose headings Obsidian has not
  indexed yet — a cache-only check would reject a heading the template just wrote.
- **Cache as fallback**, because `get_vault_file`'s content can be *truncated* at the
  `maxTextOutputKB` cap; a heading past the cut exists in the note but not in the string we hold, and
  the cache covers the whole file.
- **Found-in-either**, accepting one wrong direction knowingly: a heading still listed in a stale
  cache but already deleted from the file resolves, and Obsidian then opens the note without
  scrolling. For a navigation URI that degradation is invisible-to-harmless and instantly obvious to
  the user. This is the opposite trade to ADR-0024 D6's write path, where the content must win
  because the failure mode there is a silent write into the wrong section.

Case-insensitivity and fence-awareness come free from the shared resolver, which also means the
`uri` carries the **note's own** heading text, not the caller's casing: after a hit, the matching
entry's `heading` is used verbatim, so the emitted URI reads the way the note reads.

### D8 — Ambiguity is not an error for a navigation URI; the first match in document order wins.

`resolveHeadingEntries` can return `ambiguous`. ADR-0024 D4 makes that an error on every path it
covers, because those paths write. This one does not. Obsidian's own `[[note#X]]` resolves to the
first match, so the URI emitted for an ambiguous heading is byte-identical to what a user typing
that wikilink would get; refusing it would make the MCP surface stricter than Obsidian's UI for a
read-only, reversible action, and offering an escape hatch would mean a `targetDelimiter`
parameter on three more tools (nested-path syntax), which is `tools/list` budget spent against
ADR-0023 to disambiguate a jump target. So `ambiguous` is treated as found, using
`candidates[0]` — document order on both legs, since both build their entry list in line order.

### D9 — `heading_not_found` is the single new error code, emitted through `errorJson`.

Not found in either leg (including a `heading` that is whitespace-only after trimming, and a
`heading` supplied for a file with no readable text content — an image, an audio file, an
unsupported binary) fails the whole call:

```json
{"error":"…\"<heading>\" … <path> …","errorCode":"heading_not_found","heading":"<heading>","path":"<path>"}
```

`errorJson(error, errorCode, extras)` already produces exactly this envelope, key order included.
One code, not three, because R-05 names one and a caller's recovery is the same in all three cases:
ask for the note's outline (`get_note_outline`, whose `anchor` is the literal heading text since
ADR-0024 D8) and retry. No `uri` and no content is returned on this branch (R-05). The message and
the code live next to the builder in `buildObsidianUri.ts`, so the three tools cannot drift on
wording.

### D10 — Search results carry a file-level `uri` per row, and the `ui://` payload is untouched.

`search_vault_simple` adds `uri` to each file entry (one per file, alongside `filename`);
`search_vault_smart` adds `uri` to each result row. No heading targeting: a search hit's heading is
a *chunk* property on the smart side and absent on the simple side, and the `line` it reports is
explicitly not a jump target (this repo's standing rule, ADR-0018 D11).

Critically, `uri` is **not** added to the `SearchResult` type. `searchVaultSmart` maps its rows into
a local wire shape and still passes the original `results` to `projectSmartSearchResults`, so the
`Unprojected` exhaustiveness assertion in `searchResultsPayload.ts` stays satisfied, ADR-0018 D6's
fixed payload shape is unchanged, and the generated `searchResultsAppSource.ts` does not need
regenerating. The view already has `vaultName` and builds its own navigation host-side; it needs
nothing from this feature. (R-08.)

### D11 — No exclusion check anywhere in this feature.

ADR-0020 D1's guarded `App` gates `getAbstractFileByPath`, `vault.read`/`cachedRead` and
`getMarkdownFiles` before any handler line runs; ADR-0020 D3 makes the refusal the tool's own
pre-existing not-found branch. `uri` construction is reachable only *after* a successful read, so
an excluded path never reaches it, and every error branch returns before it. Verified by reading
all five handlers: none contains an exclusion check of its own today, and none gains one.

One hardening, because the feature changes what a leak would look like: the
`composeToolRegistry.test.ts` canary asserts the excluded path's plain string is absent from a
`search_vault_simple` response. A leaked `uri` would carry `Therapy%2Fsession.md`, which that
assertion would not catch. The canary gains the percent-encoded form. (R-06.)

### D12 — `get_or_create_daily_note` keeps `successText` and converts its four hand-built error returns to `errorJson`.

Two halves, opposite directions, both deliberate.

*Success stays hand-shaped.* Routing it through `successJson` would add `structuredContent` to a
tool that has never emitted it — a wire-shape change no requirement asks for, on a tool in the
`core` set, at the exact moment ADR-0009's dual-emit question is parked pending an upstream redesign.
It keeps `successText(JSON.stringify({path, content, created, uri}))`: one new key, nothing else
moves.

*Errors move to the helper.* The four existing error returns hand-build
`{content:[{type:"text",text:JSON.stringify({error, errorCode, …})}], isError:true}`, which is
byte-for-byte what `errorJson(error, errorCode, extras)` returns, key order included (`error`,
`errorCode`, then extras). The new `heading_not_found` branch must use `errorJson` — it is the
shape R-05 names and the one D9 centralizes — and leaving four hand-built errors beside one
helper-built error in a 120-line file is precisely the drift `responseBuilders.ts`'s own header says
it exists to prevent. Existing tests assert on the parsed JSON, so a byte-identical conversion keeps
them green without edits; if any assertion moves, the conversion was not byte-identical and the test
is right.

### D13 — Discovery is README plus the new parameter's own description. The five tool descriptions do not grow prose about `uri`.

`.describe()` text is session-fixed token cost on every client, and ADR-0023 D7 spent real effort
shortening it. A returned key named `uri` whose value starts with `obsidian://` is self-describing
in the result itself; the README's tool table and a short section are where a reader looks for the
contract. The three new `heading` parameters do get a description — a new input without one is
unusable — at roughly 30 tokens each, ~90 total, which is the whole session-fixed cost of this
feature. (R-11.)

---

## Alternatives considered

### A. A dedicated `get_note_uri` tool

Rejected. It adds a 52nd→53rd input schema to every session's `tools/list` (ADR-0023's measured
session-fixed budget) and a second round trip, to return a string that the call which already found
the note could have carried. The SPEC rejects it in scope; this ADR agrees for the token reason
specifically.

### B. Append the URI to the existing text block (`content + "\n\n---\nURI: …"`)

Rejected. R-02 requires the leading block byte-identical, and any consumer that treats block 0 as
the file's bytes — a diff, a hash, a byte count, a write precondition per ADR-0019 — would silently
read the appended footer as file content. The SPEC's illustrative snippet shows this form; its own
requirement text and rationale contradict it, and the requirement wins (D4).

### C. Put the heading in a URI fragment after the query string (`…&file=Note#Heading`)

Rejected on primary-source evidence, not taste. Obsidian's help page documents the heading as part
of the `file` value with `#` encoded as `%23` (`Note%23Heading`). A literal `#` at that position
starts a URI fragment, which is not part of the query string the handler parses, so the heading
would be dropped and the URI would silently degrade to "open the note". This is the SPEC's sketched
form; see D2 and the verification note above.

### D. Use `headingRename.ts`'s narrow `encodeHeadingFragment` for the heading

Rejected. It encodes only `% # ? & [ ]`, leaving `+`, `=`, `;`, `,` and non-ASCII untouched —
correct for markdown link text inside a note (its actual job, where matching Obsidian's sparse
encoding keeps diffs clean), wrong for a query-parameter value. Reusing it would be convergence for
its own sake between two functions that answer different questions; D3 records the distinction in
both files instead.

### E. Add `uri` inside `readVaultFileAsJson`

Rejected. `get_vault_files` consumes the same function (`getVaultFiles.ts:90`) and R-09 requires it
unchanged. It would also force `VaultFileJson` to carry a field one of its two producers cannot
fill meaningfully (a 20-file bulk read has 20 URIs, which is the shape R-09 defers). The handler-level
spread in D5 costs one line and keeps the blast radius at one tool.

### F. Add `uri` to `SearchResult`

Rejected, and it would not have compiled. `searchResultsPayload.ts:70-77`'s `Unprojected` assertion
fails the build the moment `SearchResult` grows a key no `SearchResultRow` carries — by design, from
issue #466. Satisfying it means changing ADR-0018 D6's fixed `ui://` payload shape and regenerating
`searchResultsAppSource.ts`, for a field the view does not use (it has `vaultName` already). The
local wire-row mapping in D10 keeps the type, the payload and the generated asset untouched.

### G. Hand-roll heading validation (`cache.headings?.some(h => h.heading === heading)`)

Rejected. It would be the fifth heading matcher in this codebase, added days after ADR-0024 deleted
the third and fourth, and it would be wrong in three ways the converged resolver already handles:
case-sensitive (`resolveSubpath` is not, ADR-0024's §Case sensitivity), blind to fenced code blocks,
and silently first-match on ambiguity with no signal. Reuse costs one new export in the module that
already owns this question.

### H. Reuse `resolveHeadingForWrite` for the `heading` input

Rejected on naming and on cost, not on behaviour — its cache-first/content-arbiter semantics would
be acceptable here. But a read-only URI builder calling a function named "ForWrite" is a trap for
the next reader, and its cache leg exists to preserve cache-derived *line numbers* on the hot write
path, which a URI never uses. D7's content-first/cache-fallback is the same two legs in the order
this caller needs, with the truncation case (which the write path cannot have) handled explicitly.

### I. Cache-only validation, matching `get_vault_file_partial`'s read path

Rejected. `get_or_create_daily_note` can return a note created milliseconds earlier, whose headings
Obsidian has not indexed; a cache-only check rejects a heading the template just wrote, which is
exactly the "`heading_not_found` on a just-created note" complaint the SPEC's edge-case list tries
to bound. `get_vault_file_partial` can live with the cache because it is not in the business of
creating the file it reads.

### J. Make ambiguity an error (`ambiguous_heading`), consistent with ADR-0024 D4

Considered seriously, rejected. ADR-0024 D4's justification is explicit: an ambiguous target routed
to a write is a silent wrong-section write. A URI is navigation — reversible, visible, and already
what `[[note#X]]` does in Obsidian's own UI, which resolves to the first match without asking. An
error here would be stricter than the editor, and the only escape hatch (nested `A::B` paths) means
a `targetDelimiter` parameter on three tools. Revisit if a user reports landing on the wrong
section: the fix is then the parameter, not the error.

### K. Omit `uri` from search results, or gate it behind an `includeUri` parameter

Rejected for now. Search is where a clickable link is most useful (a ranked list the user wants to
open), and the parameter itself costs `tools/list` tokens on both search tools to save response
tokens — a trade that only pays if the response cost is actually felt. The cost is measured and
recorded in Consequences with a revisit trigger instead of pre-empted with a knob.

### L. Emit a single `uriPrefix` (or `vaultName`) once per search response and let the client build the rest

Rejected. It defeats the issue: the caller is back to knowing the grammar and the encoding rules,
which is the work this feature exists to remove, and a model that concatenates a prefix with an
unencoded path produces a broken URI that looks plausible.

### M. Add `uri` prose to the five tool descriptions

Rejected. ~5 × 25 tokens of session-fixed cost on every client for information the result key
already conveys and the README documents (D13). ADR-0023 spent a chain's worth of effort in the
other direction.

---

## Consequences

### Positive

- A client that read or found a note can hand the user a working deep link with no second call, no
  vault-name lookup and no encoding guesswork. That is the whole of issue #533.
- The URI grammar exists once, in a pure module with no `obsidian` import, so its encoding is
  unit-testable against the exact cases R-03 names (spaces, non-ASCII, nested paths) without a vault.
- `heading` targeting is the first *read-side* consumer of ADR-0024's resolver, which means the
  convergence pays off a second time: case-insensitive matching, fence-awareness and
  ambiguity-detection arrive for free, and a future change to heading semantics has one place to land.
- `get_or_create_daily_note` loses its last hand-built error envelopes (D12), so `responseBuilders.ts`
  now owns every error shape in that file.
- The exclusion canary gets strictly stronger: it now catches a leak in either the plain or the
  percent-encoded form (D11).
- The `ui://` search view, the generated `searchResultsAppSource.ts`, `SearchResult`, `VaultFileJson`,
  `get_vault_files`, `get_vault_file_partial` and `get_or_create_periodic_note` are all untouched.

### Negative

- **Per-call token cost on search, unbounded by any knob.** A `uri` is ~55–70 characters, roughly
  20 tokens. `search_vault_simple` defaults to 50 files → up to ~1,000 tokens added to a
  worst-case response; `search_vault_smart` defaults to 10 → ~200. This runs against ADR-0023's
  direction on the same release. Accepted per D10/K, with an explicit revisit trigger: if a user
  reports search-response size, the follow-up is an `includeUri` (default true) parameter or a
  one-per-response prefix, not a silent removal.
- **~90 tokens of session-fixed cost** for the three `heading` parameter descriptions, paid by every
  client on every session whether or not it ever passes one.
- **A two-block default response is a shape change.** Two in-repo assertions must be updated (D4),
  and an out-of-repo consumer that hardcodes `content[0]` is fine while one that asserts
  `content.length === 1` is not. There is no way to satisfy R-02's byte-identical-leading-block
  requirement without it.
- **The stale-cache direction of D7 can emit a heading that no longer exists**, and Obsidian will
  open the note without scrolling. Chosen knowingly over rejecting a just-created note's heading.
- **Ambiguous headings resolve silently to the first match** (D8), diverging from ADR-0024 D4's
  rule on every other heading path in the codebase. The divergence is now documented in two places
  and will read as an inconsistency to anyone who finds only one of them.
- **A literal `#` in a heading or a path cannot be expressed.** `encodeURIComponent` emits `%23` for
  both the separator and the literal, and Obsidian's grammar has no escape for it — the same
  ambiguity its own wikilinks have. The URI degrades to opening the note. Not fixable at this layer;
  recorded.
- Two vaults with the same name are ambiguous to `obsidian://open?vault=<name>`; Obsidian resolves
  to whichever it knows. The vault-ID form is available but is not reachable from
  `app.vault.getName()`, so this is not addressed.

### Neutral

- Block references (`^blockid`), line targeting, `get_or_create_periodic_note`, `get_vault_files` and
  `get_vault_file_partial` stay out of scope (SPEC). `get_or_create_periodic_note` is the obvious
  next call site — it has the same shape as the daily-note tool — and D2's builder plus D7's resolver
  are the two pieces it would need, so that follow-up is additive.
- `getVaultFileOutputSchema` gains `uri` and stays internal-only. It is still not an MCP
  `outputSchema`, and `index.test.ts`'s registry-wide guard remains the thing that enforces that
  (R-07).
- ArkType's optional-parameter emission is already normalized by `normalizeInputSchema`'s
  single-member-`anyOf` unwrap (ADR-0023), and `index.test.ts`'s registry-wide R-06 assertion covers
  the three new optional `heading` parameters without a new test.
- The `obsidian://` end-to-end leg of R-03 is not machine-verifiable in this repo. It stays a manual
  check in a real vault, declared as an external dependency in the plan rather than quietly assumed.
- ADR-0024's own status line still reads "Accepted, not yet implemented" while `anchorTargets.ts` and
  its five call sites are shipped. Noticed while reading it for D7; not corrected here, since an
  unrelated ADR's header is not this feature's diff.

---

## References

- Issue #533 — return the Obsidian URI of a note (the originating request)
- `SPEC.md` (`issue-533-return-the-obsidian-uri-of-a`) — R-01 … R-11, and the URI-construction
  sketch this ADR corrects in D2/Alternative C
- Obsidian help, *Extending Obsidian → Obsidian URI* — the `open` action's parameters, the
  encoding requirement, and the `Note%23Heading` heading form (fetched 2026-09-13 via the
  `obsidian.md/help/…` redirect target)
- ADR-0018 — MCP Apps `ui://` resource: the no-`outputSchema` rule (D5, D7 here), the fixed search
  payload shape (D10, Alternative F), `withSearchResultsPayload`'s shape-preserving pattern (D4)
- ADR-0019 — write preconditions across MCP calls: why a mutated leading content block is not
  cosmetic (D4, Alternative B)
- ADR-0020 — vault folder exclusion: D1's guarded `App`, D2's `getName` PASSTHROUGH classification,
  D3's inherited refusal semantics (D11 here)
- ADR-0023 — token usage optimization: the session-fixed budget that rejects a new tool and new
  description prose (D1, D13, Alternatives A, K, M), and `normalizeInputSchema`'s `anyOf` unwrap
- ADR-0024 — converged anchor matchers: the resolver D7 reuses, the case-insensitivity and
  fence-awareness it inherits, D4's ambiguity rule that D8 deliberately diverges from, and D8's
  literal-heading `anchor` that makes `get_note_outline` the recovery path for `heading_not_found`
- ADR-0009 — structured tool output: the parked dual-emit question behind D12's "success stays
  `successText`"
- `docs/superpowers/plans/2026-09-13-issue-533-return-the-obsidian-uri-of-a.md` — the
  implementation plan and its per-task R-NN citations
