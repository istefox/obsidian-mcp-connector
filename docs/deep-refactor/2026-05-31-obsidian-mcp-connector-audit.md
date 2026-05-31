# deep-refactor audit — obsidian-mcp-connector — 2026-05-31

## Summary

- Baseline: PASS=1072 FAIL=0
- Post-fix: PASS=1072 FAIL=0
- Dimensions completed: dead-code, perf
- Dimensions skipped: structure (0 routable findings — all high-risk or report-only)
- Fixed: 9 findings
- Skipped in fix loop: 3 (1 correct skip — finding was not dead; 2 blocked by refactorer snapshot harness due to bun timing footer non-determinism — tests were GREEN)
- Deferred (report-only / high-risk): 14
- Regressions caught: 0
- Source files scanned: 297
- Audit dispatch: sequential mode (hook_verified not set)

---

## Per-dimension findings

### dead-code

- **P2** `main.ts:4` — Unused `LocalRestAPI` and `Templater` value imports from "shared"; only `SmartConnections` type is used.
  Status: Fixed by coder agent — replaced with `import { type SmartConnections } from "shared"`

- **P2** `shared/index.ts:278` — Exported `loadDependenciesArray` referenced nowhere in the monorepo.
  Status: Fixed by refactorer agent — removed the 4-line function; `map` rxjs import retained (still used)

- **P2** `mcp-transport/types.ts:3` — Entire module appears dead: `BearerToken`, `PortNumber`, `ServerState` have zero references across the monorepo. Likely orphaned by the in-process HTTP pivot.
  Status: Deferred — high-risk (runtime arktype schemas; confirm no MCP/REST handler depends on the contract before removing)
  Suggested fix: Confirm transport/server-state handling no longer needs these, then remove the module and its re-export in `mcp-transport/index.ts:7`.

- **P2** `shared/src/types/smart-search.ts:18` — Module exports `jsonSearchRequest`, `SearchResponse`, `searchParameters` — all unreferenced in the monorepo. Likely leftover semantic-search HTTP contract from the pre-standalone architecture.
  Status: Deferred — high-risk (part of published `shared` types surface; confirm no external consumer)
  Suggested fix: Remove the module and its barrel re-export in `shared/src/types/index.ts`.

- **P3** `main.ts:1` — Unused `import { type } from "arktype"` (TypeScript `type` keyword uses are unrelated).
  Status: Fixed by coder agent — removed the import line

- **P3** `findOrphanedNotes.ts:2` — Unused `TFile` type import; only `App` is used.
  Status: Fixed by coder agent

- **P3** `embedder.ts:223` — Unused `import { logger } from "$/shared/logger"`.
  Status: Fixed by coder agent

- **P3** `indexer.ts:25` — Unused `Chunk` type in `import type { Chunk, ChunkerFn }`; only `ChunkerFn` is used.
  Status: Fixed by coder agent

- **P3** `nodeDetect.ts:205` — Unused first parameter `m` in `.replace((m, ext) => ...)`.
  Status: Fixed by coder agent — renamed to `_m`

- **P3** `shared/index.ts:1` — Suspected unused `Plugin` import.
  Status: Skipped (correct) — `Plugin` IS referenced in the `declare module "obsidian"` augmentation at line 33 (`{ env?: SmartConnections.SmartSearch } & Plugin`). Import is required.

- **P3** `mcp-transport/index.ts:7` — Dead re-export `export * from "./types"` (paired with the dead types.ts module above).
  Status: Deferred — high-risk (paired change with types.ts removal above)
  Suggested fix: Remove together with `mcp-transport/types.ts`.

### perf

- **P1** `indexer.ts:379` — `processOnePath` iterates the entire store via `store.scan()` for every single file processed (O(N×M) over vault size during full re-index).
  Status: Deferred — high-risk (touches async scan() iteration + indexer flow)
  Suggested fix: Add per-filePath lookup to EmbeddingStore (e.g. `recordsFor(path)` backed by a `Map<filePath, Set<chunkId>>`) so reuse-by-hash is O(chunks-in-file).

- **P2** `store.ts:222` — `delete(filePath)` scans the full records Map linearly; no secondary index from filePath to chunkIds.
  Status: Deferred — high-risk (touches async store contract)
  Suggested fix: Maintain `Map<filePath, Set<chunkId>>` alongside `records`, updated in upsert/delete.

- **P2** `listPropertyValues.ts:63` — Sort comparator calls `JSON.stringify(a.value)` and `JSON.stringify(b.value)` on every comparison — O(n log n) redundant serializations.
  Status: Fixed by coder agent — cached the serialized key in each counts entry; comparator sorts on the cached key; output shape preserved.

- **P2** `searchAndReplace.ts:135` — Regex run multiple times per file: once for count, per-line for preview, again for apply.
  Status: Skipped — refactorer snapshot harness blocked (bun emits non-deterministic wall-clock timing in stdout; tests were GREEN 1072/0). Suggested fix still valid: single `matchAll` pass to derive count + first-5 line previews; reuse replace output for apply path.

- **P3** `chunker.ts:169` — `hasOversizedCodeFence` calls `countTokens` on every fence; redundant on large code-heavy notes.
  Status: Skipped — refactorer snapshot harness blocked (same bun timing-footer issue). Suggested fix: byte-length early-exit heuristic (`fenceText.length <= maxTokens`) before `countTokens`.

- **P3** `chunker.ts:219` — Per-token `/\S/.test()` in `slidingWindows`; redundant given `split(/(\\s+)/)` alternation.
  Status: Fixed by coder agent — replaced with `(tokens[i] ?? "").trim().length > 0`; 17/17 chunker tests pass.

