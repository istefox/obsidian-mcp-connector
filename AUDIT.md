# Full Codebase Audit — post-0.15.1

Date: 2026-06-11. Scope: packages/obsidian-plugin (210 source files), packages/shared (10 source files). Method: three independent read-only analysis passes (dead code, redundancy, bug hunt), critical claims verified by direct file reads before inclusion.

## Phase 1 — Baseline

| Check | Result |
|---|---|
| `bun run check` | 0 errors (shared + obsidian-plugin) |
| `bun test` | 1142 pass / 0 fail, 2501 assertions, 92 files |
| Tools registered | 43 + 2 meta-tools (tool_catalog, activate_tool) |

Known test gap: `features/mcp-tools/tools/activateTool.ts` has no dedicated test file (covered only indirectly via mcpServer.test.ts).

## Phase 2 — Dead code

| Finding | Location | Confidence |
|---|---|---|
| `loadTemplaterAPI` unused export | `src/shared/index.ts:191` | High |
| `loadDependencies` unused export | `src/shared/index.ts:209` | High |
| `express` unused dependency | `packages/obsidian-plugin/package.json` | High |
| `fs-extra` unused dependency | `packages/obsidian-plugin/package.json` | High |
| `semver` unused dependency | `packages/obsidian-plugin/package.json` | High |
| `radash` unused dependency | `packages/obsidian-plugin/package.json` | High |

Verified not dead (false-positive guards applied): string-based tool registration, arktype schema lookups, Obsidian command/event registrations, esbuild entry points, test-setup.ts mocks. `packages/shared/src/types/plugin-local-rest-api.ts` is a test-only fixture from the pre-0.13.0 architecture, intentionally kept. `onnxruntime-web` is used indirectly via bun.config.ts plugin redirects. No unreachable branches, commented-out blocks, or orphaned settings fields found.

## Phase 3 — Redundancy

| Pattern | Count | Representative locations | Feasibility |
|---|---|---|---|
| `PluginLike` local type definitions | 6 | `toolLoadingManager.ts:15` (exported base), `activateTool.ts:21`, `preWarm.ts:67` (exact copies), `toolCatalog.ts`, `tool-toggle/applyFilter.ts` (read-only subsets), `autoWrite.ts` (extended) | Trivial |
| `RegistryLike` local type definitions | 4 | `activateTool.ts:17` = `toolCatalog.ts:17` (identical), `applyAdaptiveFilter.ts:4`, `applyFilter.ts:22` (different shapes) | Moderate |
| Error/success response builders | ~12 files | plain-text vs JSON-errorCode variants; `getVaultFilePartial.ts:48-72` already has helper pattern | Trivial |
| `getAbstractFileByPath` + `instanceof TFile` + error response | 14 files | `getVaultFile.ts:111`, `patchVaultFile.ts:54`, `getNoteProperty.ts:27` | Moderate, deferred |
| loadData/saveData merge sites | 5+ | `toolLoadingManager.ts:75`, `autoWrite.ts:89`, `preWarm.ts:103` | See Phase 4 finding 1 |

Heading/block utilities in `patchHelpers.ts` are already well-factored and shared; no action needed.

## Phase 4 — Bug hunt

### Finding 1 — MAJOR (bug): ToolLoadingManager bypasses globalSettingsMutex

`settingsLock.ts` documents that every `data.json` load→modify→save site must serialize through `globalSettingsMutex` to prevent cross-feature lost updates. `recordCall`, `activateTool`, `deactivateTool`, `resetAll` in `toolLoadingManager.ts` do raw read-modify-write. The fire-and-forget call site is `mcpServer.ts` (recordCall on every tools/call). Two concurrent tool calls, or a tool call racing any settings write, can silently lose counter increments, promotions, or another feature's entire slice.

Fix: Batch 1.

### Finding 2 — MEDIUM (doc mismatch): persist=false wording

The registry is created once at plugin load (`setup.ts` → `createMcpService`), so a `persist=false` activation survives MCP client reconnects and lasts until plugin reload. The response text says "for this session", which under-states the lifetime. Fix: Batch 3 (wording + dedicated tests).

### Verified ok-by-design (disclosures, no action)

| Item | Location | Rationale |
|---|---|---|
| Swallowed notification errors on stateless transport | `activateTool.ts` | Commented; reconnect message covers it |
| Empty catch blocks (8 sites) | main.ts, embedder.ts, indexer.ts, mcpServer.ts | All have inline rationale comments |
| Middleware check order (405 before 401) | `middleware.ts` | Loopback-only server, no network attacker model |
| No path-traversal filtering in file tools | tools/* | Obsidian vault API is the trust boundary |
| async onunload not awaited | `main.ts` | Obsidian API limitation, documented eslint pragma |
| No OPTIONS/preflight handler | `httpServer.ts` | MCP clients don't preflight; loopback-only |

Resource cleanup (indexer timers, vault event refs, HTTP server shutdown) verified correct.

## Phase 5 — Simplification

No high-value targets beyond the consolidations in Phase 3. The 14-file `ensureFile` helper extraction is deferred: it would touch many tested-but-behavior-sensitive error paths for modest gain. Re-evaluate after Batch 5.

## Fix plan

| Batch | Content | Risk |
|---|---|---|
| 1 | Wrap ToolLoadingManager mutations in globalSettingsMutex + concurrency regression test | Low |
| 2 | Remove 4 unused deps + 2 unused exports | Low |
| 3 | persist=false wording fix + activateTool.test.ts | Low |
| 4 | Consolidate PluginLike/RegistryLike duplicates | Low |
| 5 | Shared responseBuilders.ts, error strings byte-identical | Moderate |

Each batch: own branch, own PR, `bun run check` clean and ≥1142 tests green before merge. No behavior change bundled with a refactor in the same commit.
