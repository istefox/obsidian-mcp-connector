<!-- project-tasks: prefix=OMC lastId=26 -->
# PROJECT TASKS

Updated: 2026-08-15 · Open: 4 (P1: 0) · In progress: 0 · Gate A: 3/4 · Gate B: 1/2

## Roadmap — 2.0

Target: **MCP Apps as the headline, OMC-023 as what earns the major.**
Semver alone would say 1.1.0 — the 45 commits since tag `1.0.1` break nothing. OMC-023 is the
one place in the codebase where the higher number buys something: its entry is blocked on
"a release that is allowed to move the legacy reply", and this is that release.

Out of 2.0: OMC-010 (#416, parked, no client declares Tasks) and #445 (`expectedHash`,
unscheduled, @Madulone may prototype it).

A → B → C → D is dependency order, not calendar order: Gate A is independent of Gate C, and
Gate C is by far the longest piece.

### Gate A — verification debt. Blocks any release, 2.0 or not

- [x] `A1` OMC-024 in a real vault. **Done 2026-08-15 in the Labs vault, behaviour asserted and
      UI observed.** Two tokens driven on different eras: `default` took 3 legacy calls, a second
      token 2 modern ones, and the counters came back `default legacy 26 · modern 0`,
      `ookNoFmFPLPg legacy 0 · modern 2` against a global `legacy 48 · modern 4`. So the two rows
      disagree, and the global exceeds their sum by 22 legacy and 2 modern — that gap is the
      pre-split history belonging to no token, which is the prediction OMC-024 made when it
      refused to attribute it, now measured rather than argued (the 2 orphan modern calls are the
      hand-built probes of 2026-08-09). All five scripted checks green, `sum(byToken) <= global`
      included. **All three `eraLabel()` branches
      (`AccessControlSection.svelte:122-130`) are now drawn**, which the two-token setup alone
      could not do: a follow-up modern call on `default` forced the mixed state and the row
      renders `adaptive 16 tools 2025 · 26 + 2026-07-28 · 1` in full at that pane width, no
      ellipsis and no overlap with the tool count. The rendered string matches what `data.json`
      held, character for character. **Still not exercised:** the pre-existing-vault shape (no
      `eraCountersByToken` key at all) — it edits `data.json`, so it moved to A2's checklist with
      a backup step rather than being run against a live vault mid-verification