- **P3** `nativeProvider.ts:71` — Full O(n log n) sort to take top-`limit` results; `matchesFolders` recomputes folder prefix on every record.
  Status: Deferred — high-risk (touches async store.scan() search path)
  Suggested fix: Precompute normalized folder prefixes before the scan loop; replace full sort with a bounded min-heap of size `limit`.

### structure

- **P1** `main.ts:322` — `onload()` spans ~410 lines mixing MCP transport setup, full semantic-search wiring (vault/excerpt adapters, stale-index detection, registry construction, provider creation, indexer/rebuild hooks, language detection), migration setup, and LRA/Smart Connections binding.
  Status: Deferred — high-risk (refactorer; coordinates across multiple features)
  Suggested fix: Extract semantic-search wiring (lines 352-651) into `setupSemanticSearchWiring(plugin)` under `features/semantic-search`; leave `onload` as a thin orchestrator.

- **P2** `patchHelpers.ts:596` — `applyPatch()` spans ~275 lines handling three independent target-type branches (frontmatter, heading, block) in one function body.
  Status: Deferred — high-risk (refactorer; central patch dispatch used by multiple tools)
  Suggested fix: Split into `applyFrontmatterPatch`, `applyHeadingPatch`, `applyBlockPatch` with `applyPatch` as a thin dispatcher; mechanical extraction, no behavior change.

- **P2** `CommandPermissionsSettings.svelte:1` — 1088-line component combining data load/persist logic, command-registry scraping, allowlist mutation, preset merging, CSV import/export, audit-log export, and five distinct UI sections.
  Status: Deferred — high-risk (refactorer; large Svelte component with interleaved state)
  Suggested fix: Extract five sections into child components; move load/save orchestration into a helper module.

- **P3** `chunker.ts:1` — 418 lines, marginally over the 400-line threshold; well-decomposed into 11 small functions.
  Status: Deferred — report-only (no real structural problem; flag if the file grows further)

---

## Security findings

- **P3** `main.ts:126` — `getLocalRestApiUrl()` builds a request URL by string-interpolating `bindingHost` and `port` from the Local REST API plugin settings with no loopback validation. If LRA settings are tampered, this could become SSRF leaking a bearer token.
  ACTION REQUIRED — not auto-fixed
  Suggested remediation: Validate host against a loopback allowlist (127.0.0.1 / localhost / ::1) before building the URL.

- **P3** `getVaultFile.ts:111` (and all path-taking tools) — Client-controlled `path` passed directly to `vault.getAbstractFileByPath` with no rejection of `..` traversal segments or absolute paths. Applies to `createVaultFile`, `renameVaultFile`, `deleteVaultFile`, `executeTemplate`, and others.
  ACTION REQUIRED — not auto-fixed
  Suggested remediation: Add a shared `validateVaultPath()` rejecting leading `/`, `..` segments, and null bytes; call it at the top of every path-taking tool handler.

- **P3** `createVaultFile.ts:49` — Client-controlled `path` flows into `vault.create` and `ensureParentFolderExists` with no `..` / absolute-path rejection (same class as above).
  ACTION REQUIRED — not auto-fixed
  Suggested remediation: Reject paths containing `..` segments or a leading separator before `vault.create`.

- **P3** `executeTemplate.ts:133` — `execute_template` runs a Templater template (including arbitrary JS) selected by a client-controlled `templatePath`, with no opt-in gate equivalent to the command-permissions allow-by-default policy.
  ACTION REQUIRED — not auto-fixed
  Suggested remediation: Gate `execute_template` behind the same opt-in/allowlist policy as `execute_obsidian_command`, or restrict it to a designated templates folder.

---

## Deferred findings (not auto-fixed)

| ID | File | Reason |
|---|---|---|
| dead-code-types.ts-c9e | `mcp-transport/types.ts:3` | risk_level: high — confirm no runtime consumer before deleting |
| dead-code-index.ts-d1f | `mcp-transport/index.ts:7` | risk_level: high — paired with types.ts removal |
| dead-code-smart-search.ts-e2a | `shared/src/types/smart-search.ts:18` | risk_level: high — published types surface |
| perf-indexer-a1f | `indexer.ts:379` | risk_level: high — async scan() coordination |
| perf-store-b7c | `store.ts:222` | risk_level: high — async store contract |
| perf-nativeProv-a8e | `nativeProvider.ts:71` | risk_level: high — async store.scan() search path |
| perf-searchRepl-d9a | `searchAndReplace.ts:135` | blocked: refactorer snapshot harness (bun timing footer) |
| perf-chunker-e4b | `chunker.ts:169` | blocked: refactorer snapshot harness (bun timing footer) |
| structure-main-a1c | `main.ts:322` | risk_level: high — multi-feature extraction |
| structure-patchHelpers-b7e | `patchHelpers.ts:596` | risk_level: high — central dispatch |
| structure-CommandPermissionsSettings-c4d | `CommandPermissionsSettings.svelte:1` | risk_level: high — large Svelte component |
| structure-chunker-e2f | `chunker.ts:1` | fix_type: report-only |
| security-* (×4) | see Security section | fix_type: report-only (all security findings) |

### Note on snapshot-blocked perf findings

The two skipped `refactorer` perf findings (`perf-searchRepl-d9a`, `perf-chunker-e4b`) were blocked because `bun test` emits a non-deterministic wall-clock duration string (`[NNN.00ms]`) in stdout, which the refactorer's snapshot harness cannot distinguish from a behavioral change. The test suite itself was GREEN (1072/0) at every check. To unblock, create `.claude/refactor-snapshot-override` or pipe `bun test` output through a filter that strips the timing line in `.claude/test-cmd` (note: `.claude/test-cmd` is read-only for agents).
