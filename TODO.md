<!-- project-tasks: prefix=OMC lastId=17 -->
# PROJECT TASKS

Updated: 2026-08-07 · Open: 8 (P1: 1) · In progress: 0

## Now — close the 1.0.x release loop

- [ ] `OMC-011` **P1** The Claude Desktop extension installed on this machine is a hand-patched copy, not a bundle from the release pipeline, so the `.mcpb` users actually install has never been run end to end for 1.0.1: re-export it from the token row in the Labs vault, reinstall, smoke it with "Use Built-in Node.js for MCP" left on, then delete `server/index.js.bak-412` — `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.stefano-ferri.obsidian-mcp-connector/server/` <!-- src:session opened:2026-08-05 updated:2026-08-06 -->
- [ ] `OMC-004` **P2** Three manual checks for 1.0.0 never ran and no CI job covers them: the empty-allowlist warning, the Tool Loading panel following the selection with two tokens, and the R-22 two-client smoke test. Run them in the same vault session as OMC-011 <!-- src:session opened:2026-08-05 updated:2026-08-06 -->
- [ ] `OMC-012` **P3** The community-plugin scanner now runs against the published 1.0.1 release; read the verdict at community.obsidian.md/account/plugins <!-- src:session opened:2026-08-05 -->

## Then — the one unblocked bet

- [ ] `OMC-016` **P3** #427 MCP Apps (`io.modelcontextprotocol/ui`): `search_vault_smart` results as a ranked clickable list. The stateless question is answered and is NOT a blocker — the UI is static tool metadata (`_meta.ui.resourceUri`) plus a separately served `ui://` resource, and the tool result stays plain text, so nothing in the request path is conditional. The real cost, unpriced in the issue, is that this connector declares `tools` and `prompts` only and MCP Apps needs a `resources` implementation. Next step is a spike: a `ui://` handler and the smallest HTML that renders in Claude Desktop, not the search UI <!-- src:session opened:2026-08-06 updated:2026-08-07 -->

## Parked — external trigger, nothing to do until it fires

**Trigger: the MCP SDK's supported-versions list gains `2026-07-28`.** Until then neither entry
below is actionable, and #419 says so in its own body. They are here so the analysis is not
rediscovered, not because they are waiting on a decision of ours.

- [ ] `OMC-008` **P2** #407 adopt MCP spec `2026-07-28`: SDK v2 landed in 0.28.2 and `subscriptions/listen` is what actually closes OMC-007, but Phase 2 is blocked upstream — SDK 2.0.0 is npm's latest and its supported list stops at `2025-11-25`, so `2026-07-28` cannot be negotiated yet <!-- src:session opened:2026-08-05 updated:2026-08-06 -->
- [ ] `OMC-007` **P2** #419 cross-client `tools/list` staleness: a promotion never reaches a client that is not the caller, because `notifications/tools/list_changed` rides the caller's own POST response and there is no fan-out. Closed by #407 Phase 2's `subscriptions/listen`, with the acceptance criterion already written in the issue <!-- src:session opened:2026-08-05 updated:2026-08-06 -->
- [ ] `OMC-010` **P3** #416 MCP Tasks: watch item only, no client in the support matrix declares `io.modelcontextprotocol/tasks` yet. The MCP Apps half moved to OMC-016. Re-check the matrix when OMC-008 unparks <!-- src:session opened:2026-08-05 updated:2026-08-06 -->

## Opportunistic — do when the file is open anyway

- [ ] `OMC-017` **P3** `CLAUDE.md` predates #429: the full gate on line 17 omits `check:svelte` and `test:mcpb`, and line 72 still says Svelte components sit outside type checking, which stopped being true when the CI step landed. Line 8's note about `bun run check` itself is still accurate and should stay <!-- src:session opened:2026-08-07 -->

## In Progress

_none_

## Blocked / Decisions Needed

_none_

## Project Map

- **Entry point**: `packages/obsidian-plugin/src/main.ts` · shim `packages/obsidian-plugin/scripts/connectorShim.js`
- **Modules**: `src/features/mcp-transport` (HTTP, tokens, registry) · `src/features/mcp-tools` · `src/features/mcp-client-config` (`.mcpb`, shim source) · `src/features/adaptive-tool-loading` · `src/features/prompts` · `src/features/semantic-search` · `packages/shared`
- **Build & test**: `bun run build` · `bun run release` · test-cmd `bun run check && bun test && bun run format:check`
- **Key ADRs**: ADR-0013 pure-Node `.mcpb` shim · ADR-0014 per-client tool profiles · ADR-0015 `tools/list` stability invariant · ADR-0010 split registry disable states
- **Invariants**: transport is stateless and POST-only, `GET /mcp` is 405 by design · every settings write goes through `SettingsStore.updateSlice` under the process-wide mutex · a bearer token string never changes silently · the shim fails closed on an unknown token id · a polymorphic tool never declares an `outputSchema`

## Done

- [x] `OMC-005` CI now type-checks Svelte (`check:svelte`, clean against all 11 components) and smokes the `.mcpb` bundle on both loaders (`test:mcpb`), built through the real `generateMcpb()`. The smoke also compares the shipped `server/index.js` against `connectorShim.js` byte-for-byte, so a stale generated asset fails loud. Proven to catch #412 by reverting `isEntryPoint()`: check 4 went red while check 3 stayed green. PR #429 (2026-08-06)
- [x] `OMC-014` The `constants.ts` comment now cites `@modelcontextprotocol/core/dist/internal.mjs`, verified present. The `mcpServer.ts` one dropped its citation instead of pointing at `PerRequestHTTPServerTransport`, which carries a near-identical message but is a transport we never import; the constraint now rests on the 0.4.0-alpha.2 smoke incident. PR #428 (2026-08-06)
- [x] `OMC-015` Labs vault plugin dir cleaned: 6 stale build backups and the pre-1.0.0 settings backup deleted, 12 MB, plus the probe fixture `Prompts/completion-probe.md`. The deleted builds for 0.28.1, 0.28.2 and 1.0.0 remain recoverable from the published releases (2026-08-06)
- [x] `OMC-013` #412 closed: Piter10k confirmed the fix on 2026-08-05 and the 1.0.1 release notice, with the re-export step, is posted on the issue (2026-08-06)
- [x] `OMC-009` #347 closed as not planned: the transclusion half shipped in #420, and the `completion/complete` half closes on expected value since the stub measurement was never run (2026-08-06)
- [x] `OMC-002` #412 answered with the verified mechanism, the 153 ms end-to-end result and the missing-stderr caveat (2026-08-05)
- [x] `OMC-001` `.mcpb` never started under "Use Built-in Node.js for MCP" — the cause was the shim's `require.main === module` guard, false under the host's `import()`, not the missing `compatibility` field this entry first blamed; `isEntryPoint()` replaces it (2026-08-05)
- [x] `OMC-003` README and ADR-0013 rewritten off the verified mechanism; the 0.27.3 addendum's wrong attribution is now marked as wrong rather than deleted (2026-08-05)
- [x] `OMC-006` Shim request deadline committed as `331f1e0`, gate green (2026-08-05)
