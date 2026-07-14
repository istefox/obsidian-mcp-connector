# ADR-0011: Self-healing inactive tool error for adaptive-inactive tools

**Status:** Proposed
**Date:** 2026-07-14
**Deciders:** Stefano Ferri

---

## Context

`ToolRegistryClass.dispatch()`
(`packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts`)
answers a `tools/call` for any tool that is not currently served —
unregistered, adaptive-inactive, or user-disabled — with the same opaque
`Unknown tool: <name>` error (`ErrorCode.InvalidRequest`, wrapped by the
existing catch block into `MCP error -32600: Unknown tool: <name>`). ADR-0010
(issue #353, merged on this branch) split the single `enabled` Set into two
independent flags, `adaptiveDisabled` and `userDisabled`, so `dispatch()` can
now tell these cases apart, but it does not yet act on the distinction.

This is audit finding 1 from the 2026-07-14 parallel-tool-call audit (issue
#354, PROJECT.md Phase 2). The practical failure mode: a client issues
`activate_tools({names:[...]})` and, in the same parallel batch, calls one of
the tools being activated. If the call lands before the activation write is
visible, it gets `Unknown tool: <name>` — indistinguishable from a typo or a
tool that plain does not exist. The model has no structured signal to retry;
it either gives up or hallucinates a diagnosis.

SPEC.md (this feature) requires: a call to a tool that is registered and
adaptive-inactive (and not user-disabled) must return an `isError: true`
result carrying an exact, stable recovery sentence:

```
Tool '<name>' exists but is inactive. Call activate_tools({"names":["<name>"]}) first, then retry this call.
```

Unregistered and user-disabled tools must keep the current opaque
`Unknown tool: <name>` reply, unchanged in shape — the user's disable choice
must stay undiscoverable (SPEC "Edge cases": "the user's choice must not be
discoverable").

**Scope correction against SPEC's "Architecture" section.** SPEC states "the
whole feature lives in `toolRegistry.ts` plus tests." That is true for the
error-message change (Objective 1) but not for Edge case 4: "`recordCall`
counter: outcome (b) must not count as a call of the target tool for
frequency promotion (it did not execute)." `recordCall` is invoked today in
`mcp-transport/services/mcpServer.ts` (`CallToolRequestSchema` handler,
lines ~104-121), **unconditionally** after every `dispatch()` call except for
tools in `META_TOOLS` — it has no knowledge today of whether the dispatched
call actually executed a handler. `toolRegistry.ts` alone cannot make this
edge case observably true; `mcpServer.ts` must also change. This ADR
documents that correction explicitly rather than silently expanding scope.

Two independent decisions follow: (1) how `dispatch()` itself must branch and
what it returns for the recoverable case, and (2) whether calling an
adaptive-inactive tool should also auto-activate it instead of (or in
addition to) returning the guided error — the question SPEC asks this ADR to
settle.

---

## Decision

### 1. `dispatch()` gains a three-way branch, in this exact order

```ts
dispatch = async (params, context) => {
  try {
    const schema = this.byName.get(params.name);
    const handler = schema ? this.handlers.get(schema) : undefined;

    // (a) enabled — dispatch as today.
    if (schema && handler && this.isServed(schema)) {
      const validParams = schema.assert(this.coerceBooleanParams(schema, params));
      return await handler(validParams, context);
    }

    // (b) registered, adaptive-inactive, NOT user-disabled — recoverable.
    // Returned directly (not thrown), so it bypasses the catch block's
    // McpError/formatMcpError wrapping and the diagnostic error log: this
    // is an expected, benign race outcome under normal adaptive-loading
    // usage, not an operator-actionable failure.
    if (schema && this.adaptiveDisabled.has(schema) && !this.userDisabled.has(schema)) {
      return {
        content: [{
          type: "text" as const,
          text: `Tool '${params.name}' exists but is inactive. Call activate_tools({"names":["${params.name}"]}) first, then retry this call.`,
        }],
        isError: true,
      };
    }

    // (c) unregistered OR user-disabled (or both flags set) — unchanged.
    throw new McpError(ErrorCode.InvalidRequest, `Unknown tool: ${params.name}`);
  } catch (error) {
    // ...unchanged catch block (formatMcpError, logger.error, isError envelope)...
  }
};
```

The object literal in branch (b) matches this file's existing local style
(the catch block already hand-builds the same shape) rather than importing
`errorText` from `features/mcp-tools/services/responseBuilders.ts` — that
helper lives in a feature folder `mcp-transport` does not otherwise depend
on, and importing it here would invert the composition-root boundary
ADR-0006/ADR-0010 established ("transport stays policy-free"; feature wiring
belongs in `composeToolRegistry.ts`, not inside the registry).

Branch (b) is checked strictly before the fallback throw, and strictly
requires `!userDisabled`, so a tool with **both** flags set falls through to
branch (c) — satisfying SPEC's edge case "a tool that is adaptive-inactive
AND user-disabled must produce outcome (c), not (b)."

Meta-tools (`ALWAYS_ACTIVE_TOOLS`: `tool_catalog`, `activate_tool`,
`activate_tools`) never reach branch (b): `applyAdaptiveFilter.ts`'s
`getActiveToolNames()` already includes `META_TOOLS` unconditionally in the
active set for every profile (`all`/`core`/`adaptive`), so it never calls
`setAdaptiveDisabled(name, true)` for them — this invariant is enforced by
existing, unmodified code, not new logic in `dispatch()`. `toolRegistry.ts`
stays agnostic of which names are meta-tools (no new import of
`META_TOOLS`), preserving the existing separation where the registry never
special-cases specific tool names.

The race-retry path needs no re-list on the server: `dispatch()` resolves
`schema`/`isServed` fresh from `byName`/`adaptiveDisabled`/`userDisabled` on
every call — there is no cache in the servedness check (`listCache` only
memoizes the `tools/list` JSON payload, never consulted by `dispatch()`), so
a retried call after `activate_tools` clears the flag lands on branch (a)
unconditionally.

### 2. A new public query method, `isAdaptiveInactive(name)`, backs both the SPEC's edge case and `mcpServer.ts`'s recordCall gating

```ts
/**
 * True iff `name` resolves to a registered tool that dispatch() would
 * answer with the recoverable "exists but is inactive" error (branch b)
 * rather than executing it or returning the opaque Unknown-tool error.
 * Exposed so callers outside the registry — specifically mcpServer.ts's
 * call-frequency counter — can make the same outcome distinction without
 * re-deriving it from listAll(), and without dispatch() leaking the
 * distinction onto the wire.
 */
isAdaptiveInactive = (name: string): boolean => {
  const schema = this.byName.get(name);
  return !!schema && this.adaptiveDisabled.has(schema) && !this.userDisabled.has(schema);
};
```

This is a small, single-purpose, O(1) predicate — not a general
`classify()`/enum return, and not implemented by re-deriving the answer from
`listAll()` (which is already public and technically sufficient, since
`listAll()` already exposes `enabled`/`userDisabled` per tool, but would mean
mcpServer.ts allocates and maps over every registered tool on every single
`tools/call` just to answer a one-name question `dispatch()` already answers
internally moments later in the same request). `dispatch()`'s own branch (b)
condition and this method are intentionally the identical boolean
expression, kept side by side rather than factored into one shared private
helper called from both places — the two call sites already have their
matching `schema` in hand for different reasons (dispatch already resolved
it for the handler-lookup branch; this method resolves it fresh for an
external, name-only caller), so factoring would trade one duplicated
three-token boolean expression for an extra indirection layer with no
duplicated *logic* being removed. If this expression grows a third
condition in the future, revisit factoring then.

### 3. `mcpServer.ts`'s `CallToolRequestSchema` handler gates `recordCall` on this predicate

```ts
async (request, extra) => {
  // Read the outcome classification synchronously, in the same tick as
  // dispatch() will read it (dispatch()'s own branch check runs
  // synchronously before its first await) — no interleaving is possible
  // between this check and dispatch()'s internal one.
  const isAdaptiveInactive = registry.isAdaptiveInactive(request.params.name);
  const result = await registry.dispatch(request.params, {
    server,
    sendNotification: extra.sendNotification,
  });
  if (
    !isAdaptiveInactive &&
    !(META_TOOLS as string[]).includes(request.params.name)
  ) {
    toolLoadingManager
      .recordCall(request.params.name, config.plugin)
      .catch((error: unknown) => { /* unchanged warn-log */ });
  }
  return result;
}
```

`dispatch()`'s signature is **not** changed (no new callback parameter) —
every existing call site (all of them in tests, plus the one production
call site) keeps compiling and behaving identically. Outcome (c)'s
`recordCall` behavior is preserved bit-for-bit (still fires for unregistered
and user-disabled names, exactly as today) — this ADR does not extend the
fix to outcome (c) even though the same "it did not execute" reasoning would
arguably apply there too; see Alternatives, Alternative C.

### 4. Auto-activation-on-call: **rejected** for this phase

SPEC explicitly asks this ADR to decide whether calling an adaptive-inactive
tool directly should also flip its adaptive flag and execute it (instead of,
or before, returning the guided error), and states this is evaluated, not
required. **Decision: reject auto-activation-on-call.** The guided-error
behavior above ships as the sole mechanism this phase. Full reasoning in
Alternatives (Alternative A).

---

## Alternatives considered

### Alternative A: auto-activate the tool on the racing call instead of (or in addition to) returning the guided error

`dispatch()` could, on hitting branch (b), call `this.enable(schema)` (or the
equivalent of `enableInRegistry`) and execute the handler in the same
`tools/call`, so the very call that would otherwise need a retry just
succeeds — eliminating the race window SPEC describes for the single most
common trigger (a client that calls a tool directly, without ever having
gone through `activate_tools`, because its harness does not enforce
"call only tools currently in `tools/list`").

**Rejected.**

- It defeats the adaptive-tool-loading feature's entire reason to exist for
  any client whose harness allows calling an unlisted tool name. The
  `core`/`adaptive` profiles exist specifically to keep the model's active
  tool surface small (token cost, prompt-injection surface, cognitive
  load — see `constants.ts`'s own comments on `ALWAYS_ACTIVE_TOOLS` and the
  `tool_catalog` first-sentence-truncation rationale cited in ADR-0010). If
  simply calling a tool by name silently promotes it, `core`/`adaptive`
  degrade to `all` in practice for any such client: the deliberate two-step
  gate (discover via `tool_catalog`, then `activate_tool`/`activate_tools`,
  *then* call) collapses to zero steps the moment a tool's name is guessed
  or recalled from training data or a stale cached `tools/list`.
- Silent, permanent (session-scoped) state mutation on a call that might be
  exploratory, a retry, or a genuine mistake. A model probing "does this
  vault expose a delete-file tool?" by attempting to call it would
  permanently promote it for the rest of the session as a side effect of
  finding out — a surprising, hard-to-reason-about coupling between "did I
  call this" and "is this now always available," with no way for the model
  to discover that coupling from the tool's own description.
- Auto-activation would need to replicate (or call into) `activate_tool`'s
  own decision logic — persist vs. session-only, `not_allowed` handling for
  user-disabled tools, the `tools/list_changed` notification fan-out — or
  `dispatch()` would need to import and invoke `activateToolHandler`
  directly, reaching from `mcp-transport` (the registry / composition
  choke point) into a specific `mcp-tools` feature's policy. This is the
  same layering violation ADR-0010 fixed in the *other* direction (filters
  reaching into the registry's disable state); doing it symmetrically the
  other way here — the registry reaching into one feature's activation
  policy — is exactly what `composeToolRegistry.ts` being "the composition
  root; wiring changes belong there, not inside features" (CLAUDE.md) is
  meant to prevent.
- Notification consistency gap: `activate_tool`/`activate_tools` deliberately
  switch their HTTP response to SSE specifically so `tools/list_changed` can
  ride the *same* response stream the client is already reading
  (`mcpServer.ts`'s own comment: "the GET SSE stream is blocked... a
  server-initiated notification has nowhere to go — EXCEPT the response
  stream of the request that triggers it"). An auto-activated `dispatch()`
  has no equivalent hook for an arbitrary tool call without generalizing
  that SSE-switch to every `tools/call`, which is explicitly Phase 3
  territory (issue #355, PROJECT.md) and out of scope here. Auto-activating
  without the notification leaves the client's cached `tools/list`
  silently stale — a new inconsistency, not a strict improvement over the
  guided-error path (which at least tells the model what changed).
- SPEC's own framing treats the guided error as sufficient on its own
  ("ships either way as the fallback for clients whose harness blocks calls
  to unlisted tools" — i.e., the guided error is expected to carry the
  feature; auto-activation was offered as an optional enhancement to
  evaluate, not a requirement to satisfy).

This is reopenable: if field telemetry after this ships shows the
guided-error retry round trip meaningfully hurts task completion for
compliant clients (i.e., clients that DO respect `tools/list` and DO retry
on the recovery message), auto-activation can be reconsidered as a narrower,
explicitly-opt-in mode — but that is a new decision on new evidence, not a
default to ship now.

### Alternative B: single generic outcome enum returned by `dispatch()` (e.g. `{ outcome: "served" | "adaptive_inactive" | "unknown", result }`) instead of a separate `isAdaptiveInactive()` query method

Change `dispatch()`'s return shape to a wrapper carrying both the MCP-wire
result and an out-of-band outcome tag, so `mcpServer.ts` reads the tag off
the same call instead of querying the registry a second time.

**Rejected.** `dispatch()`'s return value today IS the `CallToolResult`
handed straight to the MCP SDK's request handler, which serializes it
verbatim onto the wire; wrapping it would require every call site (the one
production call site, plus every test asserting on `dispatch()`'s return
shape) to unwrap it, an unnecessary breaking change to a widely-used method
signature for a need `mcpServer.ts` alone has. The chosen design (a
separate, purely-additive query method) needs zero changes to `dispatch()`'s
signature or existing callers' code.

### Alternative C: also suppress `recordCall` for outcome (c) (unregistered / user-disabled), not just outcome (b)

Since `recordCall(name, plugin)` today has no knowledge of whether `name` is
even a real, registered tool, calling it for a genuinely unregistered name is
arguably as much "recording a call that did not execute" as outcome (b) is —
the SPEC edge case's stated rationale ("it did not execute") applies equally.
A stricter fix would gate `recordCall` on "branch (a) only," suppressing it
for both (b) and (c).

**Rejected for this phase.** SPEC's scope section is explicit that outcome
(c)'s path is "unchanged," and its edge-case bullet names only outcome (b).
Extending the fix to (c) would change existing, working (if arguably
slightly wasteful) behavior with no SPEC requirement driving it, no test
currently locking in either the old or a new behavior for that case
(confirmed by grep — no test in `mcpServer.test.ts` currently asserts
`recordCall` fires for calls to unknown tool names), and no user-visible
symptom motivating it (a bogus counter entry for a name that will never
appear in `tools/list` is inert — `flushPendingCalls`'s promotion check only
ever promotes names that are also served, and a stray counter key for a
never-registered name has no promotion effect since it can never reach
`state.promoted` through any live code path that checks membership against
real tool names before use). Bounded scope over speculative correctness.

---

## Consequences

**Positive:**
- Closes audit finding 1 (#354): a client racing `activate_tools` with a
  direct call to the tool being activated now gets a structured, actionable
  recovery instruction instead of an opaque, indistinguishable-from-typo
  `Unknown tool` error.
- The recovery message names the exact tool and the exact `activate_tools`
  call shape, satisfying SPEC's "the message must name the exact tool and
  the exact `activate_tools` call, and remain a single stable... string"
  requirement — clients that pattern-match on it get a stable contract.
- User-disabled tools stay fully indistinguishable from unregistered ones
  (SPEC objective 2): branch (b)'s `!userDisabled` guard means the split
  introduced by ADR-0010 is never observable to an MCP client through this
  error surface, only through `activate_tool`'s explicit `not_allowed`
  outcome (which already exists, ADR-0010).
- Zero changes to `dispatch()`'s signature: the recordCall-gating need is
  met by a small, additive, single-purpose public method
  (`isAdaptiveInactive`), not a breaking wrapper around the return value —
  every existing call site (test or production) keeps compiling unchanged.
- The retry path is provably race-free relative to a genuine activation:
  `dispatch()` re-resolves servedness from live Set membership on every
  call, with no cache in that path — SPEC's edge case ("verify the retry
  path needs no re-list on the server side") holds without any additional
  code.
- Meta-tools are guaranteed to never hit branch (b) by an existing,
  unmodified invariant (`getActiveToolNames()` always includes
  `META_TOOLS`), not by new special-casing inside `dispatch()` — the
  registry stays name-agnostic, consistent with its existing design.

**Negative:**
- `mcpServer.ts` is a second file this feature must touch, contradicting
  SPEC's "Architecture" framing ("the whole feature lives in
  `toolRegistry.ts` plus tests"). Flagged and explained above (Context,
  "Scope correction") rather than silently expanded; the change there is
  minimal (one new local `const`, one added boolean condition) and does not
  touch `mcpServer.ts`'s request-routing or transport logic.
- `ToolRegistryClass`'s public surface grows by one more method
  (`isAdaptiveInactive`), alongside the two Sets and four methods ADR-0010
  already added — another name a future reader has to learn, though its
  purpose (mirrors `dispatch()`'s own branch (b) condition, for one external
  caller) is narrow and documented at the declaration.
- One existing test
  (`toolRegistry.test.ts`, "dispatch() on a disabled tool returns isError:
  true with Unknown tool message," using the ADAPTIVE-only `disable()`
  alias) currently asserts the OLD single-outcome behavior for what is, post
  this ADR, an adaptive-inactive-only tool — it will observably fail once
  branch (b) ships, because that tool now hits the new recoverable-error
  message instead of `Unknown tool`. Confirmed by grep across
  `packages/`/`scripts/`/`docs/architecture` for `"Unknown tool"` — this is
  the only call site whose assertion the change actually breaks (see
  Implementation plan, Task 3, and the observable-contract staleness note
  below). Two adjacent tests in the same file's ADR-0010 describe block
  already only assert `isError: true` (no text match) for this exact
  scenario shape, so they keep passing unchanged, but are strengthened with
  an explicit text assertion for outcome (b)/(c) respectively as part of
  this change, to lock in the new contract rather than leaving it
  implicit.
- Outcome (c)'s `recordCall`-fires-for-unregistered-names quirk is
  knowingly left in place (Alternative C) — a latent, pre-existing, inert
  oddity, not introduced or worsened by this change, but also not cleaned
  up by it.

**Neutral:**
- No `data.json` schema change; no persisted state changes (SPEC "Data
  model: None").
- The Windows bridge (Phase 3, issue #355) is unaffected: this feature only
  changes the JSON-RPC result content for one tool-call outcome, not the
  HTTP response's content-type or framing.
- `activate_tool`/`activate_tools`' own logic (not-found, `not_allowed`,
  already-active, activated) is untouched — SPEC's "Out" scope line
  ("Any change to the activation tools themselves... is out of scope") is
  honored; this ADR's Alternative A rejection is precisely what keeps that
  boundary intact going forward.

---

## Files to create or modify

| File | Change |
|---|---|
| `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts` | `dispatch()` gains the branch-(b) recoverable-error path before the fallback throw; add `isAdaptiveInactive(name)` public method. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.test.ts` | Update the one breaking assertion (Task 3 in the plan); add new tests for outcome (b)/(c)/(a)-round-trip/`isAdaptiveInactive`. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts` | `CallToolRequestSchema` handler: read `registry.isAdaptiveInactive(name)` before `dispatch()`, add it to the existing `recordCall` gate condition. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.test.ts` | New e2e test(s): adaptive-inactive call does not increment the promotion counter; baseline enabled-call still does. |

---

## References

- SPEC.md at repo root ("Self-healing inactive tool error", 2026-07-14)
- PROJECT.md at repo root, Phase 2 / "Self-healing inactive tool error" feature note
- GitHub issue #354 (2026-07-14 parallel-tool-call audit, finding 1)
- ADR-0010: split registry disable states (issue #353) — the state model
  this ADR reads (`adaptiveDisabled`/`userDisabled`), and the "disable list
  wins" / composition-root precedents this ADR's Alternative A rejection
  relies on.
- `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts` (`dispatch()`, current single-outcome error path)
- `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts:98-124` (`CallToolRequestSchema` handler, `recordCall` wiring)
- `packages/obsidian-plugin/src/features/adaptive-tool-loading/constants.ts` (`ALWAYS_ACTIVE_TOOLS`/`META_TOOLS`, token-minimization rationale cited in Alternative A)