- [ ] `A2` `.mcpb` smoke test on Claude Desktop, outstanding since OMC-008. 1.0.1 existed
      because of a bug in exactly this class (#412), so releasing without it repeats the
      same risk. Needs a human at the machine
- [x] `A3` `bun run test:conformance` by hand. **Done 2026-08-15 on `main` at `6c8e182`:
      `Passed: 26/28, 2 failed, 2 warnings`, exit 0, and the four red checks are exactly the
      four in `expected-failures.yml`.** No transport regression from OMC-007 or OMC-024, which
      is what this run existed to rule out. The two FAILUREs are the capability pair, the two
      WARNINGs the list-changed pair; both pairs need a shipped fixture tool this project
      refuses to ship (ADR-0016 Alternative F)
- [x] `A4` Close #407. **Done 2026-08-15, closed as completed.** All three of its Phase 2 open
      problems were verified rather than assumed. The Windows bridge needs nothing:
      `obsidian_mcp_bridge.py` contains zero `_meta` occurrences and negotiates through
      `initialize`, so it classifies legacy on every request; its held-open
      `subscriptions/listen` connection becomes necessary only when the legacy era is retired,
      which ADR-0016 §8 already gates behind a measured trigger that is nowhere near firing
      (`legacy 22 · modern 2`). `search_vault_smart` progress rides the same untouched legacy
      path and stays unverified on the modern era on purpose. The `tools/list` invariant is
      confirmed in writing by ADR-0015 §1, not by assumption. One record correction went with
      the close: #407 claimed the `relatedRequestId` mechanism was "retired" by Phase 2. It was
      not — the legacy era still uses it, and `notify.toolsChanged()` sits alongside it

### Gate B — OMC-023, the only change that requires the major

- [x] `B1` Decide: honour or retract. **Done 2026-08-15 — ADR-0017, and the answer is
      neither of those two.** The choice is three-way once the eras are separated, and
      "honour on both" is architecturally impossible: the legacy transport is POST-only with
      `GET /mcp` at 405 by design, so a vault file event has no request in flight to ride, and
      no deferred-notification queue exists (`flushPendingCalls` is persistence, not a queue).
      Decided: **modern declares `listChanged: true` and honours it, legacy declares `false`.**
      What made it decidable was checking that the prompt set is genuinely dynamic — prompts
      are vault files under `Prompts/`, `vaultWatcher.ts` already watches
      create/delete/rename/modify and invalidates an `epoch` cache in `prompts/index.ts` — so
      `listChanged: true` was a true claim that was never wired, not a false one. SDK facts
      verified by reading `@modelcontextprotocol/server@2.0.0`: `:1550` `?? true` means an
      explicit `false` survives, `:164` gates delivery on that same bit, and
      `notify.promptsChanged()` exists as the exact twin of the `toolsChanged()` OMC-007 wired
      at `mcpServer.ts:137`
- [ ] `B2` Implement ADR-0017 and pin the resulting legacy reply with a test, so whoever reads
      OMC-008's Invariant 1 next sees what superseded it. Shape: the prompts capability becomes
      a parameter of `buildMcpServer` instead of the literal at `mcpServer.ts:188`, an
      `onPromptsChanged` callback fires where the watcher invalidates `epoch`, and one line
      mirrors `mcpServer.ts:137`. **Emit only when the discovered list actually differs from
      the cached one** — the watcher fires on every save, including saves that change neither
      the description nor the argument declarations, and per-tick emission would notify on
      every keystroke-debounced write inside a prompt

### Gate C — OMC-016 / #427, the feature that carries the number

The spike on `spike/427-mcp-apps-ui-resource` already proved Claude Desktop reads and renders
a `ui://` resource from this connector. Hard requirements, already measured: declare
`capabilities.extensions` with `io.modelcontextprotocol/ui` (the generic `resources`
capability alone does nothing), mime type exactly `text/html;profile=mcp-app`, and complete
the `ui/initialize` → `ui/notifications/initialized` handshake or the host leaves the iframe
blank.

- [ ] `C1` A real `resources` capability, not the spike's shortcut
- [ ] `C2` The handshake via `@modelcontextprotocol/ext-apps` instead of hand-rolled
      `postMessage`
- [ ] `C3` `search_vault_smart` / `search_vault_simple` results as a ranked, clickable list
      with score and line anchor. Spec constraint: the tool must keep returning meaningful
      text content for clients without the extension, so adoption is additive per tool and
      cannot fork the surface

### Gate D — the cut

- [ ] `D1` CHANGELOG entry for 2.0, in the user-facing register 1.0.0 and 1.0.1 already use:
      what changes for someone using the plugin, not what changed in the code
- [ ] `D2` Confirm `minAppVersion` stays `1.7.2`. Raising it strands users and nothing in 2.0
      requires it
- [ ] `D3` `bun run version major`. From there `release.yml` does the rest: build, `.mcpb`
      validation, upload of `main.js` + `manifest.json` + `.mcpb`, publish. No PR against
      `obsidian-releases` — the plugin is already in `community-plugins.json` as
      `mcp-tools-istefox`
- [ ] `D4` The Obsidian scanner runs **on the release, never before**. Known constraints that
      have already failed a release: no `eslint-disable` on `obsidianmd/*` rules, and
      non-plugin code stays out of `src/` because the scanner lints `src/**` only
- [ ] `D5` Post-release: tell @smollern (#406), @ottopichlhoefer (#430) and @Madulone (#352)
      that their work is in a release, not just on `main`

## Next — measured gaps, actionable now

- [ ] `OMC-024` **P2** Per-token era counters. **Implemented, not yet verified in a vault** — that check is what closes this. `eraCountersByToken` now sits alongside `eraCounters` in the `mcpTransport` slice, keyed by token id, and each token row in the transport settings says which era it is served on. Additive rather than the migration this entry originally asked for, and the original framing was wrong: the counts already on disk predate the split and belong to no token, so attributing them would invent data and dropping them would damage ADR-0016 §8's trigger, which reads the vault-wide legacy total. `sum(byToken) <= eraCounters` holds by construction. A revoked token's bucket is pruned in the counter's own recipe; an absent or malformed `tokens` key prunes nothing, so a boot that writes before `ensureTokenStore` seeds the list cannot wipe the map. **Remaining**: a real vault with two clients on different tokens, one on 2025 and one on 2026-07-28, showing two rows that disagree while the global row still sums the vault's history; plus a pre-existing vault with no `eraCountersByToken` rendering without breaking <!-- src:session opened:2026-08-09 updated:2026-08-10 -->
- [ ] `OMC-023` **P3** The server advertises a prompts capability it does not honour, on both protocol eras. `mcpServer.ts` declares `prompts: {}`, but `McpServer`'s constructor calls `setPromptRequestHandlers()` for any declared prompts capability (`mcp-DXXb3Vv3.mjs:1351`), which registers `listChanged: … ?? true` (`:1550`) — so the declared set is upgraded before anything reads it. The legacy `initialize` reply and the 2026 `server/discover` result both report `prompts: { listChanged: true }`, and nothing in the codebase ever sends `notifications/prompts/list_changed` (`tools/list_changed` is sent from `activateTool.ts:127`; there is no prompts equivalent). Found during OMC-008 and deliberately not fixed there: declaring `listChanged: false` would change the legacy `initialize` bytes, which that work's Invariant 1 forbids. Either honour it by sending the notification when the prompt set changes, or declare it false in a release that is allowed to move the legacy reply <!-- src:session opened:2026-08-08 -->
- [ ] `OMC-016` **P3** #427 MCP Apps: **answered, it works.** The spike on `spike/427-mcp-apps-ui-resource` proved Claude Desktop reads and renders a `ui://` resource from this connector. What mattered was declaring `capabilities.extensions` with `io.modelcontextprotocol/ui`; the generic `resources` capability alone did nothing. Two hard requirements: mime type exactly `text/html;profile=mcp-app`, and the view must complete the `ui/initialize` → `ui/notifications/initialized` handshake or the host leaves the iframe blank. Real implementation is the remaining work: a proper resources capability, the handshake via `@modelcontextprotocol/ext-apps` (1.7.5 on npm) rather than hand-rolled `postMessage`, then the ranked search list <!-- src:session opened:2026-08-06 updated:2026-08-07 -->

## In Progress

_none_

## Parked — external trigger, nothing to do until it fires

- [ ] `OMC-010` **P3** #416 MCP Tasks: watch item only, no client in the support matrix declares `io.modelcontextprotocol/tasks` yet. The MCP Apps half moved to OMC-016. Re-check the matrix when the tiering page's client matrix moves <!-- src:session opened:2026-08-05 updated:2026-08-07 -->

## Blocked / Decisions Needed

_none_

OMC-007 was the last entry here. It left on 2026-08-10 and closed the same day: what gated it was the `2026-07-28` lifecycle decision, OMC-008 made that decision additive, and the remaining work turned out to be one publish call. Nothing currently waits on a user decision or an external input.

## Standing notes — true until something changes

**Conformance tooling note.** The published CLI (`0.1.16`) has no 2026 scenarios at all — no
`draft` suite, no `server-stateless`. Those live only on the repo's `main` (`0.2.0-alpha.10`) and
must be run from source. Against the published suite we pass every scenario that applies to our
surface; the failures are fixture-dependent (it expects the reference server's `test_*` tools and
`test://` resources) or optional capabilities we chose not to implement: `logging/setLevel`,
`completion/complete` (that is #347, closed as not planned — this is the first visible cost of
that call) and resource subscriptions.

## Superseded premises — kept rather than deleted

Both entries below were wrong in a way that mattered, and both are kept in the form ADR-0016 §8 uses: the falsified claim stays readable next to what replaced it, so the same reasoning does not get re-derived from scratch.

**The `2026-07-28` lifecycle break — resolved by OMC-008, and its central premise was wrong.**
This entry read: *"adopting the revision is a migration that breaks every configured client, not a
capability we add, and it cannot be half-done."* Measured against the shipped implementation, all
three clauses are false. The two eras coexist on one endpoint, chosen per request by whether the
body carries a `_meta` envelope claim, so a claim-less client is served exactly as before. The five
removed-method checks pass **without** retiring `initialize`: the suite only ever probes the modern
era, where the SDK's 2026 wire registry answers `404`/`-32601`, while a legacy client keeps its
handshake. `server-stateless` went 7/27 → 26/28 with no client reconfigured and no `.mcpb`
re-exported. Verified end-to-end against the Labs vault on 2026-08-09, where both eras served
traffic in the same session. See ADR-0016 §8, which records the falsified prediction rather than
deleting it. What it left open was OMC-007, closed on 2026-08-10.

**Correction to how OMC-018 was scoped.** That entry described the suite as wanting `-32602` for a
"malformed `_meta`", as if it were the same size of job as the `-32020`. Reading the checks
themselves (`sep-2575-request-meta-invalid-missing-meta`, `-missing-protocol-version`,
`-missing-client-capabilities`) says otherwise: what the suite calls malformed is `_meta` **absent**
or missing `protocolVersion`/`clientCapabilities`. Requiring those is the 2026 lifecycle itself, so
those three checks belong to OMC-008 and cannot move before it. The `-32602` branch OMC-018 did
ship — `_meta` present but not an object — is ordinary shape validation the suite never exercises.

## Project Map

- **Entry point**: `packages/obsidian-plugin/src/main.ts` · shim `packages/obsidian-plugin/scripts/connectorShim.js`
- **Modules**: `src/features/mcp-transport` (HTTP, tokens, registry) · `src/features/mcp-tools` · `src/features/mcp-client-config` (`.mcpb`, shim source) · `src/features/adaptive-tool-loading` · `src/features/prompts` · `src/features/semantic-search` · `packages/shared`
- **Build & test**: `bun run build` · `bun run release` · test-cmd `bun run check && bun test && bun run format:check`, plus `bun run check:svelte` and `bun run test:mcpb` from `packages/obsidian-plugin`. `bun run test:conformance` is **not** in that gate: it runs nightly from `.github/workflows/conformance.yml`, so a hand run before merging a transport change is the only pre-merge conformance signal there is
- **Key ADRs**: ADR-0013 pure-Node `.mcpb` shim · ADR-0014 per-client tool profiles · ADR-0015 `tools/list` stability invariant · ADR-0010 split registry disable states · ADR-0016 two protocol eras on one endpoint · ADR-0017 `prompts.listChanged` split by era
- **Invariants**: transport is stateless and POST-only, `GET /mcp` is 405 by design · one endpoint serves both protocol eras, classified per request off a single body read, and a body carrying no `_meta` envelope claim is legacy · every settings write goes through `SettingsStore.updateSlice` under the process-wide mutex · a bearer token string never changes silently · the shim fails closed on an unknown token id · a polymorphic tool never declares an `outputSchema`

## Done

- [x] `OMC-026` #444 six boolean-shaped tool arguments across five tools rejected a genuine JSON boolean. `coerceBooleanParams` (`toolRegistry.ts:504-540`) repairs one direction only — a `"true"`/`"false"` string arriving where the ArkType schema says `"boolean"` — and these six declared the mirror shape, `type('"true" | "false"')`, which the guard never matches, so a real boolean reached `schema.assert()` uncoerced and threw. Retyped all six as `type("boolean")`, which covers both directions at once: a boolean validates directly, a string is coerced by the guard that now matches. `coerceBooleanParams` itself untouched — it was correct for what it claimed; the schemas were wrong. Root-caused by @smollern in discussion #406, who found it on `search_and_replace.dry_run`; reading the codebase turned one field into six, including `delete_vault_directory.recursive`, the destructive one. The four handler-level test files could not have caught this: they call handlers directly, below the registry, so they never traverse the coercion seam — hence the new `dispatch()` block in `toolRegistry.test.ts`, which is the only place that seam is exercised. Mutation-checked: reverting the fixture schema to the literal union turns 2 of the 4 new tests red. Defaults are not uniform across the six (`dry_run`/`includeNested`/`includeEmbeds`/`get_outgoing_links.includeUnresolved` default true, `recursive`/`get_backlinks.includeUnresolved` default false) and each was preserved individually. `inputSchema` is served fresh in every `tools/list`, so no client or `.mcpb` needs re-exporting, and an agent that memorised the string form keeps working through coercion — but the wire schema does change, so it earns a release-note line (2026-08-14)
- [x] `OMC-025` #430 `search_vault_smart` returned `{"results":[]}` for every query under `provider: "auto"` (the default), silently, whenever Smart Connections was installed. `wireSemanticSearch` cached the chooser's decision synchronously during `onload()`, before `this.smartSearch` was ever assigned — `isSmartConnectionsAvailable` always read `undefined` at selection time, so `"auto"` could never pick Smart Connections no matter how fast it loaded. Fixed by re-running the chooser once the binding actually lands: `refreshAutoProvider` (`semantic-search/index.ts`), called from `main.ts`'s existing `loadSmartSearchAPI` subscription. Not a bare re-run of the existing `state.chooser(state.settings)` pattern already used in two other places (`applySettings` on a settings change, `startRebuildFor`'s completion handler) — gated on `settings.provider === "auto"` specifically, because a bare call would have clobbered the DLC pending-provider guard for `embedding-gemma`/`multilingual-e5-base` (their chooser branches build against the DLC store regardless of readiness, and `NativeProviderImpl.isReady()` is unconditionally `true`). Confirmed the fix is real, not decorative: disabling the function's body flipped the new swap-identity test red while the other 17 stayed green. Deployed and verified in the Labs vault — `search_vault_smart` under `auto` now returns real Smart Connections results without any settings toggle needed to "unstick" it (2026-08-11)
- [x] `OMC-007` #419 cross-client `tools/list` staleness. An auto-promotion is a vault-wide change (ADR-0014 keeps counters global), so one client's traffic widens every adaptive token's list; a client that made no request of its own was never told and kept serving a stale list. `ToolLoadingManager` now signals a PERSISTED widening and `mcpServer.ts` publishes it through the 2026-era handler's `notify.toolsChanged()`, which the SDK's listen router fans out to every open `subscriptions/listen` stream that opted in. Signalled per widening, never per flush: past the threshold the counter stays past it, so signalling on the branch would have emitted a notification on every call, forever — there is a test pinning exactly that. Verified end to end with two concurrent streams on one service, one opted in and one not, and confirmed red with the wiring removed. **The prediction this entry carried was wrong**: the two conformance checks did NOT move. They drive fixture tools (`test_trigger_tool_change`, `test_trigger_prompt_change`) we refuse to ship for ADR-0016 Alternative F's reason, so nothing mutates the list inside their window and the delivery path is never exercised — same class as the two `test_missing_capability` entries. Baseline stays at four, `server-stateless` stays 26/28. Nothing a shipping client can observe yet either: no client speaks `2026-07-28` (Labs vault, 2026-08-09: `legacy 22 · modern 2`, and the two were hand-built probes) (2026-08-10)

- [x] `OMC-008` #407 adopt MCP spec `2026-07-28` as an additive second era (ADR-0016). Two eras on one endpoint, classified per request off a single body read; the legacy path is unchanged and no configured client or distributed `.mcpb` needed touching. `server-stateless` 7/27 → 26/28, baseline down to four entries. Conformance harness now in-repo under `scripts/conformance/`, run nightly by `.github/workflows/conformance.yml`, never per PR. Per-era request counters ship in the transport settings; `legacy: 'reject'` stays a future decision with a trigger. Merged as PR #439 (`88443d4`) on 2026-08-09. Follow-ups: OMC-023, OMC-024 (2026-08-09)
- [x] `OMC-022` Closed by OMC-008, which delivered all three missing pieces at once: the harness moved out of a scratchpad into `packages/obsidian-plugin/scripts/conformance/`, `run.sh` builds the suite from source at a pinned ref (`81eb1c3`, `0.2.0-alpha.10`), and `expected-failures.yml` makes the job a gate rather than a report — it exits non-zero the moment a failure appears that the baseline does not name. It is a **nightly** job (`.github/workflows/conformance.yml`, `schedule` + `workflow_dispatch`), never per PR: cloning and building the suite is Actions spend, so a hand run of `bun run test:conformance` before merging a transport change stays a discipline rather than an enforcement. Proven on a clean Linux runner by a `workflow_dispatch` on `main` — 26/28, baseline satisfied, exit 0, with the log showing the clone and `npm ci` actually ran rather than the step short-circuiting (2026-08-09)
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
