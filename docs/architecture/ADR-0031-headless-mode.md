# ADR-0031: Headless mode: the vault tools served from a folder, without Obsidian

- **Status:** Accepted and implemented
- **Date:** 2026-10-15
- **Scope:** A standalone Node process that serves a subset of the MCP vault tools from a vault directory, its launch modes, its distribution and how it reuses the shared code without changing it
- **Relates to:** [ADR-0016](/docs/architecture/ADR-0016-omc-008-adopt-mcp-spec-2026-07-28.md) (era routing, reused unchanged), [ADR-0020](/docs/architecture/ADR-0020-omc-040-vault-folder-exclusion.md) (the guarded `App` wraps the headless app too), [ADR-0014](/docs/architecture/ADR-0014-per-client-tool-profiles.md) (token policy, reused)

## Context

The connector runs inside Obsidian's renderer, so a Linux server with no desktop cannot use it.
Discussion #608 asks for the same tools against a plain folder of notes.
Headless Obsidian MCP servers exist and are launched by the client over stdio with only a vault path, so that is the bar for setup.

The tools never touch Obsidian directly.
They call a small surface of `App` (`vault`, `metadataCache`, `fileManager`, `workspace`) and import `TFile` for `instanceof` checks.
That surface can be implemented over a directory, and the existing composition root, token store and both protocol eras can serve it unchanged.
What stood in the way was structural: the composition root, the transport setup and the tool registration are typed with the Obsidian plugin class, a few modules reach Svelte and `Modal` through feature barrels, and two timer sites call `window.setTimeout`.

The plugin is also the part of the project that runs inside Obsidian's renderer, where a rare load-time crash on Obsidian 1.14.4 (Electron 43) is still being investigated (#597, #609).
Headless runs in plain Node, so it cannot be part of that crash, and this change is built so it cannot affect it either: **no file the desktop plugin bundles is changed.**
`bun run build` produces a byte-identical `main.js` before and after, which anyone can check with one hash.

## Decision

1. **The shared code is reused as it is.**
   Headless imports the shared composition root, transport setup, token store, tool schemas and tool handlers without editing them.
   The files they sit in are not touched, and the desktop bundle does not import anything under `src/headless`.
2. **Headless-side wiring instead of shared seams.**
   - *Tool set.* `src/headless/registerTools.ts` exports the same `registerTools` as the desktop `features/mcp-tools/index.ts`, with the same context, and registers the shared schema and handler of every tool that needs only a vault-shaped `App`.
     The shared composition root imports the desktop one, so `bun.headless.config.ts` points that single import at the headless file when it bundles.
     The build fails if the redirect is not used.
     Headless serves 42 tools plus the three adaptive-loading meta-tools.
     `registerTools.test.ts` builds both registries and requires the headless set to equal the desktop set minus an explicit list of desktop-only tools (`toolSets.ts`: the open file and workspace, commands, Dataview, Templater, bookmarks), with identical schemas, descriptions, annotations and titles.
     A tool added on the desktop therefore fails that test until it is either served or listed as desktop-only.
   - *Host.* The shared transport and tool code is typed with the plugin class and reads only `app`, `manifest`, `loadData` and `saveData`, plus `mcpTransportState` and `semanticSearchState` that the entry assigns.
     Headless passes an object with those members, cast once in `hostData.ts`.
   - *Timers.* Shared code calls `window.setTimeout` and its three siblings, which do not exist in Node.
     The bundle rewrites those four calls to `globalThis`.
     No `window` is defined at run time, because libraries read one as a sign of a browser.
     A define says nothing when it stops matching, so the build checks the output: it fails if a timer call still goes through `window`, if one of the rewritten kinds is no longer found, or if the bundle reads a `window` property or Obsidian's `activeWindow` that is not on a short list of known library uses.
     A new use in shared code therefore stops the build until someone decides what it should do in Node.
     The check is by property name, so a new use of a name already on the list is not caught.
   - *Barrels.* The semantic search feature takes its mutex from the `command-permissions` barrel, which pulls in a modal and the Svelte runtime.
     The bundle points that import at `shared/settingsLock`, where the mutex lives, and replaces any other `.svelte` file with a stub that throws when called.
   - *Instructions.* The `initialize` text is the desktop one, which also names Dataview and Templater.
     `tools/list` is exact and is what clients use.
     Making the text a parameter would be a shared change, so it is left for later.
