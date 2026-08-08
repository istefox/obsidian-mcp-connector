<!-- project-tasks: prefix=OMC lastId=22 -->
# PROJECT TASKS

Updated: 2026-08-08 · Open: 5 (P1: 0) · In progress: 0

## Next — measured gaps, actionable now

- [ ] `OMC-022` **P3** The conformance CI job is no longer blocked. It was excluded from the Fase 1 run because there was no way to boot the MCP service headless, and that is now solved: `createMcpService` + `startHttpServer` + the `test-setup` mocks serve the real surface on a fixed port with no Obsidian and no vault (proven against `server-stateless` during the OMC-018 verification). Two pieces are still missing before it can be a CI step — the harness lives in a scratchpad rather than in `scripts/`, and the suite has to be run from the conformance repo's `main` since the published CLI has no 2026 scenarios. An expected-failures baseline (`--expected-failures`) is what would make it a gate rather than a report <!-- src:session opened:2026-08-08 -->
- [ ] `OMC-016` **P3** #427 MCP Apps: **answered, it works.** The spike on `spike/427-mcp-apps-ui-resource` proved Claude Desktop reads and renders a `ui://` resource from this connector. What mattered was declaring `capabilities.extensions` with `io.modelcontextprotocol/ui`; the generic `resources` capability alone did nothing. Two hard requirements: mime type exactly `text/html;profile=mcp-app`, and the view must complete the `ui/initialize` → `ui/notifications/initialized` handshake or the host leaves the iframe blank. Real implementation is the remaining work: a proper resources capability, the handshake via `@modelcontextprotocol/ext-apps` (1.7.5 on npm) rather than hand-rolled `postMessage`, then the ranked search list <!-- src:session opened:2026-08-06 updated:2026-08-07 -->

## Parked — external trigger, nothing to do until it fires

- [ ] `OMC-010` **P3** #416 MCP Tasks: watch item only, no client in the support matrix declares `io.modelcontextprotocol/tasks` yet. The MCP Apps half moved to OMC-016. Re-check the matrix when the tiering page's client matrix moves <!-- src:session opened:2026-08-05 updated:2026-08-07 -->

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

**Correction to how OMC-018 was scoped.** That entry described the suite as wanting `-32602` for a
"malformed `_meta`", as if it were the same size of job as the `-32020`. Reading the checks
themselves (`sep-2575-request-meta-invalid-missing-meta`, `-missing-protocol-version`,
`-missing-client-capabilities`) says otherwise: what the suite calls malformed is `_meta` **absent**
or missing `protocolVersion`/`clientCapabilities`. Requiring those is the 2026 lifecycle itself, so
those three checks belong to OMC-008 and cannot move before it. The `-32602` branch OMC-018 did
ship — `_meta` present but not an object — is ordinary shape validation the suite never exercises.

- [ ] `OMC-008` **P2** #407 adopt MCP spec `2026-07-28`. The SDK is not the blocker it looked like: `@modelcontextprotocol/{core,server}@2.0.0` shipped 2026-07-27 with every 2026 schema (`SubscriptionsListenRequestSchema`, `DiscoverRequestSchema`, tasks, `extensions`), though `LATEST_PROTOCOL_VERSION` is still `2025-11-25` even on `main`. Measured gaps beyond the lifecycle question: per-request `_meta` validation (4 checks), `server/discover` (3 + a warning for the missing `serverInfo` in result `_meta`). Baseline is now 7/27 rather than 4/27 after OMC-018, measured in the headless harness <!-- src:session opened:2026-08-05 updated:2026-08-08 -->
- [ ] `OMC-007` **P2** #419 cross-client `tools/list` staleness. Closed by `subscriptions/listen`, whose acceptance criteria now come from conformance rather than from us: the ack notification must be the stream's first message, later notifications must carry a matching `subscriptionId`, and notification types outside the client's filter must not be sent. The SDK already exports every schema needed. Gated on the lifecycle decision above; the untested narrow question is whether a listen stream can coexist with today's `initialize` rather than replace it. Careful with the scoreboard here: `sep-2575-server-honors-notification-filter` reads green today only because we have no listen stream and therefore nothing that can leak — it is a vacuous pass and will become a real check the moment this lands <!-- src:session opened:2026-08-05 updated:2026-08-08 -->

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
- **Build & test**: `bun run build` · `bun run release` · test-cmd `bun run check && bun test && bun run format:check`, plus `bun run check:svelte` and `bun run test:mcpb` from `packages/obsidian-plugin`
- **Key ADRs**: ADR-0013 pure-Node `.mcpb` shim · ADR-0014 per-client tool profiles · ADR-0015 `tools/list` stability invariant · ADR-0010 split registry disable states
- **Invariants**: transport is stateless and POST-only, `GET /mcp` is 405 by design · every settings write goes through `SettingsStore.updateSlice` under the process-wide mutex · a bearer token string never changes silently · the shim fails closed on an unknown token id · a polymorphic tool never declares an `outputSchema`

## Done

