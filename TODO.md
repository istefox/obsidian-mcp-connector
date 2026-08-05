<!-- project-tasks: prefix=OMC lastId=13 -->
# PROJECT TASKS

Updated: 2026-08-05 · Open: 9 (P1: 0) · In progress: 0

## Open Issues

- [ ] `OMC-011` **P2** The Claude Desktop extension installed on this machine is a hand-patched copy, not a 1.0.1 bundle: re-export the `.mcpb` from the token row in the Labs vault, reinstall it, then delete `server/index.js.bak-412` — `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.stefano-ferri.obsidian-mcp-connector/server/` <!-- src:session opened:2026-08-05 -->
- [ ] `OMC-012` **P3** The community-plugin scanner now runs against the published 1.0.1 release; read the verdict at community.obsidian.md/account/plugins <!-- src:session opened:2026-08-05 -->
- [ ] `OMC-013` **P3** #412 stays open until Piter10k confirms the fix on their machine; close it as completed once they do <!-- src:session opened:2026-08-05 -->
- [ ] `OMC-004` **P2** Three manual checks for 1.0.0 never ran and no CI job covers them: the empty-allowlist warning, the Tool Loading panel following the selection with two tokens, and the R-22 two-client smoke test <!-- src:session opened:2026-08-05 -->
- [ ] `OMC-005` **P2** CI has neither a Svelte compile check nor a `.mcpb` bundle check, and `bun run check` skips `.svelte` files entirely, so a UI regression reaches a real vault before anything fails <!-- src:session opened:2026-08-05 -->

## In Progress

_none_

## Backlog / To Add

- [ ] `OMC-007` **P2** #419 cross-client `tools/list` staleness: a promotion never reaches a client that is not the caller, because `notifications/tools/list_changed` rides the caller's own POST response and there is no fan-out <!-- src:session opened:2026-08-05 -->
- [ ] `OMC-008` **P2** #407 adopt MCP spec `2026-07-28`: SDK v2 landed in 0.28.2, the protocol opt-in remains, and `subscriptions/listen` is what actually closes OMC-007 <!-- src:session opened:2026-08-05 -->
- [ ] `OMC-009` **P3** #347 `completion/complete` argument completions; the transclusion half shipped in #420 <!-- src:session opened:2026-08-05 -->
- [ ] `OMC-010` **P3** #416 evaluate the MCP Apps and Tasks extensions from the `2026-07-28` revision <!-- src:session opened:2026-08-05 -->

## Blocked / Decisions Needed

_none_

## Project Map

- **Entry point**: `packages/obsidian-plugin/src/main.ts` · shim `packages/obsidian-plugin/scripts/connectorShim.js`
- **Modules**: `src/features/mcp-transport` (HTTP, tokens, registry) · `src/features/mcp-tools` · `src/features/mcp-client-config` (`.mcpb`, shim source) · `src/features/adaptive-tool-loading` · `src/features/prompts` · `src/features/semantic-search` · `packages/shared`
- **Build & test**: `bun run build` · `bun run release` · test-cmd `bun run check && bun test && bun run format:check`
- **Key ADRs**: ADR-0013 pure-Node `.mcpb` shim · ADR-0014 per-client tool profiles · ADR-0015 `tools/list` stability invariant · ADR-0010 split registry disable states
- **Invariants**: transport is stateless and POST-only, `GET /mcp` is 405 by design · every settings write goes through `SettingsStore.updateSlice` under the process-wide mutex · a bearer token string never changes silently · the shim fails closed on an unknown token id · a polymorphic tool never declares an `outputSchema`

## Done

- [x] `OMC-002` #412 answered with the verified mechanism, the 153 ms end-to-end result and the missing-stderr caveat (2026-08-05)
- [x] `OMC-001` `.mcpb` never started under "Use Built-in Node.js for MCP" — the cause was the shim's `require.main === module` guard, false under the host's `import()`, not the missing `compatibility` field this entry first blamed; `isEntryPoint()` replaces it (2026-08-05)
- [x] `OMC-003` README and ADR-0013 rewritten off the verified mechanism; the 0.27.3 addendum's wrong attribution is now marked as wrong rather than deleted (2026-08-05)
- [x] `OMC-006` Shim request deadline committed as `331f1e0`, gate green (2026-08-05)