3. **A directory-backed `App`.**
   `HeadlessApp` implements the retained subset of the `App` surface over a file index, and `createGuardedApp` wraps it unchanged.
   Own writes update the index and the metadata before the promise resolves.
   Writes to one path run in a per-path queue, read fresh and land atomically (temp file in the same directory, then rename).
   A read-modify-write (`vault.process`, which every editing tool uses) checks right before the rename that the file still holds the bytes it read, and otherwise fails with a message to retry (reason `ECONFLICT`), so an edit made in another program during the tool call is not overwritten.
   The check cannot be atomic with the rename: a program that writes in the few system calls between them still loses its edit.
   An edit keeps the file's permission bits but replaces the file, so its birth time (the created time `get_file_info` reports) resets and hard links to it are not preserved.
   The `obsidian` import is aliased at build time to a runtime shim that exports only what the retained graph needs.
   An error the headless side raises to explain a refusal (a path the vault does not serve, a conflicting edit) carries a `reason`, not a `code`.
   The shared tools replace the message of an error that has a `code` with a generic phrase and drop its host paths, so the explanation would be lost.
   With a `reason` the message reaches the client. The vault writes its own root as `<vault>`, and the tools' error helper scrubs other absolute paths only on a best-effort basis that stops at a space, so a `reason` error never names a path outside the vault.
   A `code` is kept for an error that stands for a real errno and that code reads, such as the `ENOENT` and `EACCES` that `delete_vault_directory` maps to its own answers.
4. **Confinement.**
   Every path is normalised (no `..`, absolute paths, NUL bytes or dot-segments) and joined on the realpath of the vault root, taken once at startup.
   Symlinks inside the vault are ignored: they are not indexed, and a path through one is refused.
   Dot-folders are not indexed, read or written.
   On POSIX a backslash is a file name character, so a name that holds one is left out of the index and a path that holds one is refused with an explanation, rather than read as a `/` and mapped to a different file.
   Host paths are stripped from error messages.
5. **Own metadata parser.**
   A line-oriented parser produces the `CachedMetadata` fields the tools read, and a link resolver reproduces `getFirstLinkpathDest` and `resolveSubpath`.
   Any change to the file set recomputes every file's link entries, so a created target resolves an unchanged source.
   A non-recursive `fs.watch` on each visible folder (none on dot-folders or symlinks) with a per-path debounce reconciles external edits, and a folder change or a watcher error closes the watches, rewatches the folders and rescans. The watcher opens before the initial scan and holds its events until the scan is done, then reconciles them, so an edit made during startup is not lost.
6. **Two launch modes.**
   Stdio is the default: `obsidian-mcp-headless /path/to/vault` (or `OBSIDIAN_VAULT`), spoken by the client that spawned it.
   There is no token, so the session is served under a stored policy with the full tool profile.
   `--http` is the service mode: loopback only, bearer token from the existing token store, state file outside the vault with mode `0600`, `--print-token` to read the token.
   The `yaml` package, used to parse and write frontmatter, is the only new dependency.
7. **Distribution is one file.**
   `bun run build:headless` bundles everything into `packages/obsidian-plugin/dist/headless/obsidian-mcp-headless.js` as CommonJS with a `node` shebang and the executable bit, so it runs as `node obsidian-mcp-headless.js` and as an extensionless copy on `PATH` on Node 24.11 or newer, the first Node 24 LTS release, and the release workflow attaches it to each release.
   Nothing is published to a package registry.

## Consequences

- Tool names and response shapes stay identical, so client integrations carry over.
- The parser and the link resolver are approximations of Obsidian's.
  Differences show up in edge cases such as setext headings, footnotes and unusual tag forms, and the tests pin the behaviour the tools rely on.
- The "Excluded files" setting has no equivalent, and `get_server_info` reports a loopback endpoint, which is correct because headless binds `127.0.0.1` only.
- Semantic search, `search_files_by_name`, `rename_vault_file`, `fetch` and the daily and periodic note tools are not in this first step.
  They arrive in the next changes of the series, which also leave the desktop bundle unchanged.
- The desktop plugin gains nothing from this change and loses nothing: its code, its tool order and its bundle are the same.
- Because the redirects live in the headless build, the bundle's composition differs from what a unit test of the shared code sees.
  The smoke test runs the real bundle for that reason.
- Rescans, watcher reconciles and own writes share one serial index queue, so they never interleave, and a write still returns only after the index reflects it.
  While external changes are landing, a read can see the index partway through a rescan, for example a note listed as orphaned before its incoming links are resolved, until the rescan finishes.
- Creating or deleting a note recomputes every link in the vault, so its cost grows with the vault's link count: about 70 ms at 5,000 notes and about 0.3 s at 20,000 notes in our measurements, while property edits stay at a few milliseconds.
  Incremental link updates are the next step if large vaults need them.
