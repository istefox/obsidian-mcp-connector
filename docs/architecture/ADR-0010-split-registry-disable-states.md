# ADR-0010: Split registry disable states (adaptive vs user)

**Status:** Proposed
**Date:** 2026-07-14
**Deciders:** Stefano Ferri

---

## Context

`ToolRegistryClass` (`packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts`)
keeps a single `private enabled = new Set<TSchema>()`. Membership in that one
set is the only signal `list()`, `listAll()`, and `dispatch()` consult to
decide whether a tool is visible/callable.

Two independent features flip membership in that same set today, for two
different reasons:

- `features/adaptive-tool-loading/applyAdaptiveFilter.ts` calls
  `registry.disableByName(name)` for every tool the current profile
  (`core`/`adaptive`) does not activate. This is a *soft*, session-scoped
  state: `activate_tool`/`activate_tools` are designed to reverse it.
- `features/tool-toggle/services/applyFilter.ts` calls
  `registry.disableByName(name)` for every tool in the user's
  `toolToggle.disabled` list read from `data.json`. This is a *hard*,
  user-authored state: `composeToolRegistry.ts:100-106` documents the
  invariant "the disable list wins" and explains this filter runs after the
  adaptive one specifically so the user's choice is not overridden — but
  that ordering only protects the *compose-time* result. At runtime, both
  reasons collapse into the exact same `enabled` set membership.

