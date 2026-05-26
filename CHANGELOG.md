# Changelog

All notable changes to **MCP Connector** (formerly `obsidian-mcp-tools`) are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- **Auto-write Claude Desktop config** opt-in toggle (default OFF). When ON, the plugin keeps `claude_desktop_config.json` in sync on token rotation / port change, with `.backup` written before each rewrite.
- **Bearer-token field** with Show / Copy / Regenerate; rotation invalidates the in-process transport and restarts it immediately so the new token takes effect on the next request.
- **Node.js detection** with launchctl-PATH fallback. macOS Obsidian launched from Finder/Spotlight inherits a minimal PATH that does not include `/opt/homebrew/bin` (Apple silicon) or `/usr/local/bin` (Intel) — plain `node --version` then ENOENTs even when Node IS installed. The detector now scans canonical absolute paths in addition to PATH-based lookup, on macOS, Linux, and Windows.
- **Homebrew detection** + one-click "Install via Homebrew" button (macOS) when Node is not on PATH but `brew` is available. Streams `brew install node` progress lines into the UI.
- **`mcp-remote` pre-warm**: runs `npx -y mcp-remote@latest` once via the absolute npx path derived from the detected Node, with the Node bin dir prepended to the child env PATH so npx's shebang `env node` lookup succeeds. Treats `mcp-remote`'s own `ERR_INVALID_URL` error as success (the package downloaded into `~/.npm/_npx/<hash>` — the goal of the pre-warm).

### Changed

