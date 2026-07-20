# SPEC — Split registry disable states

Source: GitHub issue #353 (parallel-tool-call audit 2026-07-14, finding 3; PROJECT.md Phase 1)

## Objectives

1. Model "adaptive-inactive" and "user-disabled" as two distinct states in the tool
   registry instead of one shared `enabled` set.
2. Make `activate_tool` / `activate_tools` able to clear ONLY the adaptive state, so a
   tool the user disabled in the tool-toggle UI can never be re-enabled by an MCP
   client. This restores the "disable list wins" invariant stated in
   `src/composeToolRegistry.ts:100-106` at runtime, not just at compose time.
3. Preserve all current externally visible behavior for tools that are only
   adaptive-inactive or only enabled.

## Scope

In:
- `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts` —
  replace the single `enabled: Set` with two independent flags (e.g.
  `adaptiveDisabled` and `userDisabled` sets, or a per-tool state record). A tool is
  served by `list()` and `dispatch()` only when NEITHER flag is set.
- Registry API: keep `disableByName`/`enableByName` signatures working but split them
  by concern (e.g. `setAdaptiveDisabled(name, bool)` / `setUserDisabled(name, bool)`),
  updating the two callers:
  `features/adaptive-tool-loading/applyAdaptiveFilter.ts` and
  `features/tool-toggle/services/applyFilter.ts`.
- `activate_tool` / `activate_tools` handlers
  (`features/mcp-tools/tools/activateTool.ts`, `activateTools.ts`): the
  `enableInRegistry` callback wired in `composeToolRegistry.ts:79,95` must clear only
  the adaptive flag. A request to activate a user-disabled tool returns outcome
  `not_allowed` (new outcome value) with a message saying the user disabled it, and is
  never persisted to `promoted`.
- `tool_catalog` handler: a user-disabled tool must not be offered as activatable.
- `listCache` invalidation must fire on changes to either flag.

Out:
- Any change to the dispatch error message for inactive tools (that is the Phase 2
  feature "Self-healing inactive tool error", which depends on this one).
- Tool-toggle UI changes beyond what the renamed registry API forces.
- The adaptive profile logic (core set, promotion threshold, counters) in
  `toolLoadingManager.ts` — unchanged.

## Stack

TypeScript (Obsidian plugin, Electron renderer), ArkType schemas, bun test.
Monorepo package: `packages/obsidian-plugin`.

## Architecture

- `toolRegistry.ts` holds the state model; it is the single choke point — `list()`,
  `listAll()`, `dispatch()` all read it.
- `composeToolRegistry.ts` applies `applyAdaptiveFilter` then
  `applyDisabledToolsFilter` at build time; after the split, order no longer matters
  for correctness (flags are independent), but keep the current order.
- Meta-tools (`tool_catalog`, `activate_tool`, `activate_tools`) are always active:
  neither filter may flag them (current behavior, keep enforced).

## Data model

Per-tool boolean pair (adaptiveDisabled, userDisabled) replacing membership in one
`enabled` set. No persisted-format change: `data.json` slices (`toolLoading`,
tool-toggle disable list) stay as they are; the split is in-memory registry state
derived from them.

## API / Interfaces

- Registry public surface: `list`, `listAll`, `dispatch`, `register`,
  `setAnnotations` unchanged in behavior for callers; enable/disable entry points
  split by concern as described in Scope.
- `listAll()` gains enough information for callers to distinguish the two states
  (e.g. `{ name, description, enabled, userDisabled }`), needed by `tool_catalog`
  and the activation handlers.
- MCP-visible: `activate_tools` outcome map gains `not_allowed`.

## UI flows

None beyond existing tool-toggle settings tab continuing to work. Toggling a tool
off in settings must also take effect on the live registry if it already does today;
do not add new live-sync behavior if it does not.

## Edge cases

- Tool that is BOTH adaptive-inactive and user-disabled: activation request clears
  nothing, returns `not_allowed`, and the tool stays hidden.
- `persist: true` activation of a user-disabled tool must not write it to
  `promoted` in `data.json`.
- A promoted (persisted) tool that the user later disables: user flag wins on next
  compose; the stale `promoted` entry is harmless and must not resurrect the tool.
- Profile "all": adaptive flag never set; user-disabled still enforced.
- `resetAll` clears counters/promotions but must not touch user-disabled state.

## Success criteria

- [ ] Unit tests: dispatch serves a tool only when neither flag is set; each flag
      alone hides it from `list()` and `dispatch()`.
- [ ] Unit test: `activate_tool` and `activate_tools` on a user-disabled tool return
      `not_allowed`, do not enable it, do not persist it, do not emit
      `tools/list_changed` for it.
- [ ] Unit test: `activate_tools` mixed batch (unknown + already-active +
      adaptive-inactive + user-disabled) reports the correct outcome per name and
      enables only the adaptive-inactive ones.
- [ ] Unit test: `tool_catalog` does not offer user-disabled tools.
- [ ] Existing test suite green with no test disabled or weakened.
