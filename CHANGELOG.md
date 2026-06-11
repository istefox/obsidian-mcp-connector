# Changelog

All notable changes to **MCP Connector** (formerly `obsidian-mcp-tools`) are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [Semantic Versioning](https://semver.org/).

## [0.15.6] — 2026-06-11

### Changed

- **Dependency vulnerability advisories: 3 → 0.** Root overrides force `path-to-regexp` ^8.4.2 and `qs` ^6.15.2, the patched releases of the two transitives that `@modelcontextprotocol/sdk` 1.29.0 still pins inside vulnerable ranges. Removed the orphaned `svelte@5.18.0` patch (no longer applied after the svelte bump; redundant since the bundler forces the browser export condition). (PR #267)

## [0.15.5] — 2026-06-11

### Fixed

- **Scanner warnings in test bootstrap resolved.** `test-setup.ts` no longer uses `globalThis` (replaced with `global`/`window`), no longer casts to `TFile`/`TFolder` (type-aliased mock/API boundary), and `moment` is now declared in devDependencies. (PR #264)

### Changed

- **Dependency vulnerability advisories: 34 → 3.** Removed orphaned `@typescript-eslint/*` 5.29.0 devDependencies (no eslint config exists in the repo); bumped `svelte` to ^5.56.3, `svelte-preprocess` to ^6.0.5, `archiver` to ^8.0.0 (zip script migrated to the new `ZipArchive` API). The 3 remaining advisories come via `@modelcontextprotocol/sdk` 1.29.0 (latest, no upstream fix yet). (PR #265)

## [0.15.4] — 2026-06-11

### Changed

- **README documents adaptive tool loading.** New section covering the three profiles (All/Core/Adaptive), the `tool_catalog` and `activate_tool` meta-tools with current semantics (immediate activation, `persist` parameter, Obsidian notice, `activate_tool` excluded from Core), frequency promotion, and the typical adaptive flow. Stale tool counts fixed and missing footnote added. (PR #262)

## [0.15.3] — 2026-06-11

### Fixed

- **Plugin review scanner warnings resolved in plugin source.** `Moment` type now derives from Obsidian's bundled `moment` export instead of importing the restricted `moment` package; four remaining `as TFile` casts replaced with `instanceof TFile` guards (`renameHeading`, `getOrCreateDailyNote`); unused `_` destructuring binding removed (`patchVaultFile`). Remaining scanner items are bundled third-party code or documented intrinsic capabilities — see `AUDIT.md`. (PR #260)

## [0.15.2] — 2026-06-11

### Fixed

- **`activate_tool` activation is now immediate on both persist paths.** With `persist=true` the tool was written to `data.json` but not enabled in the live registry, and the response told the user to reconnect — which had no effect, since the registry is built once at plugin load. Both paths now enable the tool in the registry immediately; `persist` only controls whether the promotion also survives plugin reloads. Response and schema wording corrected accordingly ("until the plugin reloads" instead of "this session"). Dedicated test file added for the handler. (AUDIT.md Phase 4 Finding 2)
- **Adaptive tool loading state writes serialize through the settings mutex.** Counter increments and promotions could be lost when two tool calls raced each other or another feature's settings write. (AUDIT.md Phase 4 Finding 1)

### Changed

- **Codebase audit cleanup.** Removed unused dependencies (`express`, `radash`, `semver`), moved `fs-extra` to devDependencies, deleted dead exports from `shared/index.ts`, consolidated duplicate `PluginLike`/`RegistryLike` type definitions, extracted shared MCP response builders (`errorText`/`errorJson`/`successText`/`successJson`). No behavior changes; response payloads byte-identical. Full report in `AUDIT.md`. (PRs #252–#257)

## [0.15.1] — 2026-06-09

### Fixed

- **`activate_tool` trust model: three improvements.** Core profile users no longer see `activate_tool` in the active tool set (`tool_catalog` remains always active). Adaptive and All profiles are unchanged. When `activate_tool` promotes a tool, Obsidian now shows a Notice: `MCP Connector: "<tool_name>" promoted to active`. Added `persist` boolean parameter (default `false`): with `persist=false` the tool is enabled immediately in the current session only with no `data.json` write; with `persist=true` the promotion is saved and survives reconnects (previous behavior). (PR #248, #249, #250, closes #247)

## [0.15.0] — 2026-06-09

### Changed

- **Semantic search honours `Files & Links → Excluded files`.** The embedding indexer now skips files the user has excluded via Obsidian's exclusion setting (`MetadataCache.isUserIgnored`), matching the behaviour already established by `get_recent_files`. The filter applies in **both** the full rebuild path and the live vault-event listener, so a file in an excluded folder neither enters the index on a rebuild nor re-enters it when edited. Existing chunks indexed before a folder was excluded are left in place (no destructive purge on a settings change) and filtered out of `search_vault_smart` results at query time; physical cleanup happens on the next manual Rebuild. No new setting or UI. (RFC #238, option A + D3, PR #244 by @marcoaperez)

### Fixed

- **Type-safe frontmatter and cache iterator casts.** `processFrontMatter` callback parameters and `MetadataCache.frontmatter` accesses are now cast to `Record<string, unknown>` at the point of use; `Map.keys().next().value` in the embedder LRU cache is annotated as `string | undefined`; `JSON.parse` return in the test mock is cast to `unknown`. Reduces Obsidian plugin review scanner warning count with no behaviour change.

## [0.14.2] — 2026-06-09

### Fixed

- **Obsidian plugin review scanner: zero Errors.** Resolved two blocker Errors that were preventing store review: removed bare `eslint-disable` directives flagged as policy violations; replaced them with typed casts (`as unknown as { on: ... }`) so the vault event subscription compiles cleanly. Reduced Warning count: replaced all bare `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` calls with `window.*` equivalents across `main.ts`, `fetch.ts`, `embedder.ts`, and `indexer.ts` for popout-window compatibility; replaced 20+ `as TFile` casts with `instanceof TFile` guards across the tools layer; narrowed `any`-typed frontmatter values and regex callback results with explicit casts. No behaviour changes.

## [0.14.1] — 2026-06-08

### Fixed

- **Removed `fs` module import from node detection.** `existsSync` was used as a path pre-filter before spawning candidate binaries. The spawning loops already handle `ENOENT` via a catch block, so the check was redundant. Dropping the import eliminates the Direct Filesystem Access warning in the Obsidian plugin store scanner. The `pathExists` option in `detectNode`/`detectBrew` is kept for test injection. (commit a53d107)

## [0.14.0] — 2026-06-08

### Added

- **Adaptive tool loading: profile selector, `tool_catalog`, and `activate_tool`.** The plugin exposes all 43 tools by default (no change from prior behavior). A new profile selector in settings lets you reduce the per-session token cost. Three profiles: **All** (default, unchanged), **Core** (13 essential tools always active), **Adaptive** (Core plus frequency-promoted tools). Two meta-tools are always active regardless of profile: `tool_catalog` returns the full inventory with active/inactive/promoted status and call count; `activate_tool` promotes an inactive tool to `data.json` and emits `notifications/tools/list_changed`. In Adaptive mode, tools called 3 or more times auto-promote on the next connect. (PR #239, closes #235)

## [0.13.1] — 2026-06-03

### Fixed

- **`search_vault_smart` excerpt quality improved.** The `excerpt` field no longer duplicates the `heading` (which is already a separate result key). Maximum length raised from 200 to 500 characters. Truncation now breaks at a word boundary and appends `...` instead of cutting mid-character. (PR #236, proposed by @folotp)

## [0.13.0] — 2026-06-01

### Added

- **`execute_template` falls back to the core Templates plugin when Templater is absent.** Vaults that use Obsidian's built-in Templates plugin instead of the Templater community plugin now get `{{title}}`, `{{date}}`, and `{{time}}` substitution out of the box, using the formats configured in Templates settings. The `arguments` map is Templater-specific and is ignored on this path (a `warning` field is included in the response). When neither engine is available the error reads "No template engine found." (PR #233)

### Changed

- **`execute_template` now returns structured JSON error codes** matching the pattern used by `execute_dataview_query`. MCP clients and LLM agents can branch on `errorCode` without parsing text: `templater_not_installed`, `template_not_found`, `template_execution_failed`, `core_templates_execution_failed`. (PR #232)
- **`search_vault` is now fully in-process.** The DQL path delegates to the Dataview plugin API directly (`app.plugins.plugins.dataview.api.query`) — same engine as `execute_dataview_query`. The JsonLogic path iterates the vault via `MetadataCache` with `json-logic-js`. No Local REST API plugin required. **Breaking:** the DQL response format changes from the Local REST API envelope to the native Dataview result shape (`{type, headers, values}` for TABLE, etc.). (PR #227)
- **Removed 0.3.x binary compat shim** (`POST /templates/execute` route). Users still on the pre-0.4.0 standalone binary should upgrade to the current plugin version.

### Security

- **Removed `obsidian-local-rest-api` dependency, eliminating all associated CVEs** (`node-forge` GHSA-554w-wpv2-vw27 / GHSA-5gfm-wpxj-wjgq / GHSA-65ch-62r8-g69g / GHSA-2328-f5f3-gj25 / GHSA-q67f-28xg-22rw / GHSA-5m6q-g25r-mvwx / GHSA-ppp5-5v6c-4jwp, `uuid` GHSA-w5hq-g745-h8pq, `on-headers` GHSA-76c9-3jph-rj3q, `minimatch` multiple ranges). (PR #227)

### Fixed

- **Cleaned up stale `obsidian-daily-notes-interface` type declarations.** Added a `declare module` augmentation in `src/types.ts` for the weekly, monthly, quarterly, and yearly functions that the library exports at runtime but omits from its `.d.ts`. Removed the local `PeriodicNotesLibRuntime` cast from `periodicNotesDetector.ts`. (PR #231)

## [0.12.0] — 2026-05-31

### Added

- **EmbeddingGemma 300M unlocks full 2K-token context on WebGPU.** Previously capped at 512 tokens on all backends due to a SafeInt overflow in `onnxruntime-web@1.26.0` WASM (upstream: microsoft/onnxruntime#28726). The WebGPU execution provider bypasses the WASM integer math path entirely, so EmbeddingGemma now uses its full 2048-token window on Apple Silicon and any platform with a WebGPU adapter. The WASM path stays at 512. The chunker is now provider-driven: `makeChunkerForProvider` reads `provider.getMaxInputTokens()` at embed time so chunk size tracks the active backend automatically. (PR #208)

### Changed

- **FORMAT_VERSION 3 → 4.** Chunk boundaries shift when the provider-driven chunker replaces the hardcoded 512-token cap, invalidating stored `contentHash` values for v3 indexes. Index migration is now silent: the previous `IndexWipeMigrationModal` blocked indefinitely during Obsidian's "Loading plugins..." splash; the wipe now runs immediately and a Notice appears after `onLayoutReady`. (PR #208)
- **Rebuild deferred to `onLayoutReady`.** `vault.getMarkdownFiles()` returns an empty snapshot during `onload()` while Obsidian's vault scan is still in flight; triggering a rebuild there silently produced a 0-chunk store. All post-migration rebuild triggers now defer to `onLayoutReady`. (PR #208)

### Fixed

- **Live DLC index updates now persist to disk.** `LiveIndexerImpl` mutated the in-memory store on each vault event but never called `store.flush()`, losing all changes on restart. A debounced 5-second flush now runs after each processed file; bursts coalesce into one write, and `stop()` / `flush()` always drain any pending flush before returning. (PR #219)
- **DLC indexers now stay subscribed to vault events.** `startRebuildFor` previously created a `LiveIndexer`, ran `rebuildAll()`, and dropped the reference — vault events between rebuilds were silently lost. DLC indexers are now persistent across the plugin lifecycle, auto-subscribed at plugin load for the active provider when its store has content, and stopped cleanly on plugin unload. (PR #219)

## [0.11.2] — 2026-05-31

### Fixed

- CI lockfile mismatch after `packages/test-site` removal. (PR #215)

## [0.11.1] — 2026-05-31

### Changed

- **Indexer rebuild is now linear instead of quadratic.** `processOnePath` previously
  walked the entire embedding store on every file processed during a full re-index
  (O(N×M) over vault size). A secondary `Map<filePath, Set<chunkId>>` index now
  makes per-file lookup O(chunks-in-file). `delete(filePath)` gets the same speedup.
  Large vaults with many files will see noticeably faster rebuild times. (PR #211)

### Removed

- Unused imports and a dead export removed across six source files (no behavior change). (PR #210)

## [0.11.0] — 2026-05-30

### Added

- **WebGPU acceleration for DLC embedding providers.** EmbeddingGemma 300M and
  MultilinguaE5-base now run on the WebGPU execution provider (Apple Silicon Metal,
  and any platform with a WebGPU adapter) when `navigator.gpu.requestAdapter()`
  returns a non-null adapter. The probe runs once at startup and is cached; the
  correct ONNX environment is selected atomically before the first pipeline call.
  WebGPU inference bypasses the WASM runtime entirely, which also sidesteps the
  SafeInt overflow in `onnxruntime-web@1.26.0` WASM for 768-dim models.
  On machines without WebGPU, providers fall back to CPU with `dtype: "q8"` to
  avoid WASM OOM (previously MultilinguaE5-base fp32 triggered `std::bad_alloc`).
  (PR #205, PR #206, ADR-0007)

- **Transformers.js v4 upgrade.** Replaces `@xenova/transformers@2.17.2` with
  `@huggingface/transformers@4.2.0` and pins `onnxruntime-web` to
  `1.26.0-dev.20260416-b7804b056c` (first build with ONNX IR v10 support).
  EmbeddingGemma 300M and MultilinguaE5-base previously failed silently on
  0.10.x because the bundled `onnxruntime-web` capped at IR v8. (ADR-0007, PR #205)

### Changed

- **FORMAT_VERSION 2 → 3.** Indexes built with the Xenova runtime are incompatible
  with the HuggingFace v4 runtime. Upgrading triggers an `IndexWipeMigrationModal`
  that prompts before wiping stale indexes. "Rebuild now" immediately starts the
  download and rebuild for the active provider, with no manual Settings navigation required.
  Escape and overlay-dismiss dismiss the modal without hanging startup.

### Fixed

- **`import.meta` patterns in the bundle (B1).** `Object(import.meta).url` and
  `typeof import.meta` (emitted by `@huggingface/transformers` v4) were not caught
  by Bun's `define` token-replacement and caused `SyntaxError: Cannot use
  'import.meta' outside a module` on plugin load. A post-build step in
  `bun.config.ts` replaces both patterns and asserts at least one occurrence each;
  the build fails loudly if upstream changes the emit.

- **OrtRun SafeInt overflow on large vaults (B2).** Whitespace-based chunking
  underestimates BPE token count for code, URLs, camelCase, and non-ASCII text.
  Chunks within the word limit could exceed `max_position_embeddings` in real
  tokens and trigger an integer overflow in OrtRun. Fixed by passing
  `truncation: true` with explicit `max_length` at every pipeline call site
  (Gemma 2048, E5 512, MiniLM 256).

- **"Rebuild now" only wiped, never rebuilt (B3).** The `IndexWipeMigrationModal`
  wiped the stale index but did not trigger the actual rebuild. Users had to
  navigate to Settings manually. Fixed by auto-calling `startRebuildFor` (DLC
  providers) or `startIndexerIfNeeded` (native MiniLM) immediately after wipe.

- **DLC indexer started unnecessarily for native MiniLM provider.**
  `startIndexerIfNeeded()` ran for all non-Smart-Connections providers, including
  DLC providers that manage their own indexer. Guarded with `!usingDlcProvider`.

- **Settings UI showed 0 chunks for DLC providers.** `refreshStatus()` always read
  from `state.store` (hardwired to the native MiniLM store). Now reads
  `registry.storeFor(key, 768).size()` for EmbeddingGemma and MultilinguaE5.

## [0.10.0] — 2026-05-27

### Added

- **MCP Prompts — vault-native prompt library.** Every `.md` file in the vault's
  `Prompts/` folder tagged `#mcp-tools-prompt` is now automatically exposed as an
  MCP prompt. No configuration required — edit prompts directly in Obsidian.
  Discovery uses in-process `getMarkdownFiles()` + metadata cache (zero HTTP calls).
  Prompt arguments are declared with `<% tp.mcpTools.prompt("name", "desc") %>` syntax
  and injected via `{{name}}` Mustache placeholders at invocation time.
  A `VaultWatcher` keeps the list live as files are created, renamed, or deleted.
  Templater is not required — argument declarations are stripped from the rendered
  output; all other Templater expressions pass through verbatim. (ADR-0006, PR #197)

  MCP client integration:
  - **Claude Desktop**: prompts appear under "Attach from MCP" → `mcp-tools-istefox`.
  - **Claude Code**: slash commands `/mcp__mcp-tools-istefox__<prompt-name>`.
  - **Other clients**: any MCP client that supports `prompts/list` + `prompts/get`.

## [0.9.0] — 2026-05-27

### Added

- **Multilingual embedding providers with download-on-demand (DLC).** Introduces a
  pluggable `EmbeddingProvider` interface and three new ONNX providers available
  on demand: **Gemma 300M** (768d, recommended for non-Latin vaults),
  **Multilingual-E5-Base** (768d, alternative multilingual model), and a
  **native MiniLM-L6-v2** adapter (existing model, now exposed through the
  unified interface). Providers are downloaded from Hugging Face on first use
  and swapped live without restart. A per-provider binary store tracks each
  model's index independently. (ADR-0005, PR #194)

  Key mechanics:
  - **Auto-suggest**: on startup, `search_vault_smart` samples the vault for
    non-ASCII character ratio; vaults above 30% automatically surface a
    recommendation banner to switch to `embedding-gemma-300m`.
  - **Live swap**: selecting a new provider in settings triggers a background
    rebuild; the previous provider continues to serve queries until the new
    index is ready.
  - **DLC progress UI**: settings panel shows download progress, current
    provider, and index status per model.
  - **Crash-safe migration**: v1 flat store (`embeddings.bin`) is migrated to
    the per-provider directory layout using a `.migrating` sentinel that
    prevents partial migration state on crash.

- **`scope` parameter for `find_broken_links`.** Optional `scope: string[]`
  limits the scan to vault-relative path prefixes — mirrors `search_and_replace`.
  Addresses payload overflow on large vaults (~1860 links / 612K chars on 1050
  files). Omitting `scope` preserves vault-wide behaviour. (#193, PR #195)

### Changed

- **Chunker enhancements.** Frontmatter is now emitted as a dedicated
  `#frontmatter` chunk for independent embedding; H3 sub-sections split before
  the sliding-window fallback; sentence-level overlap wrapper at embed time
  (stored text is unchanged); CRLF-safe heading detection.
- **`search_vault_smart`** wired to the new provider factory — queries route to
  whichever provider is active (native MiniLM, Gemma, E5, or Smart Connections).

### Fixed

- **Port tests no longer fail when Obsidian is running.** `bindWithFallback`
  tests used the production `PORT_RANGE` (27200+); if the plugin was live, all
  three tests failed. Rewritten to use OS-assigned ephemeral ports.

## [0.8.2] — 2026-05-27

### Fixed

- **`search_vault_smart` broken with Smart Connections v4.** SC v4 removed `window.SmartSearch`; the v2 fallback in `loadSmartSearchAPI` blindly assigned `plugin.env` (which has no `search()` in SC v4) as the API, causing `installed: true` with an uncallable search function. The stream then closed immediately, permanently blocking access to `smart_sources`. Fixed by guarding the v2 fallback with `typeof candidate.search === "function"` — if `env` has no callable `search()`, polling continues until the v3 path (`smart_sources`) becomes ready. Also tightened the `takeWhile` predicate to `typeof dep.api?.search !== "function"` for defence-in-depth. (#186)

## [0.8.1] — 2026-05-27

### Fixed

- **Migration detector false positive on absolute npx path.** The legacy-install detector used strict string equality (`command === "npx"`), causing any absolute path to the npx binary (e.g. `/opt/homebrew/bin/npx`) to be falsely classified as a leftover 0.3.x config entry. Changed to `path.basename(command) === "npx"` so any absolute path whose basename is `npx` is correctly recognised as the current 0.4.x shape. Also corrected the lingering-legacy notice text, which referenced a settings section that does not exist. (#188)

## [0.8.0] — 2026-05-26

### Added

- **Vault Intelligence tools (5, Module E).** `find_broken_links`,
  `find_orphaned_notes`, `search_and_replace`, `get_note_outline`, and
  `list_bookmarks` add vault graph maintenance, bulk editing with a safe
  dry-run gate, heading navigation, and access to native Obsidian bookmarks.
  All tools use Obsidian's metadata cache (no direct file system access).
  Tool count 38 → 43. (ADR-0004)

## [0.7.0] — 2026-05-26

### Added

- **`execute_dataview_query` — in-process Dataview DQL tool.** New tool that
  runs a DQL query directly against the Dataview plugin API
  (`app.plugins.plugins.dataview.api.query(query, sourcePath)`) and returns
  the native typed result — `{type:"table", headers, values}` /
  `{type:"list", values}` / `{type:"task", values}` / `{type:"calendar", values}`.
  In-process: no Local REST API required. Three-state plugin detection
  surfaces a distinct `errorCode` per cause: `dataview_not_installed`
  (permanent), `dataview_not_ready` (transient — the plugin is loaded but
  the index hasn't finished building yet, Dataview fires
  `dataview:index-ready` when done), and `dataview_query_failed` (the DQL
  was parsed/evaluated by Dataview and rejected — Dataview's error string
  surfaces verbatim). DQL validation is delegated to Dataview entirely;
  ArkType only validates the boundary string shapes. Coexists with
  `search_vault` (which keeps its LRA-coupled DQL + JsonLogic path
  unchanged for backward compatibility) — the new tool's `.describe()`
  guides agents to prefer it for new DQL workflows. Large results are not
  truncated at the tool level; `.describe()` recommends in-DQL `LIMIT`.
  Tool count 37 → 38. **The LRA-coupled count stays at 1** —
  `search_vault` is the only remaining LRA-coupled tool. (ADR-0003, #166)

### Fixed

- **`execute_dataview_query` — hardened against runtime exceptions.** Wrapped
  `plugin.api.query()` and `JSON.stringify(result.value)` in try/catch so
  internal Dataview throws (broken index, torn-down plugin) and non-serialisable
  results (circular `Link`/`DateTime`/`TFile` objects) return a structured
  `{ isError: true, errorCode: "dataview_query_failed" }` instead of an
  unhandled rejection. `String()` coercion on `result.error` guards against
  the real plugin returning an `Error` object instead of a plain string. (#174)

- **`set_note_property` — arrays sent as JSON-encoded strings are now coerced
  to native YAML lists.** LLM clients (including Claude) sometimes serialize
  array values as JSON-encoded strings (`'["a","b","c"]'`) instead of native
  JSON arrays when constructing tool calls. The handler now detects and unwraps
  homogeneous `string[]` or `number[]` values before passing them to
  `processFrontMatter`, so `tags: '["a","b","c"]'` no longer appears in
  frontmatter — you get the proper YAML list instead. Mixed-type arrays and
  plain bracket strings are left unchanged. (#176)

## [0.6.0] — 2026-05-24

### Added

- **Atomic frontmatter property tools (4).** `get_note_property`,
  `set_note_property`, `delete_note_property`, and `list_property_values`
  give single-key access to note frontmatter without the whole-block
  read-modify-write of `patch_vault_file targetType:"frontmatter"`.
  Writes go through Obsidian's atomic `processFrontMatter`;
  reads/enumeration use the metadata cache (no file I/O).
  `set_note_property` auto-inits a missing block and treats `value:null`
  as delete; `list_property_values` is scale-safe
  (`limit`/`truncated`/`totalDistinct`). Tool count 30 → 34. (ADR-0001)
- **Periodic notes tools (3).** `get_or_create_daily_note(date?)`,
  `get_or_create_periodic_note(period, date?)`, and
  `append_to_periodic_note(period?='daily', content, date?, underHeading?)`
  give one-call access to daily / weekly / monthly / quarterly / yearly
  notes without the agent having to know the user's folder layout or
  date format. When the Daily Notes core plugin or the community
  Periodic Notes plugin is enabled, creation delegates to the plugin's
  API (via `obsidian-daily-notes-interface`) so the configured template
  + `{{date}}` / `{{title}}` interpolations run; otherwise the note is
  created as an empty file at the ISO path under the vault root.
  `append_to_periodic_note` reuses the `patch_vault_file` heading walker
  for `underHeading`, with strict `errorCode: "heading_not_found"` and
  **no rollback** of an auto-created file (the file's existence is the
  right end state — add the heading via `patch_vault_file` and retry).
  Structured writes compose: get the resolved path, then
  `set_note_property` or `patch_vault_file` — there is no dedicated
  `patch_periodic_note` (ADR-0002 Alternatives #7–#8, raised in #160).
  Path / existence / creation centralised in
  `services/periodicNotesDetector.ts` (`resolvePeriodicNote(app, period,
  date?) → {path, exists, create()}`) so future periodic-aware tools
  reuse the same seam. Per-period ISO date validation
  (`errorCode: "invalid_date_for_period"` on shape or value mismatch).
  `obsidian-daily-notes-interface` promoted from transitive (via LRA)
  to direct dependency of `packages/obsidian-plugin`. Tool count
  34 → 37. (ADR-0002, #160)

### Removed

- **Dead 0.3.x HTTP handlers in `main.ts`.** `handleTemplateExecution`
  and `handleSearchRequest` were Express-style request handlers from
  the pre-0.4.x line; they survived the in-process HTTP-embedded pivot
  as private methods with no call site (verified: no reference, binding,
  or reflection dispatch). Removed (~180 LOC) along with the now-orphan
  imports. No behaviour change — template execution and smart search
  run through the in-process MCP path (`executeTemplate` /
  `templatesCompat`, `search_vault_smart`).

### Fixed

- **`rename_heading`: wikilink alias tokenizer split on the last `|`
  instead of the first.** `rewriteBacklinker` parsed
  `[[note#A|B|C]]` as heading `A|B` / alias `C` rather than heading
  `A` / alias `B|C`, so a backlinker reference with a piped alias
  could be skipped on rename (lost link integrity). Obsidian's
  wikilink grammar treats the first `|` as the alias separator;
  `lastIndexOf("|")` → `indexOf("|")` aligns the tokenizer with it.
  A heading whose text literally contains `|` is unaddressable by
  wikilink and is only reachable via a markdown link (handled
  correctly already — the md-link branch keeps the post-`#` fragment
  literal). The prior edge-case-#7 test asserted the buggy behaviour;
  it is corrected and joined by fixtures for `[[note#A|B|C]]`, a
  `|`-named heading skipped via wikilink, and a `|`-named heading
  rewritten via markdown link. (#158)

### Continuous integration

- Drop the retired `feat/http-embedded` branch from `ci.yml`
  push/pull-request triggers (deleted from origin 2026-05-16 at
  0-ahead). Prevents an accidental future recreation of that branch
  name from reactivating CI on an unprotected ref. Stale references
  in `CLAUDE.md` (Stack-table CI row, Testing & CI section) are
  removed in the same change; historical mentions (discharge note,
  ruleset history) are preserved. (#154)

### Documentation

- `.gitignore` `main.js` block condensed from 5 lines to 2; the full
  outage context already lives in `CLAUDE.md` Gotchas. (#155)
- `CLAUDE.md` Stack-table `Toolchain pinning` row now explicitly says
  the `1.3.12` pin applies to `release.yml` only — `ci.yml`
  deliberately runs on `bun-version: latest` (deferred divergence
  documented in #150). (#155)

## [0.5.0] — 2026-05-18

### Added

- **`rename_heading` tool** — renames a heading in a vault file and
  rewrites every backlinking reference (wikilinks, markdown links, and
  subheading-path links) across the vault so links keep resolving.
  Multi-match is disambiguated with an optional `from.level`; an
  ambiguous match, a name collision with an existing heading, or a
  mid-walk write failure each fail loud with a specific `errorCode`
  and a recoverable file list.

## [0.4.10] — 2026-05-18

### Added

- **Heading patching now works on notes with no H1.** `patch_vault_file`
  and `patch_active_file` heading targets succeed on the common
  Obsidian pattern of a frontmatter `title:` with the body starting at
  `##` — a file with no `#` heading at all has an unambiguous root and
  is accepted automatically. A new optional `allowRootHeadings`
  parameter opts in to the same for the ambiguous case where an H1
  exists elsewhere in the note (default off; the existing fail-loud
  guard is unchanged for that case without it).

### Fixed

- **Heading `replace` no longer destroys content around fenced code
  (data integrity).** Replacing a heading section whose body contained
  a fenced code block with `##` lines inside silently truncated at the
  first in-fence `##`, leaving the rest of the block (and the section
  tail) orphaned in the file while reporting success. The section
  boundary now treats lines inside ` ``` ` / `~~~` fences as opaque,
  for both `patch_vault_file` and `patch_active_file`.
- **`get_vault_file_partial` frontmatter mode gives an actionable
  error.** When a frontmatter block is present but Obsidian's metadata
  cache could not parse it (commonly an unquoted scalar whose value
  contains `": "`), the tool reported a misleading "File has no
  frontmatter"; it now names the likely cause and the fix.

## [0.4.9] — 2026-05-17

### Security

- **`fetch` now refuses non-`http(s)` and internal targets.** The
  `url` argument is validated before any request: `file:`, `data:`,
  `blob:` and other non-HTTP(S) schemes are rejected (closes a local
  file-read vector), and requests to `localhost`, `*.local`,
  loopback/link-local and RFC-1918 private ranges are refused (SSRF).
  **Behavioural change:** fetching a local dev server or an internal
  host via this tool no longer works. DNS-rebinding is out of scope.
- **No-shell process execution.** The Node/npx detection and the
  `mcp-remote` pre-warm paths replaced the shell-string command form
  with an `execFile` + argv-array invocation, so a binary path
  containing shell metacharacters can no longer inject.
- **Request body cap (1 MiB)** on the local HTTP MCP server — an
  oversized declared `Content-Length` is rejected with `413` before
  the body is buffered (renderer OOM guard).
- **Tool-error logs no longer include tool arguments.** On a tool
  failure only the tool name is logged; `arguments` (which can carry
  note content, paths, queries) are no longer written to the on-disk
  diagnostic log.
- **Command id is trimmed** before the permission decision, so stray
  whitespace cannot defeat an exact-id allowlist entry.

### Fixed

- **Silent embedding-store corruption (data integrity).** An
  interrupted flush could leave a new vector file paired with a stale
  index that loaded without warning and sliced vectors at wrong
  offsets. A write-sentinel now detects an interrupted write on the
  next load and rebuilds cleanly; a defence-in-depth bounds check
  skips any out-of-range record instead of producing a
  wrong-dimension vector.
- **Transient read errors no longer drop a note's embeddings.** A
  file lock or I/O hiccup during indexing was treated as a deletion
  and permanently removed that note's vectors; it is now distinguished
  from a genuine deletion (note still in the vault → kept and retried).
- **Cross-feature settings loss.** Concurrent settings writes from
  different features (e.g. a permission decision while the settings UI
  saves, or token rotation) could silently overwrite each other's
  slice of `data.json`. All persistence now serializes through one
  shared lock.
- **HTTP server releases its port on disable/restart.** With an open
  `mcp-remote` stream `server.close()` never resolved, so the port
  "walked" on the next start and the client lost its connection;
  connections are now drained on close.
- **Concurrent `execute_template` calls no longer corrupt each
  other** — template execution (which temporarily patches a shared
  Templater function) is now serialized.
- **`create_vault_file` / `append_to_vault_file`** return a clean
  error instead of an uncaught failure when the target path is a
  folder.
- **BRAT install regression on 0.4.7 / 0.4.8 fixed.** The
  `obsidian-plugin-*.zip` convenience asset, dropped at 0.4.7, is
  restored to the 0.4.x release artifacts (issue
  [#124](https://github.com/istefox/obsidian-mcp-connector/issues/124));
  the existing 0.4.7/0.4.8 releases were back-filled.
- Minor: the embedder model cache is cleared on unload; prompt
  frontmatter `tags` are validated as a string array.

### Changed

- `fetch` clamps `maxLength` to 500 000 characters and applies a 30 s
  request timeout (previously unbounded / could hang indefinitely).

## [0.4.8] — 2026-05-16

### Fixed

- **Reproducible build (Obsidian automated "Build verification")** —
  `onnxruntime-web/dist/ort-web.node.js` resolves its directory from
  `__dirname`/`__filename`; with the `target:"node"` bundle Bun baked
  the build machine's absolute path
  (`/home/runner/work/.../onnxruntime-web/...`) into `main.js`, so a
  rebuild from source on any other machine no longer matched the
  released artifact and the community-store automated review reported
  *"the main.js built from source does not match the release artifact"*.
  Neutralised `__dirname`/`__filename` in the bundler `define` block
  (same proven approach as the `import.meta.url` fix in #100; the
  resolved value is dead — onnxruntime-web runs as WASM, CDN-pinned,
  `allowLocalModels=false`, `onnxruntime-node` shimmed).
- **Pinned the build toolchain** — `bun-version` in the release
  workflow and `mise.toml` were `latest` (non-deterministic across
  builds). Pinned both to `1.3.12` so CI releases are reproducible,
  per the store reviewer's recommendation.

## [0.4.7] — 2026-05-16

### Added

- **`get_vault_file_partial` tool** — partial-read access to a vault
  file via four modes operating on Obsidian's already-cached metadata
  (`MetadataCache`) and `vault.cachedRead`. No Local REST API
  required. Useful for context-window economics on large notes
  (e.g. spot-check a frontmatter field on a 30 KB file without
  loading the body).

  Originated as RFC [#77](https://github.com/istefox/obsidian-mcp-connector/issues/77)
  from @folotp (2026-05-04 upstream), originally triaged as a LRA
  passthrough wrapper. Re-anchored in-process per bilateral lockin
  between @istefox and @folotp on 2026-05-13 (issue #77
  [comment 4440557399](https://github.com/istefox/obsidian-mcp-connector/issues/77#issuecomment-4440557399) /
  [4440927656](https://github.com/istefox/obsidian-mcp-connector/issues/77#issuecomment-4440927656) /
  [4440988763](https://github.com/istefox/obsidian-mcp-connector/issues/77#issuecomment-4440988763)),
  aligning the tool with the 0.4.x "LRA-optional" stance — bumping
  the "works without LRA" count from 27 to **28** of 29 tools.

  Schema: `{ filename, mode, target?, targetDelimiter? }` (Option A
  verbatim from the RFC).

  - **`mode: "frontmatter"`** — returns a single frontmatter field
    value (scalar / array / nested object), serialised as JSON.
    Zero file I/O (cache-only). Requires `target`.
  - **`mode: "document-map"`** — returns the file outline:
    `{ path, frontmatter: [keys], headings: [{heading, level, line}],
    blocks: [ids] }`. Zero file I/O (cache-only). `target` ignored.
  - **`mode: "heading"`** — returns the markdown section under the
    target heading, from the heading line (inclusive) to before the
    next same-or-higher-level heading (exclusive) or EOF. Nested
    paths via `targetDelimiter` (default `"::"`, e.g.
    `"Parent::Child::Grandchild"`). Ambiguous targets
    (multiple matches at the same depth) fail loud with `isError:
    true`. Requires `target`.
  - **`mode: "block"`** — returns the markdown range of the block
    reference identified by `target` (with or without the leading
    `^`). Requires `target`.

  All four modes fail loud with `isError: true` and a descriptive
  message on missing target, missing field/heading/block, ambiguous
  heading, frontmatter-less file (frontmatter mode), or
  filename-not-resolved. Schema validates the `mode` to the four-value
  union at arktype layer; out-of-range modes never reach the handler.

  Authorisation gate matches `list_tags` / `get_files_by_tag` /
  `get_recent_files` — no per-tool allowlist, no plugin dependency,
  read-only. Out of scope (deferred if surfaced): folder-scoped
  filtering, regex-match on heading text, case-insensitive heading
  match, multi-target batch.

  Pinned by 24 cases in `getVaultFilePartial.test.ts` following the
  priority order adopted in the #77 close-out (PRIMARY depth for
  `frontmatter` + `document-map` since they are the zero-I/O
  cache-only paths consumers reach for most heavily; SECONDARY
  positive + missing + ambiguous coverage for `heading` + `block`).
  Mock surface untouched — the existing `setMockMetadata()` helper
  covers headings, blocks, and frontmatter shapes shipped from PR #87.

- **`get_recent_files` tool** — returns the most recently modified
  markdown files in the vault, ordered by `mtime` descending with a
  `path` ascending tiebreaker on equal `mtime` (so repeat calls return
  deterministic order on bulk-import / sync-event ties). Useful
  agent-recency context (proposed by @istefox in
  [#69 upstream comment](https://github.com/jacksteamdev/obsidian-mcp-tools/pull/69#issuecomment-4371427847)
  as a "smallest-wins-first" candidate; confirmed as NEXT after the
  PR #93 merge in
  [#93 close-out](https://github.com/istefox/obsidian-mcp-connector/pull/93#issuecomment-4418358887);
  shipped in PR #94; review follow-ups (LOW1/LOW2/LOW3 from
  [#94 close-out](https://github.com/istefox/obsidian-mcp-connector/pull/94))
  landed in the same `[Unreleased]` block).

  Schema: `{ limit?: number }`. `limit` is an arktype-validated integer
  in `[1, 100]` (default 20). Out-of-range values, zero, negatives, and
  non-integers are rejected at schema-validation time — fail-loud, no
  silent clamping, matching the validation bias of the rest of the
  tool surface.

  Response shape:
  ```json
  {
    "totalFiles": 250,
    "files": [
      { "path": "Notes/today.md", "mtime": 1715432100000, "ctime": 1715000000000, "size": 1234 }
    ]
  }
  ```
  Timestamps are Unix epoch milliseconds (raw `TFile.stat.mtime` /
  `TFile.stat.ctime`); `size` is the file's byte length. `totalFiles`
  counts the full visible (post-exclusion) markdown set before the
  recency slice, matching the contract of `get_files_by_tag` so callers
  can detect whether `limit` truncated the result.

  Honours Obsidian's `Files & Links → Excluded files` configuration via
  the runtime `MetadataCache.isUserIgnored(path)` accessor. The cast
  through `unknown` mirrors the pattern used by `list_tags` for
  `metadataCache.getTags` (both methods exist at runtime but are not
  surfaced by the bundled `obsidian.d.ts`). If the accessor is
  unavailable (future Obsidian rename / removal), the handler degrades
  gracefully to "no exclusion applied" and emits a one-shot
  `logger.warn` so the regression is observable in the plugin log
  instead of silently surfacing user-ignored entries. Markdown-only
  via `vault.getMarkdownFiles()`; non-markdown files are not surfaced.

  Authorization gate matches `list_tags` / `get_files_by_tag` — no
  per-tool allowlist, no plugin dependency, read-only. Out of scope
  (deferred for a follow-up if user demand surfaces): folder-scoped
  filtering, sort key parameter, non-markdown surface.

  Pinned by 12 cases in `getRecentFiles.test.ts` (schema name,
  empty-vault response, mtime ordering, equal-mtime path-ascending
  tiebreaker, default limit of 20, explicit limit, limit > totalFiles
  graceful path, full per-entry shape including `size`, non-markdown
  filter, graceful degradation when `isUserIgnored` is absent,
  `isUserIgnored` exclusion when present, and arktype boundary
  validation covering 0 / -5 / 5.5 / 101 rejects and 1 / 100 boundary
  accepts). Mock surface in `test-setup.ts` extended additively with
  `setMockIgnored(path)` + `metadataCache.isUserIgnored` (same pattern
  that landed `setMockFileStat()` in #93 — reusable for any follow-up
  tool that filters against the user-ignored set).

## [0.4.6] — 2026-05-11

### Added

- **`rename_vault_file` tool** — renames or moves a vault file via
  `app.fileManager.renameFile`, preserving link integrity across the
  vault (wikilinks, markdown links, embeds, and frontmatter aliases
  pointing at the source path are rewritten atomically by Obsidian).
  Schema: `{ from, to }`, both required, both vault-root relative.
  Response on success: `{ ok: true, path: <to> }`. Closes the gap
  whereby an MCP client could only emulate rename via
  `read + create + delete`, which destroys every backlink to the file
  on every move.

  Error semantics, all surfaced as `isError: true` with a descriptive
  message:
  - `from` does not resolve → "Source file not found: …"
  - `to` already exists → "Destination already exists: …" (no overwrite)
  - destination parent directory does not exist → "Destination parent
    directory does not exist: …" (fail-loud, NOT auto-created — mirrors
    the unresolved-target bias of `patch_*_file` from #6 / #58)
  - `from === to` → "Source and destination are identical: …"
  - underlying `renameFile` rejection → echoed verbatim as
    "Failed to rename: …"

  Authorization gate matches `delete_vault_file` / `create_vault_file`
  (no per-tool allowlist). Out of scope: folder rename and heading
  rename (the latter tracked separately in #68).

  Pinned by 8 cases in `renameVaultFile.test.ts` (schema name, root
  rename + JSON response shape, cross-directory move, all five error
  branches). Mock surface in `test-setup.ts` extended additively with
  `app.fileManager.renameFile` (migrates content, metadata cache,
  stats, and active-file pointer).

  Proposed and triage-accepted by @istefox in
  [#67](https://github.com/istefox/obsidian-mcp-connector/issues/67).

- **`get_server_info` now surfaces the in-process listen address.**
  Adds a `localTransport: { protocol, host, port, path }` field to the
  response when the HTTP server is bound, omitted otherwise. Doubles
  as the third confirmed-positive chain-id discriminator from the soak
  preflight protocol — callers can programmatically assert they are
  routed through the HTTP-embedded server rather than the legacy stdio
  binary. Reported by @folotp via #78. (#91)

- **Recurring `Notice` while legacy 0.3.x state persists post-skip.**
  Once the first-load migration modal has been dismissed
  (`migrationDecision.skippedAt` set), the plugin re-checks legacy
  signals on every subsequent load and surfaces a non-modal `Notice`
  if `hasLegacyBinary` / `hasLegacyClaudeConfigEntry` /
  `hasLegacySettingsKeys` are still true. Three-state action map
  branches the pointer (verify-binary-gone / edit-client-config /
  settings-cleanup) so the nudge is always actionable. Decision logic
  isolated as a pure `decideMigrationAction(signals, hasSkippedAt)`
  function (`noop | notice | modal`) — the first-load modal flow is
  unchanged. (#78, #91)

### Fixed

- **`search_vault`: unhardcoded Local REST API URL.** `searchVault.ts`
  previously hit LRA on a hardcoded `https://127.0.0.1:27124`, the
  only fork tool out of 26 still doing so post-pivot to HTTP-embedded.
  New `McpToolsPlugin.getLocalRestApiUrl()` mirrors the existing
  `getLocalRestApiKey()` shape and reads `bindingHost` + `port` from
  live LRA settings, with a clean fallback to the documented default
  when the LRA plugin cannot be queried (test environment, plugin not
  yet loaded). If a user reconfigures LRA's listen port in Obsidian,
  `search_vault` follows automatically — no plugin restart, no env
  var. (#79, #90)

- **`delete_vault_directory`: ENOTEMPTY error no longer leaks the
  absolute host filesystem path.** The catch block previously bubbled
  the raw Node `fs.rmdir` error message, which embeds the full
  absolute path Node was given and exposes `$HOME`, cloud-sync
  identifiers, and the local vault folder name to the MCP client. The
  fix maps known fs errno codes (`ENOTEMPTY` / `ENOENT` / `EACCES` /
  `EPERM`) to vault-relative messages with the same shape as the
  existing sibling error paths in the same handler. The ENOTEMPTY
  branch additionally hints at the way out
  (`use recursive: "true" to delete it together with its contents`)
  instead of echoing Node's raw error string — caller-actionable
  without prior context. Mock realism update (`test-setup.ts`):
  `adapter.rmdir` now sets `.code` errno on the thrown `Error` and
  embeds a synthetic absolute path, mirroring real Node behaviour;
  this closes the testing gap that let the leak slip past 0.4.5's
  pre-cut tests. Reported by @folotp during the 0.4.5 round-6 verify
  on #86. (#88, #92)

- **`delete_vault_file` / `delete_active_file` now honour the vault's
  "Deleted files" setting instead of permanently unlinking.** Both
  handlers called `app.vault.delete(file)`, a hard unlink that bypasses
  Obsidian's configured deletion strategy (system trash / `.trash/` /
  permanent). Files deleted via MCP were unrecoverable even when the
  vault was set to move deletions to `.trash` — a data-loss risk in
  agentic bulk-delete workflows where many files are removed without
  individual confirmation. Both now route through
  `app.fileManager.trashFile(file)`, which applies the vault preference
  automatically (no manual `trashOption` inspection). `delete_vault_directory`
  is intentionally out of scope — it documents its trash-bypass
  explicitly. Reported by @folotp on a 0.4.6 soak. (#96)

- **`search_vault_smart` now honours the `smart-connections` provider
  setting instead of always invoking the native pipeline.** Two root
  causes: (1) the production wiring never bound the resolved Smart
  Connections API onto the plugin instance, so
  `SmartConnectionsProvider.isReady()` (which reads `plugin.smartSearch`)
  always returned `false` — the tool reported "Semantic search is not
  ready" even with Smart Connections fully loaded and explicitly
  selected; (2) the handler kicked the native Transformers.js indexer
  unconditionally on every call, triggering a HuggingFace embedding
  model download (`ensurePipeline` → `from_pretrained`) even when Smart
  Connections was the selected backend. Fixes: `main.ts` binds
  `this.smartSearch` from the existing `loadSmartSearchAPI` reactive
  loader (same best-effort pattern as the Local REST API binding); the
  `search_vault_smart` handler skips the native indexer kick when Smart
  Connections is the active backend (`smart-connections`, or `auto`
  with Smart Connections available). The "not ready" error is now
  provider-aware — under Smart Connections it names the Smart
  Connections plugin rather than the irrelevant native embedding model.
  Reported by @folotp on a 0.4.6 soak. (#99)

- **"Pre-warm now" no longer dumps a fatal-looking stack trace to the
  console when it actually succeeded.** `mcp-remote` has no `--help`
  flag — probing it throws `ERR_INVALID_URL` on Node 20+/24. The
  pre-warm already recovers correctly (the package is cached by the
  time the probe fails, so it is treated as success), but it echoed the
  raw child-process `Fatal error: TypeError: Invalid URL … at new URL …
  ERR_INVALID_URL` slice into `logger.debug` — and in the shipped build
  `logger` *is* `console`, so a successful pre-warm looked like a crash
  in the user's dev console. Both the catch/recovery branch and the
  success-path stderr log now detect the expected benign probe shape
  and emit a clean one-line confirmation instead of the raw trace.
  Genuinely unexpected stderr (e.g. npm deprecation warnings) is still
  logged verbatim for diagnostics. Reported by @folotp on a 0.4.6 soak.
  (#98)

- **Windows: plugin no longer crashes on load (`fileURLToPath` of a
  baked build-machine path).** `@xenova/transformers/src/env.js` calls
  `fileURLToPath(import.meta.url)` eagerly at module-init. `bun.config.ts`
  neutralised `import.meta.filename` but not `import.meta.url`, so Bun
  baked the **build machine's** absolute path into `main.js` — on the
  GitHub Actions Linux runner, `file:///home/runner/...`. At load on
  Windows, `getPathFromURLWin32` rejects that drive-less POSIX path with
  `TypeError: File URL path must be absolute`, taking down the whole
  plugin before any of our code runs. macOS/Linux were unaffected (a
  POSIX path is still a valid file-URL path there). Fixed by adding
  `import.meta.url` to the `define` block, mirroring the existing
  `import.meta.filename` neutralisation. The placeholder carries a drive
  letter (`file:///C:/…`) on purpose: a drive-less `file:///…` URL
  throws on Windows for the *same* reason as the bug, whereas
  `fileURLToPath` accepts `file:///C:/…` on every platform. The value is
  dead in our build (`env.allowLocalModels = false`, ONNX wasm pinned to
  a CDN) — only the eager call needed to stop throwing. Reported by
  @nathancrum. (#100)

### Changed

- **Migration walkthrough adds an explicit
  "verify-legacy-binary-gone" step** with cross-platform check
  commands (macOS/Linux `ls`, Windows PowerShell `Test-Path`), paired
  with the recurring in-product `Notice` as a backstop. Closes the
  gap that surfaced in the 2026-05-04 post-#83 retrospective where a
  stale legacy binary could silently re-route MCP traffic through the
  unmaintained 0.3.x stdio chain without the user noticing. (#78, #91)

## [0.4.5] — 2026-05-06

### Added

- **`create_vault_directory` tool** — creates a directory at a
  vault-relative path, recursively creating any missing intermediate
  ancestors (`mkdirp` semantics). Idempotent: succeeds silently if the
  directory already exists. Rejects empty paths and refuses to overwrite
  an existing file with the same path. Closes the gap whereby an MCP
  client could create files but not the directories needed to organise
  them. (#86)

- **`delete_vault_directory` tool** — deletes a vault directory via
  `app.vault.adapter.rmdir`. Defaults to non-recursive (fails on a
  non-empty directory); pass `recursive: "true"` to delete the directory
  along with every file and sub-directory it contains. Bottoms out in
  the filesystem adapter, so deleted content does NOT route through the
  Obsidian trash — the call is irreversible from MCP. Closes the gap
  whereby empty directories accumulated as filesystem debris after
  `delete_vault_file` cleared their contents. (#86)

### Fixed

- **`create_vault_file` / `append_to_vault_file` / `execute_template`:
  ENOENT on missing parent directory.** All three handlers called
  `app.vault.create(path, content)` directly without ensuring the
  ancestor chain existed, so any path containing a not-yet-created
  subdirectory failed at the filesystem layer with
  `ENOENT: no such file or directory`. The legacy LRA chain (0.3.x)
  side-stepped this with a single-level `createFolder` shim in
  `_vaultPut`; the in-process 0.4.x handlers regressed by not porting
  it. New shared helper `services/ensureFolderExists.ts` walks every
  ancestor segment root-first, calls `app.vault.createFolder` on the
  first missing one, and tolerates the "already exists" race — extending
  parity with LRA into proper multi-level mkdirp. Reported by @folotp
  in #86 with a worked diff and ENOENT repro; the fix covers the
  three call sites instead of just the two flagged in the report.

### Changed

- **`minAppVersion` raised from `0.15.0` to `1.7.2`.** The new
  directory tools depend on `app.vault.createFolder` (`@since 1.4.0`)
  and `app.vault.adapter.rmdir(path, recursive)` (`@since 1.7.2`). All
  active Obsidian installs are well past 1.7.2 in practice, so this is
  a manifest update rather than a portability blocker — flagging here
  for changelog completeness. BRAT installs gated below 1.7.2 will
  refuse to update; users on those versions should update Obsidian
  before pulling 0.4.5.

## [0.4.4] — 2026-05-05

### Added

- **`list_tags` tool** — lists all tags used across the vault with their
  aggregated usage counts. Backed directly by
  `app.metadataCache.getTags()`, so it includes both inline `#tags` and
  frontmatter tags, deduplicated per file, with no plugin dependency
  (Dataview is not required). Optional `sort` argument:
  `"count"` (default, descending) or `"name"` (alphabetical). Output
  shape:

  ```json
  {
    "totalTags": 3,
    "tags": [
      { "tag": "#project", "count": 23 },
      { "tag": "#daily", "count": 19 },
      { "tag": "#idea", "count": 1 }
    ]
  }
  ```

  Useful for agents discovering content categories before deciding what
  to read or query. Always read-only.

  Pinned by 7 cases in `listTags.test.ts` (schema name, empty vault,
  default count-desc sort, name-asc sort, explicit count sort, nested
  tag paths preserved verbatim).

  Mock surface extended in `test-setup.ts`: `setMockTags()` helper +
  `metadataCache.getTags()` mock; reusable by future tag-related tools
  without further bootstrap.

- **`get_files_by_tag` tool** — sibling of `list_tags`. Takes a tag
  (with or without leading `#`, case-insensitive) and returns every
  vault file containing it, with per-file occurrence count for
  relevance ranking. Counts inline and frontmatter occurrences as
  separate hits (a `getAllTags()`-based dedupe would have collapsed
  `count` to a binary present/absent and lost the search-relevance
  signal). Optional `includeNested` (default `"true"`) makes
  `tag="#project"` match `#project`, `#project/active`,
  `#project/archived`, etc., mirroring Obsidian's tag pane. Empty or
  `#`-only input is rejected with `isError: true`. Sort: count desc,
  path-asc tiebreaker. Output shape:

  ```json
  {
    "tag": "#project",
    "includeNested": true,
    "totalFiles": 2,
    "files": [
      { "path": "notes/active-roadmap.md", "count": 5 },
      { "path": "archive/old-plan.md", "count": 1 }
    ]
  }
  ```

  Pinned by 13 cases in `getFilesByTag.test.ts` (schema name, empty
  vault, inline match, with/without `#`, frontmatter array form,
  inline+frontmatter combined, nested with `includeNested:true`,
  exact-only with `includeNested:false`, case-insensitive match,
  count-desc + path-asc tiebreaker, empty-tag rejected, `#`-only
  rejected, non-markdown files ignored).

- **`get_outgoing_links` tool** — first member of the new "Links"
  section. Returns every link emanating from the given file across
  three layers: body links (`[[wikilink]]`, `[md](path)`), body
  embeds (`![[…]]`), and frontmatter links (e.g. `parent: [[Other]]`).
  Each entry carries `link`, `original`, optional `displayText`,
  `source: "body" | "frontmatter"`, `embed: boolean`,
  `resolved: boolean`, and `targetPath: string | null`. Resolution
  uses the documented public `metadataCache.getFirstLinkpathDest()`
  so callers don't need a round-trip to a separate tool to resolve
  linkpaths into vault paths. Optional `includeEmbeds` (default
  `"true"`) and `includeUnresolved` (default `"true"`). Source file
  not found returns `isError: true`. Order: body → embeds →
  frontmatter, no sort (document position is semantic).

  Pinned by 13 cases in `getOutgoingLinks.test.ts` (schema name,
  source-not-found error, empty file, body links resolved, body
  links unresolved with `targetPath:null`, exclude-unresolved, embeds
  by default, exclude-embeds, frontmatter links resolved, displayText
  preservation, order preservation, all-flags-off minimal subset,
  unresolved frontmatter link).

- **`get_backlinks` tool** — completes the bootstrap of the "Links"
  section. Returns every file that links to the given target, with
  per-source link count. Aggregates resolved backlinks via reverse
  iteration of `metadataCache.resolvedLinks`; opt-in
  `includeUnresolved` (default `"false"`) extends with broken-link
  sources matched by full path, by path without `.md`, or by basename.
  Resolved + unresolved counts from the same source aggregate into a
  single per-source count. Does NOT error if the target file doesn't
  currently exist on disk — backlinks routinely outlive their target
  after delete or rename, and surfacing them is the use case (audit /
  recovery / fix-up). Sort: count desc, path-asc tiebreaker. The
  schema description points callers wanting per-link context
  (`displayText`, raw syntax) at `get_outgoing_links` from each
  source — `resolvedLinks` aggregates per-file so it can't carry
  that detail.

  Pinned by 12 cases in `getBacklinks.test.ts` (schema name, no
  backlinks, single, multiple sources, ignores zero-count, self-link,
  target file missing on disk → no error, default excludes
  unresolved, includeUnresolved basename match, includeUnresolved
  exact-path match, resolved+unresolved aggregation from same source,
  count-desc + path-asc tiebreaker).

- **Mock surface extended in `test-setup.ts`** — supports the three
  new tools and any future link/graph queries:
  - `MockVaultState.metadataCache` per-file: + `tags` / `links` /
    `embeds` / `frontmatterLinks` arrays
  - `MockVaultState`: + `resolvedLinks` / `unresolvedLinks` maps
    (live references; `resetMockVault()` mutates in place to keep
    `mockApp().metadataCache` bindings valid across tests)
  - `setMockMetadata`: extended with `tags` / `links` / `embeds` /
    `frontmatterLinks`
  - new helpers: `setMockResolvedLinks`, `setMockUnresolvedLinks`
  - `mockApp().metadataCache`: + `resolvedLinks` getter,
    `unresolvedLinks` getter, `getFirstLinkpathDest` mock (exact path
    → `+.md` → basename)
  - `mock.module("obsidian")`: + `getAllTags` exported helper
    (kept for future consumers)

## [0.4.3] — 2026-05-05

### Fixed

- **`patch_vault_file targetType:"block"` silently destroyed the
  surrounding fenced code block** when the block id resolved inside a
  code fence on the cache-miss + regex-fallback path (#84, sibling
  regression to #81, surfaced by @folotp's round-042 soak on the actual
  HTTP-embedded chain with xxd-pinned bytes). The 0.4.2 fix gated the
  table branch correctly but missed the fenced-code branch on this
  specific shape: `findBlockReferenceInContent` walks backward from the
  `^block-id` line stopping at blank lines, which captures the **opening
  fence delimiter** as `startLine`. The 0.4.2 caller checked
  `isInsideTableOrFencedCode(lines, blockPos.startLine)` — and the
  helper's fence-counting loop iterates `lines[0..lineIdx-1]` strictly,
  so the fence AT `lineIdx` itself wasn't counted (`inFence=false`) and
  the line itself wasn't checked for being a fence delimiter. Net:
  helper returned false, gate failed, splice replaced the opening fence
  + content + `^block-id` line inline, orphaning the closing fence.
  🔴 Severity HIGH — vault-safety, same shape as #81. Two compounding
  fixes:
  - **Boundary case** in `isInsideTableOrFencedCode`: a line that itself
    is a fence delimiter (`.trim().startsWith("```")`) now returns true
    — splicing through a delimiter always orphans the matching one.
    Symmetric to the existing `isSeparator(target) → return true` check
    in the table case (`patchHelpers.ts:202`).
  - **New `isBlockRangeStructurallyUnsafe` wrapper**: block branch of
    `applyPatch` now checks every line in `[startLine, endLine]` via the
    new exported helper, not just `startLine`. Defense-in-depth against
    future cache-resolution shapes where the resolved block spans a
    fence boundary in a different layout than the regex-fallback's
    output.
  - Both `applyPatch` implementations (`services/patchHelpers.ts`
    canonical + `tools/patchActiveFile.ts` duplicate) updated
    symmetrically.
  - **Test-fixture realism gap closed**: the existing 0.4.2 fenced-code
    test (`patchVaultFile.test.ts:460-486`) bypassed the bug by mocking
    the cache to return the in-fence content line directly, never
    exercising the regex-fallback path that production hits on cache
    miss. New test on folotp's #84 fixture byte-exact **without
    `setMockMetadata`** forces the regex fallback to run, surfacing the
    fence-opener-as-startLine shape that this patch fixes.

  Tests: 9 new cases across `patchHelpers.test.ts` (3 fence-delimiter-
  line boundary cases on `isInsideTableOrFencedCode` + 5 cases on the
  new `isBlockRangeStructurallyUnsafe` describe), 3 in
  `patchVaultFile.test.ts` (#84 byte-exact regex-fallback + append-op
  symmetric + paragraph-before-fence control as regression sentinel),
  1 mirror in `patchActiveFile.test.ts` (cache-only with mocked
  `startLine` at opening fence). Plugin suite: 656/656 green
  (delta +13 vs 0.4.2 baseline).

### Known limits (not regressions, not fixed in this patch)

Folotp's round-042 bonus sentinel results on `#83`'s boundary scanner
pinned two future-fix candidates that are documented per-line
`^`-anchored regex behavior on the **heading** side, not block-side
regressions:

- `## ` at column 1 inside a fenced code block fakes a section heading.
- `## ` at column 1 inside a multi-line `<!-- HTML comment -->` fakes a
  section heading.

Folotp's explicit framing: "future-fix pins for the boundary scanner
if/when fence-awareness or HTML-comment-awareness is added on the
heading side (parallel to the new block-side
`isInsideTableOrFencedCode` helper)". Not silent data destruction; not
blocking. Tracked as candidates for a future 0.4.x feature batch
post-store-accept.

## [0.4.2] — 2026-05-04

### Fixed

- **`patch_vault_file` and `patch_active_file` accepted level-2-or-deeper
  root-orphan headings silently** when `createTargetIfMissing: false`
  (#80, reported by @folotp during the 0.4.0-beta.3 round-3 retest after
  the chain mis-identification was corrected via `jacksteamdev/obsidian-mcp-tools#83`).
  The 0.3.9 (#16) `detectOrphanRootHeading` reject — enforced implicitly
  on the 0.3.x line via Local REST API's indexer — did not get ported
  into the in-process `applyPatch` on the 0.4.0 rewrite, so a `replace`
  call against a `## RootHeading` with no `# ParentH1` succeeded silently
  (file body modified, no error). Severity MEDIUM (no data loss; breaking
  vs. the 0.3.x behavior that callers rely on). Fix gates the heading
  branch with a new exported helper `hasParentH1(lines, headingLine)` and
  returns `isError: true` with the legacy chain's message wording
  (`"Heading X is a level-N heading at the root of the file with no
  level-1 (#) parent. ..."`). Bypass via `createTargetIfMissing: true`
  preserved.

- **`patch_vault_file` and `patch_active_file` silently destroyed the
  surrounding markdown table or fenced code block** when a `block` target
  resolved to a line inside a table cell or code fence (#81, surfaced in
  the same retest). The 0.3.x legacy chain rejected this with HTTP 400
  `invalid-target` via `markdown-patch`'s indexer; the in-process port
  had no equivalent gate, so a `replace` against `^cell-id` inside a
  `| ... |` row would splice out the entire surrounding table with no
  error. 🔴 Severity HIGH — vault-safety. Fix introduces a new exported
  helper `isInsideTableOrFencedCode(lines, lineIdx)` that detects both
  fenced code (counted from open ` ``` ` markers) and markdown tables
  (target row plus a `|---|...|` separator above or below, separated
  only by other table rows), and gates the block branch before the
  splice. Symmetric across `append` / `prepend` / `replace` — gate runs
  before op dispatch.

  Both fixes covered by 33 new tests across `patchHelpers.test.ts` (21
  unit cases on the two helpers including separator-self, alignment-colon
  separators, false-positive guards on stray pipes / fenced-code-already-closed)
  and the two end-to-end test files (8 `patchVaultFile` cases + 4
  `patchActiveFile` mirrors), reproducing folotp's R1 and R2 fixtures
  byte-exact and asserting file-content preservation on reject. Both
  `applyPatch` implementations (`services/patchHelpers.ts` canonical +
  `tools/patchActiveFile.ts` duplicate) carry the gates; consolidation
  of the two call sites remains a separate refactor.

### Documentation

- **CLAUDE.md adds a "Soak preflight: chain identification" section**
  documenting the three discriminators folotp surfaced on
  `jacksteamdev/obsidian-mcp-tools#83` for distinguishing the legacy
  0.3.x stdio chain from the 0.4.x in-process HTTP-embedded chain:
  process inventory (`ps aux | grep -E 'mcp-server|mcp-remote'`),
  `get_server_info` shape (`apiExtensions[]` present → legacy, absent
  → HTTP-embedded), and tool namespace prefix
  (`mcp__obsidian-mcp-tools__*` legacy vs. `mcp__mcp-tools-istefox__*`
  HTTP-embedded). First-line check for any future soak round so chain-
  mismatch is caught at the report shape, not three rounds in.

## [0.4.1] — 2026-05-04

### Fixed

- **`patch_*_file` heading `replace` consumed the leading blank-line
  separator between the patched section heading and the new body**
  (#76, reported by @folotp during the 0.4.0-beta.3 round-3 soak).
  The post-beta.1 batch had added the trailing-separator re-emission
  (between the body and the next sibling heading) but missed the
  symmetric leading separator between the heading line and the body.
  Result: `## A\n<replacement>\n\n## B` instead of the expected
  `## A\n\n<replacement>\n\n## B`. Cosmetic only — Linter normalises
  on UI save — but for MCP-only edit sequences without an
  intermediate UI save, sections collide visually in raw view and
  downstream tools that parse by heading boundaries see a different
  shape than what Linter would produce. Fix re-emits the leading
  blank symmetric to the trailing one when the body does not already
  start with one. Idempotent: caller-supplied leading newlines are
  respected (no double-emission).

  Pinned by 6 new cases across `patchVaultFile.test.ts` and
  `patchActiveFile.test.ts` (heading replace with input leading
  blank, without input leading blank — Linter-correct normalisation,
  caller-supplied leading newline — no double-emit, plus parallel
  cases on `patchActiveFile`). Both `applyPatch` implementations
  (`services/patchHelpers.ts` and `tools/patchActiveFile.ts`) carry
  the fix; consolidation of the two call sites remains a separate
  refactor.

## [0.4.0] — 2026-05-04

The HTTP-embedded pivot. The plugin now hosts the MCP server in-process inside Obsidian and exposes Streamable HTTP on `127.0.0.1:27200`. **No native binary shipped from this repository** — closes the supply-chain attack surface that prompted upstream's official unmaintained declaration on 2026-04-24.

End-to-end smoke validated in vault TEST + Claude Desktop: 20/20 tools registered, native semantic search (MiniLM-L6-v2) returns cosine matches in the low-ms range, `npx mcp-remote` bridge connects Claude Desktop to the in-process server.

This entry consolidates the four alpha pre-releases and the beta. The full per-tag detail (with the running iteration of test counts and known-limitation deltas) is preserved on the GitHub Releases page; the alpha and beta tags themselves are kept in the repository.

### Added — HTTP transport (Phase 1)

- **Streamable HTTP transport** (MCP spec 2025-06-18) on `127.0.0.1:27200` (fallback 27201-27205). Bind is loopback only; no external network exposure.
- **Middleware chain**: method/path allow-list (POST/GET on `/mcp` and `/mcp/*`), Origin validation against loopback regex (anti-DNS-rebinding per spec), Bearer token auth with `crypto.timingSafeEqual` (UTF-8 byte-length safe).
- **Bearer token** generated at first load, persisted in `data.json` at `mcpTransport.bearerToken`. Rotatable from Settings → MCP Connector → Access Control.
- **`ToolRegistry` ported in-process** from `packages/mcp-server` to the plugin, with the same ArkType-based registration and error formatting.
- **Plugin lifecycle integration**: `onload` starts the HTTP server and MCP service; `onunload` tears down cleanly. Start failure surfaces as an Obsidian Notice and logs via the shared logger; the rest of the plugin loads anyway.

### Added — Tool surface (Phase 2)

- **All 19 0.3.x tools migrated** to the in-process server (vault read/write/patch/delete/list, search variants, template execution, web fetch, command list/execute). Plus `get_server_info` for health checks. **20 tools total.**
- **Per-request transport**: `StreamableHTTPServerTransport` is built fresh per HTTP request (stateless mode forbids reuse across requests; the MCP SDK enforces this in `webStandardStreamableHttp.js`). The `ToolRegistry` stays a singleton so per-request cost is on the order of milliseconds.

### Added — Native semantic search (Phase 3)

- **`search_vault_smart` no longer requires Smart Connections.** A new native provider runs entirely on-device via `@xenova/transformers` 2.17.2 + `Xenova/all-MiniLM-L6-v2` (384-dim embeddings, ~25 MB). Cosine flat scan with vectorized typed-array math. Folder include/exclude filters apply before scoring.
- **Provider tri-state setting**: `auto` (default — Smart Connections if installed, otherwise native), `native` (always Transformers.js), `smart-connections` (always SC; errors actionably if absent).
- **Live indexer** (default): subscribes to `vault.on('modify'|'create'|'delete')`, debounces per-file edits (2s), re-chunks, reuses vectors for unchanged chunks (chunk-delta), drops records on file delete.
- **Low-power indexer** (opt-in): 5-minute interval scan against `getMarkdownFiles().mtime`, single batched `store.flush()` per cycle.
- **Embedding store** at `<pluginDir>/embeddings.bin` (sequential Float32) + `embeddings.index.json`. Format version 1; mismatch triggers a clean re-index with a warning.
- **Lazy start**: the indexer is constructed at plugin onload but not auto-started — it kicks in on the first `search_vault_smart` call so plugin boot stays fast and the ~25 MB MiniLM download only happens for users who actually use semantic search.
- **Settings UI** (`SemanticSettingsSection.svelte`): tri-state radio + indexing-mode radio + unload-when-idle toggle + indexed-chunk count + Rebuild button.
- **Model download progress** (`ModelDownloadProgress.svelte`): progress card during the first-run download (subscribes to a `ModelDownloader` state machine — idle → downloading → ready / error with retry).
- **Embedder optimizations**: LRU query cache (size 32), unload-when-idle timer (60s default), shared in-flight `Promise<PipelineFn>` dedupes concurrent first-call.
- **Chunker**: heading-section (H1/H2) split with 512/64-token sliding window fallback for over-long sections; frontmatter concatenated to the first chunk; sections under 20 tokens skipped; SHA-256 content hashing (16 hex chars) for chunk-delta detection.
- **Electron-WASM compatibility**: `bun.config.ts` redirects `onnxruntime-node` resolves to a shim that re-exports `onnxruntime-web` (the WASM backend Electron renderer inherits as `process?.release?.name === 'node'`); `embedder.ts` configures `onnxruntime-web` env on first call (`wasmPaths` pointed at jsdelivr CDN for `onnxruntime-web@1.14.0` to work around Bun CJS losing `import.meta.url` for `.wasm` siblings; `numThreads = 1` because the renderer lacks COOP/COEP for SharedArrayBuffer; `allowLocalModels = false`; `useBrowserCache = true`).

### Added — Migration UX + client config (Phase 4)

- **First-load migration modal** (Svelte) shown at `app.workspace.onLayoutReady` when the detector finds at least one of: legacy `installLocation` / `platformOverride` keys in `data.json`, an orphan `mcp-server` binary at the previous install location (`INSTALL_PATH[platform]`), or a Claude Desktop config entry pointing at the binary (under either the new `mcp-tools-istefox` key or the legacy upstream `obsidian-mcp-tools` key). Three opt-in steps: rewrite Claude Desktop config (with `.backup`), delete the legacy binary, prune legacy keys. Each step independent; failure in one does not skip the others. `migration.skippedAt` persisted on dismiss / completion so the modal does not re-open on every plugin load.
- **`updateClaudeDesktopConfig`** rewrites the entry to the 0.4.0 shape (`{ command: "npx", args: ["-y", "mcp-remote", ..., "--header", "Authorization: Bearer …"] }`), backs up to `<configPath>.backup`, removes the legacy `obsidian-mcp-tools` key, refuses to overwrite malformed JSON.
- **Three "Copy config" buttons** under "Quick setup for clients": Claude Desktop (`npx mcp-remote` bridge), Claude Code (`{ type: "http", … }`), and a generic streamable-http payload for Cursor / Cline / Continue / Windsurf / VS Code.
- **Auto-wiring**: the first time the Settings tab is opened after the HTTP server starts on a new port, all three config snippets are regenerated with the live port.

### Added — Permission system (Phase 5)

- **Per-command allowlist** for `execute_obsidian_command`. The first call to any command ID shows an in-Obsidian modal listing the command label; the user confirms or denies. Confirmed IDs are persisted in `data.json` (`allowedCommands[]`); future calls skip the modal. The Settings tab shows the confirmed list with individual revoke buttons. Command IDs are trimmed before the permission decision.

### Changed

- **Plugin renamed**: `obsidian-mcp-tools` → `mcp-tools-istefox` (id), "MCP Connector" (display name). The upstream `jacksteamdev/obsidian-mcp-tools` id is reserved for the upstream project.
- **Package renamed**: `@obsidian-mcp-tools/mcp-server` is gone; the in-process bundle replaces it.
- **`minAppVersion` raised to `1.7.2`** (first Obsidian release with the `adapter.rmdir(path, recursive)` API used by directory tools added in 0.4.5).

### Removed

- **`mcp-server` package** — the external binary is gone. All tool handlers live in `packages/obsidian-plugin`.
- **`install.sh` / `install.ps1`** — no binary to install.
- **`mcp-server` npm publish step** from CI.

## [0.3.12] — 2026-04-28

### Changed

- Final 0.3.x maintenance release. Upstream declared the project officially unmaintained on 2026-04-24. The 0.3.x line is archived at `archive/main-0.3.12`. New development continues on the 0.4.x in-process branch.

## [0.3.0]–[0.3.11]

See the [archive branch](https://github.com/istefox/obsidian-mcp-connector/tree/archive/main-0.3.12) for the full 0.3.x history.

## [0.1.1]–[0.2.27]

Upstream changelog: [jacksteamdev/obsidian-mcp-tools](https://github.com/jacksteamdev/obsidian-mcp-tools/blob/main/CHANGELOG.md).

[Unreleased]: https://github.com/istefox/obsidian-mcp-connector/compare/0.12.0...HEAD
[0.12.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.12.0
[0.11.2]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.11.2
[0.11.1]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.11.1
[0.11.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.11.0
[0.10.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.10.0
[0.9.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.9.0
[0.8.2]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.8.2
[0.8.1]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.8.1
[0.8.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.8.0
[0.7.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.7.0
[0.6.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.6.0
[0.5.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.5.0
[0.4.10]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.10
[0.4.9]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.9
[0.4.8]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.8
[0.4.7]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.7
[0.4.6]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.6
[0.4.5]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.5
[0.4.4]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.4
[0.4.3]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.3
[0.4.2]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.2
[0.4.1]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.1
[0.4.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.4.0
[0.3.12]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.12
[0.3.11]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.11
[0.3.10]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.10
[0.3.9]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.9
[0.3.8]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.8
[0.3.7]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.7
[0.3.6]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.6
[0.3.5]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.5
[0.3.4]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.4
[0.3.3]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.3
[0.3.2]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.2
[0.3.1]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.1
[0.3.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.0