- **Local REST API is now optional.** A missing LRA logs at debug level instead of showing the misleading "required" Notice. Only the `search_vault` tool (DQL / JsonLogic queries) needs it; it returns an actionable error to the MCP client when LRA is not installed. The other 19 tools work without it. The three legacy LRA endpoint registrations (`/search/smart`, `/templates/execute`, `/mcp-tools/command-permission/`) are no longer mounted — they were callbacks the 0.3.x binary used; in 0.4.0 the in-process MCP server calls Obsidian APIs directly.
- **`search_vault_smart` output shape** unified across providers: `{ filePath, heading, excerpt, score }`. Same shape whether the backend is Smart Connections or the native provider. Breaking vs the alpha.2 shape (which used `{ path, score, breadcrumbs, text }`).
- **`POST /templates/execute` response shape** (carried forward from 0.3.12): 503 body now includes `message` (#19) and success body now includes `path` (#20) — both contributed by @folotp, with the `tp.file.move()` semantic seam anchored as an inline design note in `handleTemplateExecution`.
- **`OBSIDIAN_HOST` accepts URL forms** (carried forward from 0.3.12): bare hostname (the documented form) and full URL with protocol+port both work; the wrapper detects `://` and parses via `parseApiUrl` (#21, originally upstream `jacksteamdev/obsidian-mcp-tools#84`).
- **0.3.x install surface retired** in 0.4.0 settings (`mcp-server-install/components/McpServerInstallSettings.svelte` no longer mounted; kept in tree for rollback safety; full removal in a follow-up).
- **Default `createTargetIfMissing: false` for `targetType: "heading"`**
  on `patch_active_file` / `patch_vault_file` (#58, reported by
  @folotp). Mirrors the v0.3.7 (#6) flip for `block` targets.
  Rationale: an unresolvable heading target (typo on the leaf,
  missing parent H1, stale heading reference) used to fall through
  to silent EOF append. In the dominant agent-caller use case the
  HTTP 200 is indistinguishable from a successful in-place patch
  without a post-write read, so silent-create is data corruption.
  The flip closes the residual silent-corruption surface that
  `detectOrphanRootHeading` (v0.3.9, #16) only partially covered.
  After the flip, per-target-type defaults are: `heading` →
  `false` (changed), `block` → `false` (unchanged from v0.3.7),
  `frontmatter` → `true` (unchanged). Callers that genuinely want
  the permissive create-on-missing behaviour for headings opt in
  explicitly with `createTargetIfMissing: true`. Pinned by 7 cases
  in `patchVaultFile.test.ts`.

### Fixed (post-`0.4.0-beta.1` batch — folotp soak)

The `0.4.0-beta.1` end-to-end soak by @folotp (macOS arm64, Obsidian
1.12.7, Local REST API 3.6.1) surfaced four regressions in the
in-process tool handlers vs the 0.3.x stable line. The in-process
patcher and `executeTemplate` tool were fresh writes, not 1:1 ports;
the hardening that 0.3.8 / 0.3.12 had added against the same call
shapes was not carried forward.

- **`patch_*_file` `targetType: "frontmatter"`, `operation: "replace"`,
  scalar content against an array-valued field** used to return HTTP
  200 while silently coercing the field from array to scalar (#12).
  `tags: [alpha, beta]` patched with `content: "gamma"` became
  `tags: gamma`, destroying the array structure with no signal to the
  caller. The branch now dispatches through a pure
  `planFrontmatterReplace` helper: when the existing field is an array,
  content must JSON-decode to an array (`'["new"]'`,
  `'["a","b"]'`) or `null` (clears the field); anything else returns
  `isError: true` with an actionable message naming the JSON forms.
  Mirrors the 0.3.8 `detectFrontmatterReplaceArrayMismatch` policy
  adapted to the in-process flow that no longer carries `contentType`.
- **`patch_*_file` `targetType: "frontmatter"`, `operation:
  "append"` / `"prepend"` against an array-valued field** used to
  flatten the array via `String(existing) + content`, producing
  comma-joined corruption like
  `tags: existing,new-tag"new-tag-040"` (#13). The branch now
  dispatches through a pure `planFrontmatterAppend` helper: when the
  existing field is an array, content is JSON-decoded if possible (a
  parsed array is spread; a parsed scalar is pushed as one element)
  and otherwise the raw content is pushed as a single string element
  (DWIM for naive callers that don't JSON-encode). Mirrors 0.3.8's
  `coerceFrontmatterAppendArrayContent`.
- **`execute_template` createFile success response was missing
  `path`** (#20). The 0.3.12 fix was already ported to
  `main.ts:handleTemplateExecution` in commit `03331b0`, but in 0.4.0
  that LRA endpoint is dead code: the in-process MCP server reaches
  Templater directly via `features/mcp-tools/tools/executeTemplate.ts`,
  which had been written fresh and missed the fix. The createFile
  success branch now returns `{ message, content, path:
  ctx.arguments.targetPath }`. The semantic contract is "the path
  this handler operated on" (not where Templater may have moved the
  file via `tp.file.move()`), forward-compatible with a future
  delegation to `templater.create_new_note_from_template(...)`.
- **`execute_template` errors were double-prefixed as
  `MCP error -32603: MCP error -32603: <text>`** in some clients
  (#19). The handler now catches Templater failures and surfaces them
  through the `isError: true` result shape with the underlying message
  verbatim, instead of throwing up to the registry's catch (which
  wraps in `McpError`, then the client wraps again). Matches the
  convention used by the other vault tools.

Bonus polish in the same batch:

- **`patch_*_file` heading `replace` consumed the blank line between
  the patched section and the next sibling/parent heading**, producing
  `## A\n<body>\n## B` instead of `## A\n<body>\n\n## B`. Re-emits the
  separator when the tail starts with a heading and the body does not
  already end blank.
- **`get_vault_file format: "json"` was missing the `stat` field**
  declared by the upstream `ApiNoteJson` contract
  (`packages/shared/src/types/plugin-local-rest-api.ts:31`). The
  response now includes `stat: { ctime, mtime, size }` populated from
  the `TFile`.

Internal: `patchActiveFile.ts` carries its own duplicate of
`applyPatch` (parallel to the one in
`services/patchHelpers.ts:applyPatch`); both are now wired through the
new `planFrontmatter*` helpers so the policy stays in one place.
Consolidating the two call sites is a separate refactor.

### Fixed (post-`0.4.0-beta.2` batch — folotp round 2 + 3)

Round-2 soak by @folotp on `0.4.0-beta.2` (2026-05-01) verified the
post-beta.1 regressions cleared, but surfaced two structural issues
that landed in `0.4.0-beta.3` (PR #75):

- **Legacy `POST /templates/execute` returned HTTP 404** on upgraded
  installs where the 0.3.x binary was still resident alongside the
  0.4.0 in-process plugin (#73). Phase 4 had dropped the LRA endpoint
  registrations as dead code — correct for a clean install, but the
  binary's transport layer expected the route to exist on the plugin
  side. The fix re-registers `POST /templates/execute` as a thin LRA
  `apiExtension` that proxies into the in-process `executeTemplate`
  handler. Backward-compatible response shape; no change for users on
  a clean 0.4.0 install.
- **`MCP error -<code>: MCP error -<code>: <text>` double-prefix on
  every throwing tool** (#74). The PR #69 local fix on
  `executeTemplate.ts` was the right shape but the wrong scope: the
  underlying double-wrap was happening in the `ToolRegistry` outer
  catch for any tool that propagated an `McpError`. The fix hoists
  the same `isError: true` envelope from `executeTemplate.ts` up to
  `ToolRegistry.dispatch()`. Every tool that throws —
  `patch_vault_file`, `patch_active_file`, the rest — now returns
  the cleaner single-prefix envelope. The `executeTemplate.ts` local
  fix is kept as defence-in-depth.

Round-3 soak on `0.4.0-beta.3` (2026-05-04) confirmed both fixes
plus the carryover regression family: #12, #13, H2-root reject, stat
field, block-in-table 400, YAML auto-quote — all clean. One cosmetic
issue (#76, heading-replace blank-line consumption) deferred to
`0.4.1`.

### Continuous integration

- New `.github/workflows/ci.yml` runs `bun run check` + per-package `bun test` on every push to `main` and `feat/http-embedded`, plus on every PR targeting either branch. Cancels in-flight runs for the same ref when a new push lands.

### Tests

613 unit + integration tests pass across the plugin package (528+
through `0.4.0-beta.1`, +28 in the post-beta.1 fix batch covering the
frontmatter / `execute_template` / heading-replace regressions above,
+31 in the post-beta.2 fix batch (PR #75) covering the templates
compat shim and the registry-level `isError` envelope):

- 87 across `features/migration/` and `features/mcp-client-config/` (Phase 4).
- 123 across `features/semantic-search/` (Phase 3).
- 244 across `features/mcp-transport/`, `features/core/`, `features/access-control/`, settings (Phase 1).
- The remaining baseline carried forward from 0.3.x: tool registry, command-permissions, mcp-server-install, plus the patch / smart-search / templates regression suites — augmented with 17 unit cases on the new `planFrontmatter*` helpers and 11 integration cases on the patch tools.

### Known limitations

- **`Disabled MCP tools` (toolToggle) UI hidden in 0.4.0.** On 0.3.x the toggle wrote `OBSIDIAN_DISABLED_TOOLS` into the binary's env and the binary read it at startup to filter the registered tools. The 0.4.0 in-process registry has no equivalent gating path yet, so showing the UI would be misleading — the user could "disable" a tool that would still be reachable on the next call. The persisted `toolToggle.disabled` slice in `data.json` is left intact, so future installs can read it back without losing data; a 0.4.x follow-up will wire registry gating and re-mount the UI.

### References

- Design: [`docs/design/2026-04-24-http-embedded-design.md`](docs/design/2026-04-24-http-embedded-design.md)
- Phase plans: `docs/plans/0.4.0-phase-{1,2,3,4}-*.md`
- Upstream context: [`jacksteamdev/obsidian-mcp-tools#79`](https://github.com/jacksteamdev/obsidian-mcp-tools/issues/79) (official unmaintained, 2026-04-24)
- Pre-release tags: `0.4.0-alpha.1`, `0.4.0-alpha.2`, `0.4.0-alpha.3`, `0.4.0-alpha.4`, `0.4.0-beta.1`, `0.4.0-beta.2`, `0.4.0-beta.3` — see [GitHub Releases](https://github.com/istefox/obsidian-mcp-connector/releases) for the full per-tag detail.

## [0.3.12] — 2026-04-28

### Fixed
- **Re-release of 0.3.11 with `bun.lock` aligned to the workspace
  `package.json` files.** The 0.3.11 tag's release workflow failed at
  `bun install --frozen-lockfile` because the lockfile shipped on the
  tag had ~100 lines of drift introduced during the rapid back-to-
  back Dependabot merges (most likely the vite v5→v8 rebase). No
  release artifacts were produced for 0.3.11 — the GitHub release
  exists as metadata only, with zero attached binaries — so BRAT users
  on `main` were unable to download it. This release contains the
  same code as 0.3.11 plus a regenerated lockfile, and re-runs the
  release workflow cleanly.

  Per the branch protection policy, tags on the 0.3.x line are not
  re-pointed; the corrective release ships as 0.3.12.

## [0.3.11] — 2026-04-28

### Fixed
- **`POST /templates/execute` dropped the caught error message from
  the response body** (#19, reported by @folotp). The catch block in
  `handleTemplateExecution` captured `error.message` for the logger
  but the HTTP response always returned the generic
  `{"error": "An error occurred while processing the prompt"}`.
  Templates that throw on validation (a `tp.user.*` function
  enforcing a controlled vocabulary, or `<%* throw new Error(...) %>`
  inside a template) produced clean, actionable messages that were
  invisible to anything reading the HTTP response — only the plugin's
  developer-console logger had them. The 503 body now includes an
  additive `message` field alongside the existing `error`. Backwards-
  compatible: every current client keeps working; clients that opt
  into `message` get richer diagnostics. `String(error)` fallback
  handles `throw "string"` and `throw {custom}` without pattern
  matching.
- **`OBSIDIAN_HOST=http://...` produced a malformed BASE_URL with a
  doubled protocol** (#21, originally upstream
  `jacksteamdev/obsidian-mcp-tools#84`). The variable was read as a
  raw hostname and concatenated under a fixed `https://` prefix, so a
  user setting `OBSIDIAN_HOST=http://127.0.0.1:27123` (a full URL — a
  common mistake given how the variable name reads) ended up with
  `BASE_URL=https://http://127.0.0.1:27123:27124` and every request
  failed. New `resolveHostOverride(raw)` helper detects the `://`
  substring and parses the URL via the existing `parseApiUrl`. Bare
  hostnames keep working unchanged. When a URL form is used, its port
  and protocol parts feed PORT/USE_HTTP only where the more specific
  variables (`OBSIDIAN_PORT`, `OBSIDIAN_USE_HTTP`) are unset. New
  `logger.info("Obsidian REST API base URL", { url: BASE_URL })` at
  module load surfaces this class of misconfiguration in the log file
  without requiring a network round trip to discover. Six new tests
  in `makeRequest.test.ts` (40 total, all green).

### Added
- **`POST /templates/execute` success response now includes `path`**
  (#20, reported by @folotp). When `createFile: true` and `targetPath`
  are both set, the success body adds `path: params.targetPath`
  alongside the existing `message`/`content`. Collapses the two-call
  create-and-locate dance some MCP wrappers were forced into. Field
  added only in the `createFile: true` branch (the `false` branch does
  not operate on a file). Field name `path` chosen to align with the
  Local REST API convention (`GET /vault/{path}`) and to be forward-
  compatible with a future refactor that would delegate to
  `templater.create_new_note_from_template(...)` and read
  `tp.config.target_file.path`.

## [0.3.10] — 2026-04-26

### Changed
- **Diagnostic logging in `updateClaudeConfig`** to make Install
  Server failures self-diagnosable from the Obsidian developer
  console. INFO at entry (configPath, presence/length of serverPath
  and apiKey, extraEnv keys), DEBUG when reading existing config
  (pre-existing `mcpServers` keys, whether our entry was already
  there), ERROR with structured context (`errorName`, `errorCode`,
  `errorMessage`) on non-ENOENT read failures, INFO post-write
  (final `mcpServers` keys, whether our entry was persisted, length
  of our command). No credential leak — only flags and lengths are
  ever logged. Motivated by fork issue #11 (folotp), where the
  symptom (`mcpServers: {}` after Install with location=outside
  vault) could not be reproduced from the code path; the new logs
  pinpoint root cause unambiguously when the next user hits the
  same symptom.
- **8 new regression tests** in `config.test.ts` pinning the
  invariants `updateClaudeConfig` upholds across edge cases:
  folotp's exact toggle sequence, `serverPath` empty/undefined,
  malformed/empty/BOM-prefixed existing config, missing
  `mcpServers` key. All proven on `main`; act as guard rails
  against future regressions that would match the #11 symptom.

## [0.3.9] — 2026-04-26

### Fixed
- **`patch_vault_file` / `patch_active_file` silently EOF-appended
  content when targeting a root-orphan heading** (`targetType:
  "heading"`, `operation: "replace"`/`"append"`/`"prepend"`, leaf
  name pointing at a non-H1 heading at the root of the file with no
  level-1 (`#`) parent). Same family as the silent EOF append
  behaviour fixed for `block` targets in #71 (0.3.7). Root cause: the
  Local REST API's `markdown-patch` indexer keys headings by their
  full hierarchical path starting from H1, so a root-orphan H2/H3/…
  cannot be addressed by leaf name. With the upstream-compat default
  `Create-Target-If-Missing: true` for headings, the PATCH fell
  through to the silent-create branch and returned HTTP 200 with the
  caller's content appended at EOF, leaving a duplicate heading and
  no in-place edit.

  The wrapper now calls a new `detectOrphanRootHeading` helper
  immediately after fetching the file content (which it already
  needed for `resolveHeadingPath` — no extra GET roundtrip) and
  throws `McpError(ErrorCode.InvalidParams, …)` with an actionable
  message before the silent corruption can land. The error message
  documents both workarounds: add a level-1 heading at the top of
  the file, or pass `createTargetIfMissing=false` to make the
  failure explicit.

  Twelve regression tests in `patchVaultFile.test.ts` pin the
  detection: @folotp's exact repro, the canonical valid cases (H1
  root, H2 nested under H1, H3 under H1+H2), the orphan
  generalization to H3 and H3-under-orphan-H2, the first-match-wins
  ambiguity rule, and defensive cases (heading not found, empty
  content, mid-paragraph fake-heading text, sticky H1 ancestor
  flag). Closes the heading half of upstream
  `jacksteamdev/obsidian-mcp-tools#71`; reported by @folotp on the
  v0.3.7 follow-up.

## [0.3.8] — 2026-04-26

### Fixed
- **`search_vault_smart` returned HTTP 400 `must be a string (was an
  object)` on every call** — the plugin-side `/search/smart` endpoint
  validated `req.body` with `string.json.parse → searchRequest`, but
  Express had already parsed the body via `bodyParser.json()` upstream.
  ArkType saw an object, failed the `string` domain check, and the
  handler 400'd before Smart Connections was ever invoked, making
  semantic search fully unreachable from any MCP client (Claude
  Desktop, Claude Code, Cline). Promoted `searchRequest` to a public
  export and dropped the obsolete `jsonSearchRequest` alias; the
  caller now binds against the parsed-object schema directly. Six
  regression tests in `packages/shared/src/types/smart-search.test.ts`
  pin the parsed-object contract (minimal `{query}`, populated
  `filter`, empty `filter: {}`, missing/empty `query`, and an
  explicit guard against the double-parse regressing). Closes #9;
  contributed by @ezrahill (#10).
- **`patch_vault_file` / `patch_active_file` silently destroyed
  array-valued frontmatter fields on `replace` with text/markdown
  content** — same family as the silent EOF append behaviour fixed
  for `targetType: "block"` in #71 (0.3.7). The wrapper now
  pre-fetches the parsed frontmatter (one extra GET, only when the
  call shape is `frontmatter + replace + non-JSON content`) and
  rejects with `McpError(InvalidParams, …)` when the target field is
  an array. The error message points the caller at the JSON-content
  escape hatch with concrete examples (`'["new"]'` for a
  single-element array, `'null'` to clear). Pre-fetch is best-effort:
  if the GET fails (404, permission), the precheck is skipped and the
  original PATCH propagates its own error. The new helper
  `detectFrontmatterReplaceArrayMismatch` is pure / synchronous and
  unit-tested in isolation (10 cases). Closes #12; reported by
  @folotp.
- **`patch_vault_file` / `patch_active_file` returned HTTP 500 on
  frontmatter `append` / `prepend` with a JSON scalar payload** — the
  upstream Local REST API parser cannot handle a scalar value on the
  array-form append/prepend op. The wrapper now auto-wraps a JSON
  scalar in a single-element array client-side via
  `JSON.stringify([parsed])` before forwarding the PATCH —
  unambiguous DWIM since there is exactly one reasonable
  interpretation (append THIS element to the array). Only triggers on
  `targetType: "frontmatter" + (append|prepend) +
  contentType: "application/json"` to keep the surface area minimal;
  malformed JSON is forwarded untouched so the REST API surfaces its
  own error. The `normalizeAppendBody` `\n\n` trailer is intentionally
  skipped on the JSON branch so it does not invalidate the JSON body.
  The new helper `coerceFrontmatterAppendArrayContent` is pure /
  synchronous and unit-tested in isolation (10 cases covering
  string/number/boolean/null/object scalars, array passthrough,
  prepend symmetry, malformed JSON, and four pass-through paths).
  Closes #13; reported by @folotp.

### Changed
- Added 20 regression tests in `packages/mcp-server/src/features/local-rest-api/patchVaultFile.test.ts`
  (10 for #12 + 10 for #13) pinning the frontmatter precheck and
  scalar auto-wrap behavior against accidental regression.

## [0.3.7] — 2026-04-24

### Fixed
- **`patch_active_file` / `patch_vault_file` block-in-table silent
  corruption** — `Create-Target-If-Missing` now defaults per target
  type: `true` for `heading` and `frontmatter` (upstream 0.2.x compat,
  unchanged), `false` for `block`. `markdown-patch`'s block indexer
  does not search inside markdown table cells, so a block `^id` sitting
  in a cell was unresolvable; under the previous single `true` default,
  the Local REST API silently appended the caller's `content` at EOF
  and returned HTTP 200. Retries compounded the damage. Block targets
  now fail loud on unresolved ids so callers can decide the recovery
  path explicitly. Heading + frontmatter behavior is preserved.
  Closes the block-in-table half of upstream issue #71 (heading half
  was fixed in 0.3.0); reported by @folotp.

### Changed
- Updated the JSDoc on `ApiPatchParameters.createTargetIfMissing` and
  the runtime `.describe()` string so model callers see the new
  per-target-type default contract.
- Added 6 regression tests in `patchVaultFile.test.ts` pinning the
  per-target-type defaults (block → false, heading → true,
  frontmatter → true) against accidental regression, plus opt-in
  overrides for block targets (explicit `true` and `false`) and
  heading-target strict-mode (explicit `false`).

## [0.3.6] — 2026-04-24

### Fixed
- `get_vault_file(format: "json")` failed ArkType validation on any
  note whose frontmatter contained a list-valued key — `aliases`,
  `tags`, `up`, `down`, `next`, `previous`, `cssclasses`, etc. are
  routinely arrays in Obsidian Flavored Markdown. The `ApiNoteJson`
  schema declared `frontmatter: Record<string, string>`, so Local
  REST API's correct array payload was rejected at the wrapper
  boundary with `frontmatter.aliases must be a string (was an
  object)`, making the `json` format effectively unusable on
  realistic vaults. Widened the shape to `Record<string, unknown>`
  to match YAML/OFM semantics. Added 7 regression tests in
  `plugin-local-rest-api.test.ts` covering the canonical aliases
  repro, the full OFM convention set (aliases + tags + up + down +
  next + previous + cssclasses), mixed scalar+array frontmatter,
  non-string scalars (number, boolean, null), nested mapping
  values, empty frontmatter, and a sanity check that the top-level
  schema was not incidentally widened. Fixes upstream issue #81,
  diagnosed by @folotp.

## [0.3.5] — 2026-04-23

### Fixed
- **"Install Server" returned 404 on every platform since the fork** —
  `packages/obsidian-plugin/bun.config.ts` hardcoded a `define` entry
  for `process.env.GITHUB_DOWNLOAD_URL` pointing at
  `jacksteamdev/obsidian-mcp-tools/releases/download/<version>`. The
  `define` ran at bundle time and silently overrode the
  `GITHUB_DOWNLOAD_URL` env var injected by `.github/workflows/release.yml`,
  so every shipped `main.js` looked for `mcp-server-windows.exe` (and
  the macOS/Linux equivalents) on the dormant upstream repo where the
  fork versions do not exist. Switched the `define` to read
  `process.env.GITHUB_DOWNLOAD_URL` at build time with a
  fork-repo fallback for local builds. Same treatment for
  `GITHUB_REF_NAME`. The build-time ArkType macro in
  `features/mcp-server-install/constants/bundle-time.ts` now receives
  the correct values in CI. Reported in #3.

## [0.3.4] — 2026-04-21

### Added
- `get_vault_file` now returns native MCP `image` and `audio` content
  blocks for supported binary types (PNG, JPEG, GIF, WebP, SVG, BMP,
  MP3, WAV, OGG, M4A, FLAC, AAC, WebM audio), so multimodal clients
  can render them inline instead of receiving an opaque base64 blob
  in a text response. Files above a 10 MiB inline cap, plus unsupported
  types (video, PDF, Office, archives), still get a JSON metadata
  object with the same API path / MIME fields as before, and a
  machine-readable `hint` describing why the body was not inlined.
  Builds on the 0.3.0 short-circuit for #59; lifts the text-only
  fallback now that SDK 1.29.0 ships native binary content types.

### Changed
- Widened the `ToolRegistry` result schema to accept `audio` content
  blocks alongside `text` and `image`, matching MCP SDK 1.29.0.
- Added `makeBinaryRequest` in `shared/makeRequest.ts` for the new
  binary code path — reuses the same auth and path-normalization
  layer as `makeRequest` but returns raw bytes plus the upstream
  `Content-Type` header instead of decoding as text/JSON.

## [0.3.3] — 2026-04-21

### Added
- `OBSIDIAN_API_URL` env var support as a convenience alias that
  parses into host / port / protocol. The more specific
  `OBSIDIAN_HOST`, `OBSIDIAN_PORT` and `OBSIDIAN_USE_HTTP` variables
  still take precedence when set, preserving drop-in compatibility
  with upstream v0.2.x configurations. Fixes upstream issue #66.

### Fixed
- `normalizeInputSchema` now strips `additionalProperties: {}` (the
  empty-object form emitted by some schema generators), which
  strict MCP validators such as Letta Cloud reject with a 500.
  `additionalProperties: true`, `false`, and genuine sub-schemas are
  left untouched. Fixes upstream issue #63.
- `makeRequest` collapses consecutive slashes in request paths, so a
  caller-supplied directory with a trailing slash (`"DevOps/"`) no
  longer produces `/vault/DevOps//` and the subsequent 404 from the
  Local REST API. Fixes upstream issue #37.

### Changed
- Extracted `buildPatchHeaders` and `normalizeAppendBody` from the
  `patch_active_file` / `patch_vault_file` handlers as pure helpers,
  and added regression tests for the URL-encoded `Target` header
  (Cyrillic, CJK, accented + bracketed strings) and the trailing-
  newline safeguard on `append`. No behavior change — this pins
  the 0.3.0 fixes for upstream issues #30, #71, and #78 against
  accidental regression.
- Extended the regression-test pin to cover three additional 0.3.0
  fixes that were landed but never credited or test-covered:
  client-side `limit` truncation on `search_vault_simple` (#62),
  the optional `certificateInfo` / `apiExtensions` shape on the
  Local REST API root response (#68), and the optional
  `frontmatter.tags` on `ApiVaultFileResponse` that unblocks
  `execute_template` for tagless Templater templates (#41).
  Extracted `applySimpleSearchLimit` as a pure helper for symmetry
  with the other patch-handler extracts. No behavior change.
- Audit pass over the 2026-04-11 cluster commits surfaced nine
  additional upstream issues that were fixed during the 0.3.0 cut
  but never credited in the CHANGELOG: #39 (`search_vault_smart`
  Content-Type), #61 (disable individual tools via env var + UI),
  #59 (binary-file short-circuit in `get_vault_file`), #35 + #60
  (non-Claude-Desktop MCP client docs), #28 (install outside the
  vault), #26 (platform override for binary selection), #31 + #36
  (Linux installer path handling), #40 + #67 (configurable Local
  REST API port). Credit entries added below under `0.3.0 Fixed`
  with commit SHAs. No behavior change — the fixes have been in
  production since 2026-04-11.
- Added a regression pin for issue #39: the `search_vault_smart`
  tool handler now has a test asserting the explicit
  `Content-Type: application/json` header survives future refactors.
  The plugin-side `/search/smart` endpoint only parses bodies whose
  Content-Type matches `application/json`; losing the header would
  silently reintroduce the "semantic search returns no results"
  failure mode. No behavior change.

## [0.3.2] — 2026-04-17

### Changed
- Migrated the MCP server from the deprecated `Server` class to `McpServer` (SDK 1.29.0 high-level API). The underlying `Server` is still reachable via `McpServer.server` for the low-level `setRequestHandler` routing used by the custom `ToolRegistry`.
- Sentence-case pass on user-facing `Notice` text.

### Fixed
- Lint pass over the `ObsidianReviewBot` findings across all three packages (plugin, shared, MCP server):
  - typed error stringification (`error instanceof Error ? error.message : String(error)`) on every template-literal fallback;
  - `void`-prefixed fire-and-forget Svelte `mount`/`unmount` and `bun:test` `mock.module` calls;
  - removed useless `async` on `setup()` helpers and `getLocalRestApiKey`; added `.catch()` handler on the RxJS `lastValueFrom` in `main.ts`;
  - removed `any` from the Smart Connections v2/v3 compatibility wrapper via minimal inline types (both code paths preserved);
  - replaced the workspace self-import in `packages/shared` with a relative path;
  - miscellaneous cleanups: `String.raw` regex literal, `parseInt` radix, unused catch bindings, unused imports, empty-object types tightened.

## [0.3.1] — 2026-04-13

### Fixed
- Trimmed the `manifest.json` description to satisfy community-store reviewer-bot rules (removed the `Obsidian` token, aligned with the description used in `community-plugins.json`).

## [0.3.0] — 2026-04-13

### Added
- Rebrand to **MCP Connector** (`id: mcp-tools-istefox`, author: Stefano Ferri). The fork is now publicly published as `istefox/obsidian-mcp-connector`.
- Issue #29 command-execution feature set: per-vault allowlist + confirmation modal + audit log + presets, all gated by a master toggle (disabled by default). See `docs/design/issue-29-command-execution.md` for the full threat model.
- End-user README rewrite covering installation, configuration, MCP-client compatibility, security posture, and development workflow.
- Migration guide for users switching from upstream (`docs/migration-from-upstream.md`).

### Fixed
- `bun run version <part>` now reads the semver part from the correct argv index (was always falling back to `patch`).
- Release pipeline paths corrected so the cross-platform build workflow produces the expected artifacts.
- Upstream issue #77 regression: tools with `arguments: {}` now emit `inputSchema` with an explicit `properties` key — fixes strict MCP clients such as `openai-codex`.
- Smart Connections v3 compatibility (the wrapper now handles both `window.SmartSearch` in v2.x and `env.smart_sources` in v3+).
- `patch_active_file` / `patch_vault_file`: resolve partial heading
  names to full hierarchical paths (e.g. `"Section A"` →
  `"Top Level::Section A"`) before issuing the PATCH, preventing
  silent content corruption when the target sits under a parent
  heading. Fixes upstream issues #30 and #71. (Shipped in the
  0.3.0 cut via commit `d75e493`; credited retroactively here.)
- `patch_active_file` / `patch_vault_file`: URL-encode the `Target`
  and `Target-Delimiter` HTTP headers so non-ASCII heading names
  (Cyrillic, CJK, emoji, accented characters) survive the HTTP
  header grammar. Encoding happens after path resolution so the
  indexer lookup still matches unencoded file content. Fixes
  upstream issue #78.
- `patch_active_file` / `patch_vault_file`: append content is now
  normalized to end with `\n\n` so subsequent sections remain
  visually separated instead of colliding (e.g. `**done**## Next`).
- New `createTargetIfMissing` parameter on both patch tools lets
  callers opt into strict mode (return an explicit error instead
  of silently creating a new target at EOF when the lookup fails).
  Defaults to `true` for upstream compatibility.
- `search_vault_simple`: added an optional `limit` parameter that
  truncates the result array client-side (the underlying Local
  REST API `/search/simple/` endpoint has no native `limit` flag,
  so we slice after receiving the response). Prevents context-
  window overflow on common terms that match thousands of files,
  which otherwise forces MCP clients into the "tool result stored
  to a file" fallback and breaks conversational flow. Fixes
  upstream issue #62. (Shipped in the 0.3.0 cut via commit
  `539e115`; credited retroactively here.)
- `ApiStatusResponse`: `certificateInfo` and `apiExtensions` are
  now optional on the Local REST API `GET /` root response. The
  plugin emits them only when the caller is authenticated, so
  the MCP server's startup probe (which runs before auth is in
  place for some flows) must still accept the trimmed body —
  hard-requiring them made every MCP tool call fail with an
  ArkType validation error on Local REST API v3.4.x. Fixes
  upstream issue #68. (Shipped in the 0.3.0 cut via commit
  `92b233c`; credited retroactively here.)
- `ApiVaultFileResponse`: `frontmatter.tags` is now optional.
  Obsidian emits the `tags` key only when the note's YAML
  frontmatter actually declares one — very common for Templater
  templates and freshly-created notes to lack it. The previous
  hard requirement surfaced as `frontmatter.tags must be an
  array (was null)` and broke `execute_template` and prompt
  loading. Fixes upstream issue #41. (Shipped in the 0.3.0 cut
  via commit `0b39524`; credited retroactively here.)
- `search_vault_smart`: explicit `Content-Type: application/json`
  header on the POST to `/search/smart`. The default Content-Type
  inherited from `makeRequest` is `text/markdown` (correct for
  file-content endpoints, wrong for JSON-body endpoints); Express's
  `bodyParser.json()` only parses bodies with an `application/json`
  Content-Type, so the plugin handler was seeing an empty `req.body`
  and rejecting every semantic search. Fixes upstream issue #39.
  (Shipped in the 0.3.0 cut via commit `0b39524`; credited
  retroactively here.)
- New `OBSIDIAN_DISABLED_TOOLS` env var and plugin settings UI
  let users opt out of specific MCP tools by name (comma-separated
  list). Unknown names log warnings but do not abort startup. The
  plugin-side UI writes the env var into
  `claude_desktop_config.json` automatically so GUI-only users
  don't have to hand-edit their MCP client config. Fixes upstream
  issue #61. (Shipped in the 0.3.0 cut via commits `7ba5f3a` +
  `7733bd8`; credited retroactively here.)
- `get_vault_file` on a binary file (audio, image, video, PDF,
  Office, archive) used to crash or return UTF-8-corrupted bytes.
  It now short-circuits on binary filenames and returns a
  structured `{ kind: "binary_file", mimeType, hint }` payload
  directing the caller to `show_file_in_obsidian`. Extension-based
  detection against ~45 common binary extensions; textual formats
  (md, json, yaml, html, csv, txt, svg) remain on the normal read
  path. Fixes upstream issue #59. (Shipped in the 0.3.0 cut via
  commit `f6d004a`; credited retroactively here. Native SDK 1.29.0
  audio/image responses are a separate follow-up.)
- README documents setup for non-Claude-Desktop MCP clients
  (Claude Code, Cline, Continue, Zed, generic clients) with
  per-platform binary paths, the full env var table, and a
  generic `mcpServers` config template. Fixes upstream issues #35
  and #60. (Shipped in the 0.3.0 cut via commit `aa1697a`;
  credited retroactively here.)
- Install-location flexibility: users can now install the MCP
  server binary outside the vault (the new default, placed under
  the standard per-user application directory) or opt into the
  legacy in-vault layout. A migration banner detects existing
  in-vault binaries and offers a one-click move to the system
  path, preserving the Claude Desktop config entry. Fixes upstream
  issue #28. (Shipped in the 0.3.0 cut via commits `4552c18` +
  `ce8a4bd`; credited retroactively here.)
- Platform override for server-binary selection via an Advanced
  setting in the plugin UI and `OBSIDIAN_SERVER_PLATFORM` /
  `OBSIDIAN_SERVER_ARCH` env vars. Needed when Obsidian is running
  under WSL, Bottles, wine, or another translation layer where
  the auto-detected OS/arch does not match the client that will
  launch the binary. Invalid values fall through to auto-detect
  rather than throwing. Fixes upstream issue #26. (Shipped in the
  0.3.0 cut via commit `2121ecf`; credited retroactively here.)
- Linux installer path handling: POSIX-vs-Win32 absoluteness check
  order corrected so a leading `/` is no longer mis-identified as
  a Win32 drive root; the Claude Desktop Linux config path now
  uses the correct capital-`C` / full filename
  (`~/.config/Claude/claude_desktop_config.json`); and
  realpath-induced duplicate path segments (common on iCloud
  Drive / symlinked vault layouts) are collapsed before the
  filesystem check. Fixes upstream issues #31 and #36. (Shipped
  in the 0.3.0 cut via commit `67637f4`; credited retroactively
  here. The same commit also addressed #37, credited separately
  under 0.3.3.)
- `OBSIDIAN_PORT` env var and `--port <value>` / `--port=<value>`
  CLI flag let users point the MCP server at a non-default Local
  REST API port. Precedence chain (highest first): CLI flag > env
  var > protocol default (27124 HTTPS, 27123 HTTP). Needed for
  multi-vault setups, WSL, and security-hardened deployments.
  Fixes upstream issues #40 and #67. (Shipped in the 0.3.0 cut
  via commit `04765b9`; credited retroactively here.)

## Earlier

Release history before the community-continuation rebrand lives in the upstream repository at
[`jacksteamdev/obsidian-mcp-tools`](https://github.com/jacksteamdev/obsidian-mcp-tools) up to `0.2.27`.

[0.3.3]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.3
[0.3.2]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.2
[0.3.1]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.1
[0.3.0]: https://github.com/istefox/obsidian-mcp-connector/releases/tag/0.3.0
