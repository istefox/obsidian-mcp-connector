# ADR-0022: Write preconditions for `create_vault_file` and `create_vault_binary_file`

**Status:** Accepted and implemented
**Date:** 2026-08-26
**Deciders:** Stefano Ferri
**Issue:** [#517](https://github.com/istefox/obsidian-mcp-connector/issues/517), reported by @aardvarkpaul
**Extends:** ADR-0019 (write preconditions across separate MCP calls)

---

## Context

ADR-0019 built `expectedContent` for `patch_vault_file`, `patch_active_file`, and identified
`search_and_replace`'s own pattern-as-precondition — every tool that can destroy authored text
through a targeted edit. `create_vault_file` appears nowhere in that document. That is a genuine gap
in ADR-0019's own coverage, not a deliberate exclusion: the ADR's decision table (§"Only one
operation destroys authored text") reasons about `patch_vault_file`'s `replace` operation
specifically and never considers the plain create/overwrite tools, because at the time they were not
the operation an agent would reach for to edit an existing file.

Issue #517 is exactly that gap surfacing in practice. @aardvarkpaul reports `create_vault_file`
overwriting an existing path with no way to state what the caller expected to find there, returning
`OK` either way. The reporter nearly lost content twice in a fortnight: both times an agent meant to
add a backlink and a date to an existing note, sent that addition as the *entire* payload (mistaking
`create_vault_file`'s full-overwrite contract for an append), and got `OK` back — an 18KB note became
a four-line stub, recovered only via version control. `createVaultFile.ts`'s overwrite branch was a
bare `vault.modify(existing, content)`: no comparison against anything, and `withVaultWriteLock`
guarded only the exists-check → create TOCTOU, never content staleness.

Auditing `create_vault_binary_file` for the same gap surfaced a second, independent bug: it was not
wrapped in `withVaultWriteLock` at all. Every other vault-writing tool acquires it; this one never
did. Two concurrent calls to the same new path could both pass the exists-check before either wrote,
so the second `createBinary`/`modifyBinary` could race the first. In scope here by explicit decision,
alongside the precondition work, rather than deferred as a separate fix — fixing one gap on this tool
and leaving a second known one would be an odd order of operations.

## Decision

**1. `create_vault_file` gains `expectedContent?: string`, same semantics and normalisation as the
patch tools.** Not an `overwrite` boolean: the reported failure is the agent holding stale or partial
content for a write it intended to make, which is a content problem, not a yes/no gate. The comparison
uses the existing `normalizeForPreconditionCompare` (`patchHelpers.ts`) unchanged — whitespace and
line-ending normalisation is a correctness decision already made in ADR-0019, not a convenience this
ADR needs to re-derive.

Semantics, folded into one function (`checkCreatePrecondition`, `services/createPrecondition.ts`):

| Path exists | `expectedContent` | Toggle | Outcome |
|---|---|---|---|
| no | absent | either | create (unchanged) |
| no | `""` | either | create — empty is what a non-existent file holds |
| no | non-empty | either | refuse `stale_precondition` |
| yes | absent | off | overwrite (unchanged) |
| yes | absent | **on** | refuse — precondition required |
| yes | matches | either | overwrite |
| yes | mismatch | either | refuse `stale_precondition` |

The toggle bites ONLY the overwrite branch. Creating a brand-new file must never be blocked by a
vault-wide setting whose entire purpose is guarding against overwriting something that already
exists — that would turn every first-time note creation into a refusal.

**2. `create_vault_binary_file` gains `overwrite?: boolean`, not `expectedContent`.** Binary content
has no meaningful whole-file diff to show a caller — there is nothing for the tool description to ask
for that a model could usefully compare against what it remembers. The risk profile is also different:
for text, the danger is stale/partial *content*; for binary, the danger is a *wrong path* (uploading
to the wrong image slot, regenerating an asset that already exists under manual curation). A boolean
confirmation answers that risk; a byte comparison would not add protection proportionate to its cost
(the caller would have to hold and resend the full prior bytes).

| Path exists | `overwrite` | Toggle | Outcome |
|---|---|---|---|
| no | any | either | create (unchanged) |
| yes | absent | off | overwrite (unchanged) |
| yes | absent | **on** | refuse |
| yes | `true` | either | overwrite |
| yes | `false` | either | refuse |

Both refusals — text and binary — use `errorJson(text, "stale_precondition", { path })`, the same
snake_case machine-readable code ADR-0019 put on the wire for the patch tools. Every pre-existing
error in both tools keeps its plain-text `errorText` shape; only the new precondition path is
structured.

**3. The vault-wide `requireWritePreconditions` toggle extends to these two tools.** It already
governs `patch_vault_file`'s `replace` operation (ADR-0019). This is a deliberate behaviour change
for any vault that already turned it on: from this release, that vault also refuses an unconfirmed
overwrite through `create_vault_file` or `create_vault_binary_file`, not just through `patch replace`.
The alternative — a second, tool-scoped toggle — would let a user believe they had closed the gap
#517 reports by enabling "the" write-precondition setting, while `create_vault_file` stayed
unguarded. One setting whose name makes no tool-specific promise is the honest shape; the CHANGELOG
entry calls the behaviour change out explicitly for anyone who already opted in.

**4. `idempotentHint: true` stays unchanged on both tools' MCP annotations.** The hint is a client-side
UX signal (confirmation gating, badges), not a correctness contract, and it remains true for the
default path: a repeated call with no `expectedContent`/`overwrite` and the toggle off behaves exactly
as before, an unconditional overwrite that can be repeated safely. The annotation stops being exactly
accurate only once a caller opts into a precondition (or the toggle is on) — a second call with the
same now-stale expectation refuses rather than repeating the effect. `toolAnnotations.ts`'s comments
on both entries now say so; the annotation itself is unchanged because the spec has no vocabulary for
"idempotent only in the default configuration", and downgrading the hint outright would misdescribe
the common case to protect the uncommon one.

**5. Compare-then-write for the text tool runs inside `vault.process`, never a separate `read` then
`modify`.** `vaultWriteLock.ts`'s own header calls a bare read-then-write out as the lost-update bug
class the mutex only partly closes — it excludes other MCP requests but not the editor or Obsidian
Sync. The established pattern in this codebase (`appendToVaultFile.ts`, `patchHelpers.ts`'s
heading/block branch) is the synchronous `vault.process` callback: the compare and the write happen
against the exact same read, atomically, with no window for a concurrent writer to land a change
between them. `create_vault_file`'s overwrite branch now follows that pattern instead of the old bare
`vault.modify`. `create_vault_binary_file` has no content to compare (see decision 2), so its guard
is a plain existence + flag check inside the write lock rather than a `vault.process`-equivalent —
there is no read-modify-write to make atomic when the "modify" is a full-byte replacement gated by a
boolean already known before the read.

The `requireWritePreconditions` toggle is resolved by the handler, *before* acquiring the lock: the
read is async and the `vault.process` callback must stay synchronous, the same constraint ADR-0019
already worked around in `patchVaultFile.ts`.

`withVaultWriteLock` is non-re-entrant and is acquired exactly once at the top of each handler's write
path, as everywhere else in this codebase.

## Known limitation

Comparison for `create_vault_file` is over the **whole file**, not a region — there is no region to
speak of, since this tool's contract is a full-content replacement. A concurrent human edit anywhere
in the file, however small and unrelated to what the agent is changing, fails the precondition even
with no semantic conflict. That is intrinsic to a whole-file-replacement contract, not a defect in the
comparison. The tool description steers a caller who means to change only part of a file toward
`patch_vault_file` instead, whose `expectedContent` is scoped to the resolved target region.

## Alternatives considered

**A. An `overwrite: boolean` on `create_vault_file`, matching the binary tool.** Rejected: it answers
"may I overwrite this file" but not "is what I'm about to write correct", which is the actual failure
#517 reports. The agent in both incidents *believed* it was safe to write — the missing signal was
that its belief about the file's current content was wrong, not that it lacked permission to
overwrite. A boolean would have let both incidents through unchanged; `expectedContent` catches
exactly the case that occurred.

**B. `expectedContent` on `create_vault_binary_file` too, base64-compared.** Rejected as
disproportionate: a caller would need to hold and resend the complete prior byte content to prove
what it expects, which is strictly more expensive than just reading with `get_vault_file_partial`-style
tooling would be for text, and buys nothing beyond what `overwrite: true` already buys for a binary
blob with no meaningful partial-edit story. Binary files are not edited in place by an agent the way
text sections are; the realistic failure mode is a wrong target path, which a boolean confirmation
already interrupts.

**C. A single, tool-scoped precondition setting per tool instead of extending
`requireWritePreconditions`.** Rejected in decision 3 above: it multiplies settings for a single
underlying promise ("this vault requires you to state what you expect before overwriting") and
creates exactly the gap #517's own toggle-on user could fall into — believing the vault-wide switch
covered every overwrite path when it covered only one tool.

## Consequences

**Positive.** The failure mode #517 reports — a full-content overwrite silently destroying an
existing note — is closed for any caller that passes `expectedContent`, and closed for every caller
in a vault that turns the existing toggle on. `create_vault_binary_file` also gains the write lock it
should always have had, closing an independent TOCTOU that predates this issue. No read-side change:
`get_vault_file` is untouched, matching ADR-0019's own reasoning for why expected-content beats a
server-emitted hash.

**Negative.** Protection is opt-in by default, same honest cost ADR-0019 already named — it protects
the careful caller, not every caller, until the toggle is turned on or a future major flips its
default. The whole-file comparison (see Known limitation) will produce a refusal on an unrelated
concurrent edit; `patch_vault_file` is the documented escape hatch for a caller that only meant to
change part of a file. Enabling `requireWritePreconditions` in an existing vault now changes behaviour
on two more tools than it did before — a real behaviour change, called out in the CHANGELOG rather
than shipped silently.

**Neutral.** `idempotentHint: true` on both tools becomes accurate only for the default
(no-precondition) configuration; this is documented in code comments rather than reflected in the
annotation itself, since the MCP spec has no narrower vocabulary to express it.

## References

- ADR-0019 (write preconditions across separate MCP calls) — the mechanism this ADR extends;
  `checkReplacePrecondition` and `normalizeForPreconditionCompare` are reused, not re-derived.
- #517 (the issue this decides), reported by @aardvarkpaul.
- `services/createPrecondition.ts` (new — the two pure decision functions), `services/patchHelpers.ts`
  (`normalizeForPreconditionCompare`), `services/vaultWriteLock.ts` (the lost-update bug class and the
  non-re-entrant mutex), `services/writePreconditionSetting.ts` (`resolveRequireWritePreconditions`),
  `tools/createVaultFile.ts`, `tools/createVaultBinaryFile.ts`.
