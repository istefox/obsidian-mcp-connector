# ADR-0019: Write preconditions across separate MCP calls

- **Status:** Accepted and **implemented** 2026-08-17 (see the amendment at the foot of this file)
- **Date:** 2026-08-17
- **Issue:** [#445](https://github.com/istefox/obsidian-mcp-connector/issues/445), from
  @Madulone's discussion [#352](https://github.com/istefox/obsidian-mcp-connector/discussions/352)
- **Research:** [#465](https://github.com/istefox/obsidian-mcp-connector/issues/465)
- **Supersedes:** the shape proposed in #445's own body, in three specific ways recorded below

## Context

PR #351 closed the non-atomic read-modify-write **inside** one call. What survives is the gap
between two calls: an agent reads, reasons, then writes from a read that has gone stale. No
server-side lock can span that without being held across a window in which the holder may never
return.

Everything below rests on facts that were measured for this decision rather than assumed. Three of
them contradict the issue this ADR answers.

### The irreducible outcome is not "no lost update"

The vault has several independent writers — the agent, the human typing in the editor, and Obsidian
Sync landing remote changes — and this server controls exactly one of them. The outcome worth
buying is that **no agent write silently destroys another writer's work**, and the conflicting
writer will usually be the **human**. #445 says as much in its "Known consequence" and then designs
for the agent-versus-agent case.

### There is no byte-level lost update left in the target tools

All three tools #445 names are **transformations recomputed against current content inside
`vault.process`**:

- `tools/searchAndReplace.ts:184`, whose own comment at `:178` says it: *"re-match and replace
  against the CURRENT content inside vault.process, not against the scan-phase snapshot — a write
  landing between scan and apply (another MCP request, the editor) is neither clobbered nor
  double-applied."*
- `tools/renameHeading.ts:201` and `:239`, per file, source and every backlinker
- `services/patchHelpers.ts:738-739`, where `computePatchedContent` runs on `rawContent` inside the
  process callback

A stale read never lands on top of a newer file, because the write is not a blob. What survives is
**semantic** staleness: the transformation applies cleanly and may no longer be the transformation
the agent would have chosen.

### Only one operation destroys authored text

| Tool | What actually goes wrong |
|---|---|
| `patch_vault_file`, `operation: "replace"` | The human rewrote that section; **their text is destroyed.** |
| `search_and_replace` | Over-applies (the human added occurrences) or re-applies (the human already fixed it). Wrong, not destructive. |
| `rename_heading` | Near-idempotent. Low risk. |

#445's constraint 2 excludes the append tools because appends are commutative, so a guard there
would manufacture conflicts. That reasoning applies more widely than it was applied: two of the
three tools in its target set are closer to the append case than to the patch case.

### `search_and_replace` already has a precondition, structurally

Its arguments are `pattern` and `replacement`. **The pattern *is* a statement of what the agent
expects to find**, checked against current content at apply time. If the expected state is gone,
nothing is replaced. It needs no new mechanism because it already carries one.

`patch_vault_file` takes `path`, `operation`, `targetType`, `target`, `content`. **`target` is a
location — a heading name, a block id, a frontmatter key — never a state.** The tool knows where to
write and has no idea what it expected to find there.

That asymmetry is the whole finding. It also kills the "cheapest option" a design brainstorm had
recommended before this ADR: *"have the replace re-verify that the target region still matches what
the agent described"*. It cannot. The agent never described it. **Any guard on this operation
requires a new argument**, so #445 was right that a wire change is unavoidable — it was wrong about
which tools need it and about it being optional.

### What the ecosystem does (#465)

Two implementations, surveyed 2026-08-17:

- **[`hashfile-mcp`](https://github.com/mrorigo/hashfile-mcp)** — a `file_hash` parameter on the
  write; the read returns the token in a **text footer** after the content; hashes at **two
  levels**, a whole-file digest plus a per-line one, with fuzzy matching for lines that moved;
  refuses on mismatch.
- **[`stale-write-guard-fs`](https://agent-coherence.dev/mcp/)** — `swg_read` is a **tracked read**
  that registers the agent's view **server-side**; staleness produces a typed `stale_view` deny
  carrying **`recover: reacquire`**; the guard is **mandatory** ("a deny is recoverable, not
  skippable"); and it explicitly catches edits made outside the tool surface — "a human, a
  formatter" — which is the case this ADR treats as dominant.

Three negatives matter as much:

- **The specification has not addressed this.** No SEP and no issue in
  `modelcontextprotocol/modelcontextprotocol` about write preconditions at the tool level; the ETag
  hits there are HTTP-transport work. The installed SDK v2.0.0 defines no precondition mechanism —
  searched for `etag`, `if-match`, `precondition`, `optimistic`, and both hits were false positives
  (`eTag` inside `constantTimeTagEqual`, `optimistic` describing a stdio probe). **Any answer here
  is application-level by necessity, and no convention exists that clients already expect.**
- **Nobody merges.** Both refuse.
- **Nobody carries the token in `_meta`.**

### Why a hash needs read-side work and text does not

A hash is only useful if the agent can produce the one the server will compute. A model cannot
digest bytes in its head, so the server must emit the token — which is the read-side problem #445
calls "the actual work": `get_vault_file`'s default path returns a bare text block with nowhere
structured to carry it, declaring an `outputSchema` is forbidden for a polymorphic tool (it broke
`get_vault_file` across 0.27.2–0.27.6), and both paths truncate, so the token would have to cover
the full file rather than the response.

The agent already holds something it can send back without any of that: **the text it read**.

## Decision

**1. The precondition is expected content, not a hash, and it goes on
`patch_vault_file` alone.**

`patch_vault_file` gains an optional `expectedContent` argument, meaningful when
`operation: "replace"`. It states the text the agent believes currently occupies the target. Inside
the existing `vault.process` callback — where the current content is already in hand — the resolved
target region is compared against it, and a mismatch aborts the write.

This buys the outcome with **no read-side change, no token emission, no server-held state and no
tension with ADR-0016's stateless transport**. It also makes `patch_vault_file` consistent with
`search_and_replace`, which has always worked this way, rather than inventing a second idiom for the
same idea.

**2. Comparison is whitespace-normalised, and that is a correctness decision, not a convenience.**

Trailing whitespace per line and line-ending style are normalised on both sides before comparing.
A guard that fires because the model reproduced `\r\n` as `\n` protects nothing and trains its
caller to stop passing the argument. `hashfile-mcp` reaching for fuzzy matching over moved lines is
the same pressure met at a different layer.

**3. It is optional in the release that introduces it, and required in the next major, with the
trigger written down now.**

Optional-forever is not protection: nothing makes a model pass an optional field, and both surveyed
implementations made their guard mandatory on purpose. Required-immediately breaks every configured
client and every distributed `.mcpb` the moment they call `patch replace`, which is precisely the
cost #445's constraint 1 exists to avoid and which this project has already paid once with
`outputSchema`.

So: accepted always; **a `mcpTools.requireWritePreconditions` setting, default off**, makes it
required for `operation: "replace"`; and the default flips in the next major release. This is the
same shape as ADR-0016 §8 — a future decision with a stated trigger rather than an intention.

**4. The refusal names the recovery step and the likely cause.**

Following `stale-write-guard-fs`'s `recover: reacquire`, the error is recoverable and instructive
rather than a bare failure: it says the target changed since the agent read it, that re-reading the
file and re-deciding is the recovery, and that **the most likely cause is the user editing the note
or Obsidian Sync landing a change** — not a bug. #445 already flagged that an unexplained refusal
reads as a defect, and this is the common case, not the rare one.

**5. Nothing is added to `search_and_replace`, `rename_heading`, or the append tools.**

Their failure modes are different and smaller, and a guard there would manufacture conflicts where
no authored text is at risk — constraint 2's own reasoning, applied consistently.

## Alternatives considered

### A. `expectedHash` on the three tools, optional, as #445 proposed

Rejected on all three counts, each for a measured reason: the target set is two tools too wide
(only `patch replace` destroys authored text), optional is not protection (and no surveyed
implementation chose it), and a hash forces the read-side token problem that expected content
dissolves. The issue was right that a wire change is unavoidable.

### B. Three-way merge against a server-held base

The most attractive alternative and the one a brainstorm ranked first, because it handles the
dominant case — the human typing **elsewhere** in the file — without a conflict at all. Rejected
for two reasons that compound.

Markdown is not code: a clean line-level merge can leave a list, a table or a frontmatter block
structurally broken while no single line conflicted, and it does so **silently**, which is worse
than a refusal because it violates the stated outcome invisibly. And the survey found **nobody who
ships a merge here** — both implementations refuse — so there is no shipped experience to borrow.

It also needs a base cached between two independent requests, which is state in a transport that
chose not to have any (ADR-0016). `stale-write-guard-fs` shows that cost is payable, so this is a
judgement about risk rather than about feasibility. Not foreclosed: a structural merge that refuses
whenever it cannot prove disjointness remains a future option on top of this decision.

### C. A tracked read holding the agent's view server-side

`stale-write-guard-fs`'s design, and the cleanest ergonomically — the client passes nothing. It
needs per-agent server state keyed to something that identifies an agent across calls. This
transport is stateless and POST-only by decision, and the only client identity it carries is the
bearer token, which identifies a **client**, not a conversation or an agent. Two agents behind one
token would share a view. Rejected as a poor fit for this server's identity model, not as a bad
design.

### D. Optimistic apply with an undo journal

Never refuse; record the inverse of every MCP-origin write so anything overwritten is recoverable.
Protects even clients that pass nothing, which is its real appeal. Rejected as an answer to this
question: it changes the promise from "not destroyed" to "recoverable", and a journal nobody can
read is not recovery — it needs a UI, which is a second feature. Obsidian's own file recovery
already covers part of it. Worth revisiting on its own merits, not as a substitute for a
precondition.

### E. Re-verify the target region with no new argument

The brainstorm's cheapest option, and it is **not implementable**. `patch_vault_file`'s `target` is
a location, not a state; the agent never told the server what it expected to find. Recorded because
it looks obviously right until the tool's schema is read.

### F. `stat.mtime` as the token

#445 rejects it and is right: coarse granularity, Obsidian Sync touches it, and a no-op rewrite
bumps it. Kept here so the reasoning is not re-derived.

### G. A per-section token emitted by `get_vault_file`

The natural pairing with a section-scoped guard, and what `hashfile-mcp`'s per-line hashes amount
to. Rejected for this decision because it requires the read-side machinery described above —
`_meta` plumbing on both read paths, whole-file coverage under truncation, and
`get_vault_file_partial` too — to buy something expected content already provides. If exact-text
comparison proves too fragile in practice, this is the escape hatch, and `_meta` is where the token
would ride (ADR-0018's precedent, success branch only, `content` byte-identical).

## Consequences

**Positive.** The one place authored text is destroyed gains a guard. No read-side change, so
`get_vault_file` keeps its shape and its deliberate absence of an `outputSchema`. No server state,
so ADR-0016 is untouched. Nothing changes for any existing client until it opts in, and a client
that passes the argument is protected immediately. The refusal is instructive in the case that will
fire most often.

**Negative.** Protection is opt-in until the next major, which means it protects the careful and not
the default — an honest cost, named rather than argued away. Exact-text comparison is more fragile
than a digest and will produce spurious refusals if normalisation proves insufficient; alternative G
is the stated escape. Sending the expected text back costs payload on large sections. And the guard
covers `patch_vault_file` only: `search_and_replace` keeps its structural precondition, and the
other tools keep none.

**Unresolved, deliberately.** Whether the eventual default is "required" or "required unless the
setting says otherwise" is a decision for the major that makes the flip, informed by how often the
guard fires in practice. Nothing here measures the real read-to-write window; if it turns out to be
seconds, as a pre-mortem suspected, this machinery guards a case that rarely occurs, and that would
be worth knowing before the default flips.

**Not scheduled.** This ADR decides the shape so that #445 is a spec anyone can build against —
@Madulone offered to prototype it, and this is what a prototype should implement. It does not commit
the work to a release.

## References

- #445 (the issue this decides, and whose body this ADR contradicts in three places), #351 (the
  single-call half), discussion #352 (the report)
- #465 (the prior-art survey), [`hashfile-mcp`](https://github.com/mrorigo/hashfile-mcp),
  [`stale-write-guard-fs`](https://agent-coherence.dev/mcp/)
- ADR-0016 (stateless transport, and the trigger-with-a-decision pattern used above),
  ADR-0018 (`_meta` as a payload seam, if alternative G is ever taken)
- `services/patchHelpers.ts`, `tools/searchAndReplace.ts`, `tools/renameHeading.ts`,
  `services/vaultWriteLock.ts`


## Amendment (2026-08-17): implemented, and it covers `patch_active_file` too

The shape above was decided while the work was unscheduled. It was scheduled the same day and built,
and implementing it surfaced one thing the decision had not settled.

**`patch_active_file` is not a separate tool underneath.** Its context type *is* `PatchArgs`
(`tools/patchActiveFile.ts:29-32`) and it forwards the whole args object into the same `applyPatch`
(`:51`), because the two tools once carried duplicated ~200-line copies that diverged (fork #137) and
the duplicate was retired. So adding `expectedContent` to `PatchArgs` and enforcing it inside
`computePatchedContent` reaches `patch_active_file` **whether or not anyone decides it should**.

Leaving its schema alone would have produced the worst combination: a client sending
`expectedContent` to `patch_active_file` has it validated away by arktype, while a vault with
`requireWritePreconditions` on refuses the call for an argument that tool never advertised.

**Decision: `patch_active_file` declares it too**, and this is not a concession to the
implementation. It follows from the ADR's own reasoning more strongly than the original scope did:
the active file is the one the user is looking at, so it is the single most likely place for an
agent's replace to land on top of something a human just typed. Scoping the guard to the file the
user is *not* looking at would have been the odd choice.

**What shipped**, beyond the decision above:

- `expectedContent` on both schemas; `PatchArgs` carries it; ignored on `append`/`prepend`.
- The comparison runs inside the existing `vault.process` callback for heading and block targets, and
  inside `processFrontMatter` for frontmatter ones, against the region as resolved at that moment.
- `checkReplacePrecondition` and `normalizeForPreconditionCompare` are pure and exported, so the
  policy is tested without an App, a vault or a file.
- Normalisation settled concretely: line endings, then per-line trailing whitespace, then leading and
  trailing blank lines. **Interior blank lines and leading indentation stay significant** — a dropped
  paragraph break and a changed list indent are real edits, and a guard that forgave them would
  forgive the thing it exists to catch. There is a test pinning exactly that.
- The refusal is `errorJson` with `errorCode: "stale_precondition"`, carrying `targetType` and
  `target`, matching the house style set by `searchVaultSmart`'s `index_building`.
- `requireWritePreconditions` lives in the existing `mcpTools` slice with a checkbox in its settings
  section. That section's save was migrated from a hand-rolled load/spread/save to
  `SettingsStore.updateSlice` at the same time — a hand-rolled spread is exactly where one field
  quietly clobbers the other once a slice has two.
- An absent `expectedContent` and an empty one are **different**: absent means unguarded, `""` is a
  legitimate expectation that an empty section is there. Pinned by test.

**Mutation-checked, both directions.** Making `checkReplacePrecondition` always return `null` turns 7
tests red; making `normalizeForPreconditionCompare` a no-op turns 6 red. Suite 1863 → 1882.

**Still true, and still the honest cost:** the guard is opt-in, so by default it protects the careful
and not the everyone. Nothing here measures the real read-to-write window either. Both were named as
open in the original decision and neither is closed by having built it.
