# SPEC — Self-healing inactive tool error

Source: GitHub issue #354 (parallel-tool-call audit 2026-07-14, finding 1; PROJECT.md Phase 2)
Depends on: "Split registry disable states" (Phase 1) — requires the registry to
distinguish adaptive-inactive from user-disabled.

## Objectives

1. When a client calls a tool that is registered but adaptive-inactive, return an
   `isError` tool result whose text tells the model exactly how to recover, instead
   of the current opaque `Unknown tool: <name>` thrown at
   `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts:363-377`.
2. Keep user-disabled and genuinely unregistered tools indistinguishable from each
   other (both stay `Unknown tool`), so a user's disable choice leaks nothing.
3. Reduce the practical failure rate of parallel batches where the model issues
   `activate_tools` and calls to the tools being activated in the same turn: the
   racing calls fail with a message the model can act on (activate, then retry).

## Scope

In:
- `toolRegistry.ts` `dispatch()`: three-way outcome —
  a) enabled → dispatch as today;
  b) registered + adaptive-inactive (and NOT user-disabled) → return
     `isError: true` with text:
     `Tool '<name>' exists but is inactive. Call activate_tools({"names":["<name>"]}) first, then retry this call.`;
  c) unregistered OR user-disabled → current `Unknown tool: <name>` path, unchanged.
- Unit tests covering the three outcomes.
- An ADR (produced by the chain) deciding whether auto-activation-on-call for
  adaptive-inactive tools is adopted or rejected. Implementing auto-activation is in
  scope ONLY if the ADR adopts it; the guided-error behavior above ships either way
  as the fallback for clients whose harness blocks calls to unlisted tools.

Out:
- Any change to the activation tools themselves or to the `tools/list_changed`
  notification flow (works as shipped in 0.22.0).
- Client-side behavior (harness tool-list caching); the server can only shape its
  error surface.
- The Windows bridge (Phase 3 feature).

## Stack

TypeScript (Obsidian plugin), ArkType, bun test. Package: `packages/obsidian-plugin`.

## Architecture

`dispatch()` is the single entry point for `tools/call` (wired per request in
`mcp-transport/services/mcpServer.ts:98-124`), so the whole feature lives in
`toolRegistry.ts` plus tests. The Phase 1 state split provides the
adaptive-vs-user-disabled distinction this feature branches on.

## Data model

None. No persisted state changes.

## API / Interfaces

MCP-visible only: the `tools/call` error envelope for adaptive-inactive tools changes
from `Unknown tool: <name>` to the recovery message above. The message must name the
exact tool and the exact `activate_tools` call, and remain a single stable sentence
(clients may pattern-match on it).

## UI flows

None.

## Edge cases

- Meta-tools are always active and must never hit outcome (b).
- A tool that is adaptive-inactive AND user-disabled must produce outcome (c), not
  (b) — the user's choice must not be discoverable.
- Race window still exists: a call racing `activate_tools` may land before OR after
  activation. After: normal success. Before: outcome (b), which instructs a retry —
  verify the retry path needs no re-list on the server side (dispatch reads live
  registry state, not the list cache).
- `recordCall` counter: outcome (b) must not count as a call of the target tool for
  frequency promotion (it did not execute).

## Success criteria

- [ ] Unit test: call to adaptive-inactive tool returns `isError: true` with the
      recovery message naming the tool.
- [ ] Unit test: call to user-disabled tool returns `Unknown tool` identical in shape
      to a call to a nonexistent tool.
- [ ] Unit test: recovery message round-trip — after `activate_tools` on the named
      tool, the identical retried call succeeds.
- [ ] Unit test: outcome (b) does not increment the tool's promotion counter.
- [ ] ADR recorded under `docs/architecture/` deciding auto-activation-on-call
      (adopted or rejected, with rationale).
- [ ] Existing test suite green with no test disabled or weakened.