- [x] `OMC-018` PR #437. Verified against `server-stateless` with a controlled baseline: the pre-fix commit and the fix were each served by the same headless harness, so the delta is attributable. 4/27 → 7/27. Two passes are real — `http-server-header-mismatch-400` (a version mismatch now answers 400 with `-32020`) and `http-server-error-jsonrpc-id` (every error response echoes the request id). The third, `server-honors-notification-filter`, is vacuous: it failed before only because the empty 400 body left the suite no frame to inspect, and we still do not implement `subscriptions/listen` (see OMC-007). The `-32602` checks did not move, by design — see the correction under Blocked (2026-08-08)
- [x] `OMC-019` PR #436. Split rather than resolved wholesale, which was the right call. `require("fs/promises")` became a static import: it only runs after the native dialog returns, so there is nothing left to guard lazily, and Bun's cjs output is byte-identical. `require("electron")` stays, now with the reasoning in the code — it runs unconditionally before we know the host, its `try`/`catch` is load-bearing (a top-level import would crash the file's whole suite instead of degrading), and dynamic `import()` is already documented as unreliable under Obsidian's loader. The reviewer finding is gone from `src/**` for the one that could move (2026-08-08)
- [x] `OMC-020` PR #435, the redundant non-null assertion on `startLine` dropped (2026-08-08)
- [x] `OMC-017` Done locally and not committable: `CLAUDE.md` is gitignored as of `2d74e95`, which is why the unattended agent correctly refused it. Four edits — `check:svelte` and `test:mcpb` added to Commands, the full-gate line extended, the Svelte gotcha rewritten now that CI type-checks it, and a wrong path corrected to `src/features/mcp-client-config/assets/connectorShimSource.ts` (2026-08-08)
- [x] `OMC-021` Closed with no dependency change, and the entry's own premise was wrong: `hono` is **not** transitive, it is a direct root dependency at `^4.12.25` with an override at `^4.12.23`, pinned precisely to control the version under `@modelcontextprotocol/node`. Provenance for the rest: `@hono/node-server@1.19.13` via `@modelcontextprotocol/node`, `adm-zip@0.5.17` and `sharp@0.34.5` via `@huggingface/transformers` (the former through `onnxruntime-node`), `brace-expansion@5.0.6` via `minimatch`. Every resolved version is far above the flagged `<0.6.0` range. In the shipped `main.js`: `@hono/node-server` is present, `adm-zip` and `brace-expansion` do not appear at all, and `sharp` is not bundled either — it is native and cannot be, so its hits are transformers' own guarded `toSharp()` call sites plus one HTML entity name (2026-08-08)
- [x] `OMC-012` Reviewer verdict for 1.0.1 (`e2ebb20`) read: **Completed**. Two Pass results that matter — the `main.js` GitHub artifact attestation verifies, closing out July's false positive, and the build reproduced the release `main.js` byte-for-byte. Behaviour flags (filesystem, shell, vault enumeration, clipboard, dynamic code) are the usual by-design ones. New findings became OMC-019/020/021 (2026-08-08)
- [x] `OMC-004` All three manual checks pass. The empty-allowlist warning renders and says explicitly that no ticks means meta-tools only, "not the same as no limit". The Tool loading panel follows the selected token row. R-22 verified over HTTP with both tokens: after promoting `show_file_in_obsidian` on `default` only, that token listed 17 tools and the second listed 16, the symmetric difference being exactly that tool — a promotion does not widen another client's surface. Caveat: R-22 was driven over raw HTTP rather than through a second GUI client (2026-08-08)
- [x] `OMC-011` Verified on the real artifact. The Labs vault was still on 1.0.0, which is why the installed extension was a hand-patched 1.0.0 — updated it through Obsidian's own community-plugin update, re-exported the `.mcpb` from the token row (1.0.1, `isEntryPoint` present, token id embedded), installed it in Claude Desktop, and with **Use Built-in Node.js for MCP left on** the connector reports "Server attivo, versione 1.0.1". The reinstall also removed `server/index.js.bak-412` on its own (2026-08-08)
- [x] `OMC-005` CI now type-checks Svelte (`check:svelte`, clean against all 11 components) and smokes the `.mcpb` bundle on both loaders (`test:mcpb`), built through the real `generateMcpb()`. The smoke also compares the shipped `server/index.js` against `connectorShim.js` byte-for-byte, so a stale generated asset fails loud. Proven to catch #412 by reverting `isEntryPoint()`: check 4 went red while check 3 stayed green. PR #429 (2026-08-06)
- [x] `OMC-014` The `constants.ts` comment now cites `@modelcontextprotocol/core/dist/internal.mjs`, verified present. The `mcpServer.ts` one dropped its citation instead of pointing at `PerRequestHTTPServerTransport`, which carries a near-identical message but is a transport we never import; the constraint now rests on the 0.4.0-alpha.2 smoke incident. PR #428 (2026-08-06)
- [x] `OMC-015` Labs vault plugin dir cleaned: 6 stale build backups and the pre-1.0.0 settings backup deleted, 12 MB, plus the probe fixture `Prompts/completion-probe.md`. The deleted builds for 0.28.1, 0.28.2 and 1.0.0 remain recoverable from the published releases (2026-08-06)
- [x] `OMC-013` #412 closed: Piter10k confirmed the fix on 2026-08-05 and the 1.0.1 release notice, with the re-export step, is posted on the issue (2026-08-06)
- [x] `OMC-009` #347 closed as not planned: the transclusion half shipped in #420, and the `completion/complete` half closes on expected value since the stub measurement was never run (2026-08-06)
- [x] `OMC-002` #412 answered with the verified mechanism, the 153 ms end-to-end result and the missing-stderr caveat (2026-08-05)
- [x] `OMC-001` `.mcpb` never started under "Use Built-in Node.js for MCP" — the cause was the shim's `require.main === module` guard, false under the host's `import()`, not the missing `compatibility` field this entry first blamed; `isEntryPoint()` replaces it (2026-08-05)
- [x] `OMC-003` README and ADR-0013 rewritten off the verified mechanism; the 0.27.3 addendum's wrong attribution is now marked as wrong rather than deleted (2026-08-05)
- [x] `OMC-006` Shim request deadline committed as `331f1e0`, gate green (2026-08-05)