`activate_tool`/`activate_tools` (`features/mcp-tools/tools/activateTool.ts`,
`activateTools.ts`) call `enableInRegistry`, wired in
`composeToolRegistry.ts:79,95` to `toolRegistry.enableByName(name)`. Because
the registry cannot distinguish *why* a tool is currently disabled, this call
silently re-enables a tool the user explicitly turned off in the tool-toggle
settings, exactly as if it had only been adaptive-filtered out. This breaks
the "disable list wins" invariant at the one place — an MCP client's
`activate_tools` call — where it actually matters, and is audit finding 3
from the 2026-07-14 parallel-tool-call audit (issue #353).

Phase 2 of the same audit (issue #354, "self-healing inactive tool error")
needs to answer a different question at `dispatch()` time — "is this tool
adaptive-inactive (recoverable by calling `activate_tools`) or user-disabled
(no recovery path)?" — which is impossible to answer without first splitting
the state this ADR addresses. Phase 2 is explicitly out of scope here (SPEC.md
"Out"); this ADR only introduces the state model Phase 2 will read.

Assumption made explicit (no ARCH.md exists for this package): the registry
is the single choke point for visibility (`list`, `listAll`, `dispatch`), so
splitting state there — rather than in each filter — is the only place that
guarantees `list()`/`dispatch()` never disagree, which is an invariant the
existing code base already relies on (see the comment at
`toolRegistry.ts:362-364`).

---

## Decision

**Replace the single `enabled: Set<TSchema>` with two independent
`Set<TSchema>` fields**, `adaptiveDisabled` and `userDisabled`. A tool is
served by `list()`/`listAll()`/`dispatch()` iff it is in **neither** set. A
newly `register()`-ed tool starts in neither set (enabled by default), so
`register()` no longer needs an explicit "add to enabled" step — the default
state is achieved by omission, which is the same simplification `listAll()`
already uses today for its registration-order source (`this.handlers.keys()`).

```ts
private adaptiveDisabled = new Set<TSchema>();
private userDisabled = new Set<TSchema>();

private isServed = (schema: TSchema): boolean =>
  !this.adaptiveDisabled.has(schema) && !this.userDisabled.has(schema);
```

**Keep `enable`/`disable` (schema-based) and `enableByName`/`disableByName`
(name-based) with their existing signatures**, per SPEC. They become
documented aliases for the **adaptive** concern only:

```ts
enable = (schema: TSchema) => { this.setFlag(this.adaptiveDisabled, schema, false); return this; };
disable = (schema: TSchema) => { this.setFlag(this.adaptiveDisabled, schema, true); return this; };
enableByName = (name: string): boolean => /* resolves schema, delegates to enable() */;
disableByName = (name: string): boolean => /* resolves schema, delegates to disable() */;
```

This is not an arbitrary choice: `enableInRegistry` in `composeToolRegistry.ts`
(lines 79 and 95) is already wired to `toolRegistry.enableByName(name)` for
`activate_tool`/`activate_tools`, and SPEC requires that callback to "clear
only the adaptive flag." Defining `enableByName` this way satisfies that
requirement with **zero changes to `composeToolRegistry.ts`**.

**Add two new concern-specific methods**, the canonical API going forward:

```ts
setAdaptiveDisabled = (name: string, disabled: boolean): boolean => /* ... */;
setUserDisabled = (name: string, disabled: boolean): boolean => /* ... */;
```

`applyAdaptiveFilter.ts` migrates its `disableByName` call to
`setAdaptiveDisabled(name, true)`; `applyFilter.ts` (tool-toggle) migrates
its `disableByName` call to `setUserDisabled(name, true)`. Both filters'
local `RegistryLike` structural types are updated to require the new method
instead of `disableByName`, so a future caller cannot accidentally wire the
wrong concern through the wrong filter — a TypeScript compile error, not a
runtime surprise.

**`listCache` invalidation** fires from a shared private `setFlag` helper
used by every mutator (`enable`/`disable`/`setAdaptiveDisabled`/
`setUserDisabled`), so both new setters invalidate the memoized `list()`
result exactly like the existing ones do.

**`list()`/`listAll()` iterate registration order** (`this.handlers.keys()`)
filtered by `isServed()`, matching `listAll()`'s existing iteration source.
This is a deliberate, small behavior change from today's `list()`, which
iterates the `enabled` Set's insertion order (so re-enabling a tool moves it
to the end of `tools/list`) — see Consequences and the rejected alternative
below.

**`listAll()` gains a `userDisabled` field**, additive to its existing
`{ name, description, enabled }` shape:

```ts
listAll = (): { name: string; description: string; enabled: boolean; userDisabled: boolean }[] =>
  Array.from(this.handlers.keys()).map((schema) => ({
    name: this.toolNameOf(schema),
    description: schema.description ?? "",
    enabled: this.isServed(schema),
    userDisabled: this.userDisabled.has(schema),
  }));
```

The shared `RegistryLike` type in `features/adaptive-tool-loading/types.ts`
(imported by `activateTool.ts`, `activateTools.ts`, `toolCatalog.ts`) widens
to match. This is additive for every existing consumer that only reads
`{name, description, enabled}`.

**`activate_tool`/`activate_tools` gain a user-disabled check, evaluated
before the "already active" / "activate" branch** (order matters: a tool
that is *both* adaptive-inactive and user-disabled must resolve to
"not allowed," not "activated"):

- not registered → unknown-tool error (unchanged).
- `userDisabled === true` → **new**: `activate_tool` returns
  `errorText("Tool '<name>' was disabled by the user and cannot be
  activated via MCP. ...")` (isError: true, no side effects); `activate_tools`
  records outcome `"not_allowed"` for that name, does not call
  `enableInRegistry`, does not add it to the persisted batch, does not count
  it toward "activated" (so a batch consisting only of not-allowed names
  fires no `tools/list_changed`, same as today's "no-op batch" behavior).
- `enabled === true` (neither flag set) → "already active" (unchanged).
- otherwise (adaptive-disabled only) → activate as today.

`activate_tools`' `Outcome` union widens: `"activated" | "already_active" |
"not_found" | "not_allowed"`.

**`tool_catalog` omits `userDisabled` entries entirely** rather than listing
them with a distinct status. See Alternatives for the rejected middle
ground (list them, labeled).

---

## Alternatives considered

### Alternative A: per-tool state record (`Map<TSchema, {adaptiveDisabled: boolean; userDisabled: boolean}>`) instead of two `Set`s

A single map from schema to a small struct would also model two independent
booleans per tool.

**Rejected.** Two `Set`s are a strict, minimal generalization of the
existing single-`Set` design (the diff is "add a second Set and gate on
both" rather than "replace a Set with a Map of structs"). Every call site
that matters is a membership check (`has`/`add`/`delete`), which Sets do
natively; a Map-of-structs would need every registered tool to have a
default-initialized entry (or optional-chaining everywhere to handle a
missing one), which is more code and a bigger surface for a missed-default
bug than "absence from a Set already means false."

### Alternative B: preserve the legacy `list()` reshuffle-on-re-enable ordering via a third derived `Set`

`list()` currently iterates the `enabled` Set's insertion order, so
re-enabling a previously-disabled tool moves it to the end of `tools/list`
(asserted by an existing test in `toolRegistry.test.ts`). A third Set,
maintained alongside `adaptiveDisabled`/`userDisabled` and updated to
add-at-end on every transition into "served," would preserve this exact
ordering.

**Rejected.** No product requirement, SPEC objective, success criterion, or
README claim depends on this reshuffle; it is an incidental artifact of the
single-`Set` implementation the SPEC now asks to replace, not a documented
MCP-visible contract. Keeping it would mean synchronizing **three**
collections instead of two for a behavior nobody asked for and that is, if
anything, a minor UX regression for MCP clients that cache tool order.
`list()`/`listAll()` iterating registration order (already `listAll()`'s
behavior today) is simpler and strictly more predictable. The one existing
test asserting the old order is updated with an explicit comment explaining
the change (see Implementation plan, Task 1) — this is a corrected
assertion of an implementation detail, not a weakened behavioral guarantee;
the invariant the test suite must keep enforcing ("a disabled tool is hidden
from `list()`") is unaffected and stays fully asserted.

### Alternative C: `tool_catalog` lists user-disabled tools with a distinct status label instead of omitting them

Add a fourth `ToolEntry.status` value (e.g. `"disabled"`) so the catalog
stays a complete inventory of every registered tool, and the model can see
*why* a tool is unavailable.

**Rejected.** SPEC's scope line is explicit: a user-disabled tool "must not
be offered as activatable." Listing it (even labeled) still lets the model
attempt `activate_tool`/`activate_tools` on it, paying a wasted round trip
for a `not_allowed` response it could have avoided by never seeing the name.
Full omission is also strictly cheaper on tokens, consistent with this
file's existing token-minimization bias (`firstSentence()` truncates
inactive-tool descriptions to their first sentence specifically because
"the remaining prose is pure token cost in the catalog listing").

### Alternative D: single generic `disableByName(name, concern)` instead of two new named methods

Keep exactly one name-based mutator and add a `"adaptive" | "user"`
parameter, instead of introducing `setAdaptiveDisabled`/`setUserDisabled`.

**Rejected.** SPEC explicitly requires `disableByName`/`enableByName` to
"keep... signatures working" (i.e., unchanged `(name: string) => boolean`),
which forecloses adding a required parameter to them. Two dedicated verbs
are also more legible at call sites (`applyFilter.ts` calling
`setUserDisabled` reads as self-documenting) than a stringly-typed concern
argument, and give the TypeScript compiler no way to typo the concern string
— a real risk here, since a swapped concern string would silently
reintroduce the exact bug (#353) this ADR fixes.

---

## Consequences

**Positive:**
- Restores the "disable list wins" invariant at runtime, not just at
  compose time: `activate_tool`/`activate_tools` can never re-enable a
  user-disabled tool, closing audit finding 3 (#353).
- **Zero changes required to `composeToolRegistry.ts`.** The existing
  `enableInRegistry: (name) => toolRegistry.enableByName(name)` wiring at
  lines 79 and 95 already satisfies "clear only the adaptive flag" once
  `enableByName` is redefined as an adaptive-only alias — no risk of a
  forgotten call-site update in the composition root.
- `listAll()`'s widened shape (`+ userDisabled`) is strictly additive:
  every existing consumer destructuring `{name, description, enabled}`
  keeps compiling and behaving identically without any change on their
  part (`AdaptiveToolLoadingSettings.svelte` only reads `.name`, for
  example).
- `tool_catalog` becomes more useful: it never proposes a tool the user has
  explicitly blocked, saving the model a wasted `activate_tool` round trip.
- Sets up Phase 2 (#354) cleanly: the dispatch()-time distinction between
  "adaptive-inactive" (recoverable via `activate_tools`) and "user-disabled"
  (no recovery path) is now directly available as
  `this.adaptiveDisabled.has(schema)` / `this.userDisabled.has(schema)`
  with no further registry surgery required.

**Negative:**
- `tools/list` ordering changes from "Set-reinsertion order" (a
  disable/re-enable cycle moves a tool to the end) to strict registration
  order. One existing test in `toolRegistry.test.ts` asserts the old order
  and is updated explicitly (Task 1), not silently dropped — flagged here
  per the observable-contract staleness rule, and the only call site found
  by grep that depends on this ordering.
- `ToolRegistryClass`'s public surface grows by two Sets and two methods.
  Three names now exist for flipping the adaptive flag by different means
  (`enable`/`disable` schema-based, `enableByName`/`disableByName`
  name-based convenience aliases, `setAdaptiveDisabled` canonical) — a
  future reader has to learn these are synonyms for the same concern. This
  is accepted because SPEC explicitly requires the old signatures to keep
  working; the alternative (Alternative D) was rejected for stronger
  reasons.
- This is a coordinated, multi-file change: `toolRegistry.ts`,
  `applyAdaptiveFilter.ts`, `applyFilter.ts`, `activateTool.ts`,
  `activateTools.ts`, `toolCatalog.ts`, and five test files all move
  together. A partial rollout (e.g., the registry split lands without
  migrating both filters to the concern-specific setters) would leave both
  filters still calling the adaptive-only `disableByName` alias, silently
  reintroducing the exact bug (#353) this ADR exists to fix — this is the
  primary reason Task 7 mandates a full-suite regression run rather than
  per-file spot checks.

**Neutral:**
- `data.json` schema is untouched (SPEC explicitly out of scope): the split
  is purely derived, in-memory registry state built from the existing
  `toolLoading` and `toolToggle` slices.
- The `dispatch()` error message stays the generic `Unknown tool: <name>`
  for both adaptive-inactive and user-disabled tools in this phase — SPEC
  explicitly excludes changing it (that is Phase 2, #354, which depends on
  this ADR's state model).
- `ToolLoadingManager.resetAll()` (`toolLoadingManager.ts`) is unaffected:
  it only ever touches `counters`/`promoted` in `data.json`, never the
  registry's live flags, so it already satisfies the SPEC edge case "must
  not touch user-disabled state" with no code change required.
- `ToolToggleSettings.svelte` does not call the registry at all today (it
  writes `toolToggle.disabled` straight to `data.json`; the settings
  description text already states changes "apply on the next plugin
  reload"). SPEC explicitly says not to add new live-sync behavior beyond
  what the renamed registry API forces, so this file is unmodified.

---

## Files to create or modify

| File | Change |
|---|---|
| `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts` | Replace `enabled: Set` with `adaptiveDisabled`/`userDisabled` Sets; add `isServed`/`setFlag` private helpers; add `setAdaptiveDisabled`/`setUserDisabled`; redefine `enable`/`disable`/`enableByName`/`disableByName` as adaptive-only aliases; widen `listAll()` return shape; `list()`/`listAll()` iterate `handlers.keys()`. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.test.ts` | New `describe` block for flag independence and `not_allowed`-adjacent registry behavior; update the one ordering assertion in the memoization block with an explanatory comment. |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/types.ts` | Widen shared `RegistryLike.listAll()` entry with `userDisabled: boolean`. |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/applyAdaptiveFilter.ts` | Local `RegistryLike` type + implementation: `disableByName` → `setAdaptiveDisabled(name, true)`. |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/applyAdaptiveFilter.test.ts` | Fake registry helper: `disableByName` → `setAdaptiveDisabled`. |
| `packages/obsidian-plugin/src/features/tool-toggle/services/applyFilter.ts` | Local `RegistryLike` type + implementation: `disableByName` → `setUserDisabled(name, true)`. |
| `packages/obsidian-plugin/src/features/tool-toggle/services/applyFilter.test.ts` | Fake registry helper: `disableByName` → `setUserDisabled`. |
| `packages/obsidian-plugin/src/features/mcp-tools/tools/activateTool.ts` | Add `userDisabled` check before the "already active" branch; return `errorText` explaining the user block. |
| `packages/obsidian-plugin/src/features/mcp-tools/tools/activateTool.test.ts` | Update `makeRegistry` helper (`userDisabled` field); add user-disabled test cases. |
| `packages/obsidian-plugin/src/features/mcp-tools/tools/activateTools.ts` | Widen `Outcome` with `"not_allowed"`; add `userDisabled` branch before "already active." |
| `packages/obsidian-plugin/src/features/mcp-tools/tools/activateTools.test.ts` | Update `makeRegistry` helper; add mixed-batch test incl. `not_allowed`. |
| `packages/obsidian-plugin/src/features/mcp-tools/tools/toolCatalog.ts` | Filter out `userDisabled` entries before mapping to `ToolEntry[]`. |
| `packages/obsidian-plugin/src/features/mcp-tools/tools/toolCatalog.test.ts` | **New file** — no prior test coverage existed for this handler. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts` | Comment-only: the line-95 comment mentions `disableByName support`; update wording to reflect the split (non-behavioral). |

---

## References

- SPEC.md at repo root (`Split registry disable states`, 2026-07-14)
- PROJECT.md at repo root, Phase 1 / "Split registry disable states" feature note
- GitHub issue #353 (2026-07-14 parallel-tool-call audit, finding 3)
- `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts` (current single-`enabled`-Set implementation)
- `packages/obsidian-plugin/src/composeToolRegistry.ts:79,95,100-106` ("disable list wins" invariant, `enableInRegistry` wiring)
- ADR-0006: mcp-transport / composition-root policy precedent (transport stays policy-free; feature wiring lives in `composeToolRegistry.ts`) — the same boundary this ADR preserves by requiring zero changes there.
