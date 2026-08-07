<!-- project-tasks: prefix=OMC lastId=18 -->
# PROJECT TASKS

Updated: 2026-08-07 · Open: 8 (P1: 1) · In progress: 0

## Now — close the 1.0.x release loop

- [ ] `OMC-011` **P1** The Claude Desktop extension installed on this machine is a hand-patched copy, not a bundle from the release pipeline, so the `.mcpb` users actually install has never been run end to end for 1.0.1: re-export it from the token row in the Labs vault, reinstall, smoke it with "Use Built-in Node.js for MCP" left on, then delete `server/index.js.bak-412` — `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.stefano-ferri.obsidian-mcp-connector/server/` <!-- src:session opened:2026-08-05 updated:2026-08-06 -->
- [ ] `OMC-004` **P2** Three manual checks for 1.0.0 never ran and no CI job covers them: the empty-allowlist warning, the Tool Loading panel following the selection with two tokens, and the R-22 two-client smoke test. Run them in the same vault session as OMC-011 <!-- src:session opened:2026-08-05 updated:2026-08-06 -->
- [ ] `OMC-012` **P3** The community-plugin scanner now runs against the published 1.0.1 release; read the verdict at community.obsidian.md/account/plugins <!-- src:session opened:2026-08-05 -->

## Next — measured gaps, actionable now

- [ ] `OMC-018` **P2** Conformance `server-stateless` passes our HTTP status codes but not our JSON-RPC bodies: a malformed `_meta` and an unsupported protocol version both answer 400 with no error code, where the spec wants `-32602` and `-32020`. Self-contained, independent of any lifecycle decision, and it lands in `mcp-transport/services/middleware.ts` <!-- src:session opened:2026-08-07 -->
- [ ] `OMC-016` **P3** #427 MCP Apps: **answered, it works.** The spike on `spike/427-mcp-apps-ui-resource` proved Claude Desktop reads and renders a `ui://` resource from this connector. What mattered was declaring `capabilities.extensions` with `io.modelcontextprotocol/ui`; the generic `resources` capability alone did nothing. Two hard requirements: mime type exactly `text/html;profile=mcp-app`, and the view must complete the `ui/initialize` → `ui/notifications/initialized` handshake or the host leaves the iframe blank. Real implementation is the remaining work: a proper resources capability, the handshake via `@modelcontextprotocol/ext-apps` (1.7.5 on npm) rather than hand-rolled `postMessage`, then the ranked search list <!-- src:session opened:2026-08-06 updated:2026-08-07 -->

## Parked — external trigger, nothing to do until it fires

- [ ] `OMC-010` **P3** #416 MCP Tasks: watch item only, no client in the support matrix declares `io.modelcontextprotocol/tasks` yet. The MCP Apps half moved to OMC-016. Re-check the matrix when the tiering page's client matrix moves <!-- src:session opened:2026-08-05 updated:2026-08-07 -->

## Opportunistic — do when the file is open anyway

- [ ] `OMC-017` **P3** `CLAUDE.md` predates #429: the full gate on line 17 omits `check:svelte` and `test:mcpb`, and line 72 still says Svelte components sit outside type checking, which stopped being true when the CI step landed. Line 8's note about `bun run check` itself is still accurate and should stay <!-- src:session opened:2026-08-07 -->

## In Progress

_none_

## Blocked / Decisions Needed

**The `2026-07-28` lifecycle break.** Running conformance's `server-stateless` (SEP-2575) from
source showed that six of its thirty checks require `initialize`, `ping`, `logging/setLevel`,
`resources/subscribe` and `resources/unsubscribe` to **stop existing**, answering HTTP 404 with
`-32601`. A conformant 2026 server has no `initialize` handshake: the lifecycle moves to
per-request `_meta`. So adopting the revision is a migration that breaks every configured client,
not a capability we add, and it cannot be half-done. That is an ADR-sized decision and it gates
both entries below. What is NOT blocked: the 2026 mechanisms that ride per-request `_meta` already
work — #427 proved extensions do, under a 2025 negotiated version.

- [ ] `OMC-008` **P2** #407 adopt MCP spec `2026-07-28`. The SDK is not the blocker it looked like: `@modelcontextprotocol/{core,server}@2.0.0` shipped 2026-07-27 with every 2026 schema (`SubscriptionsListenRequestSchema`, `DiscoverRequestSchema`, tasks, `extensions`), though `LATEST_PROTOCOL_VERSION` is still `2025-11-25` even on `main`. Measured gaps beyond the lifecycle question: per-request `_meta` validation (4 checks), `server/discover` (3 + a warning for the missing `serverInfo` in result `_meta`) <!-- src:session opened:2026-08-05 updated:2026-08-07 -->
- [ ] `OMC-007` **P2** #419 cross-client `tools/list` staleness. Closed by `subscriptions/listen`, whose acceptance criteria now come from conformance rather than from us: the ack notification must be the stream's first message, later notifications must carry a matching `subscriptionId`, and notification types outside the client's filter must not be sent. The SDK already exports every schema needed. Gated on the lifecycle decision above; the untested narrow question is whether a listen stream can coexist with today's `initialize` rather than replace it <!-- src:session opened:2026-08-05 updated:2026-08-07 -->

**Conformance tooling note.** The published CLI (`0.1.16`) has no 2026 scenarios at all — no
`draft` suite, no `server-stateless`. Those live only on the repo's `main` (`0.2.0-alpha.10`) and
must be run from source. Against the published suite we pass every scenario that applies to our
surface; the failures are fixture-dependent (it expects the reference server's `test_*` tools and
`test://` resources) or optional capabilities we chose not to implement: `logging/setLevel`,
`completion/complete` (that is #347, closed as not planned — this is the first visible cost of
that call) and resource subscriptions.

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
