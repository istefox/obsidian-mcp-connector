# CLAUDE.md

Guidance for Claude Code (and similar AI agents) working in this repository.

## Project

**MCP Tools for Obsidian** — a Model Context Protocol (MCP) bridge that lets AI clients such as Claude Desktop access an Obsidian vault for reading, writing, searching (text + semantic), and executing templates, without bypassing Obsidian itself.

One shipped component on the 0.4.x line:

1. **Obsidian plugin** — hosts an in-process HTTP MCP server (port 27200 default), writes `claude_desktop_config.json`, exposes all 29 MCP tools and prompts over streamable-HTTP. No separate binary. Semantic search via native Transformers.js (no Smart Connections dependency).

Why operations go through Obsidian APIs rather than reading `.md` files directly: it preserves Obsidian's metadata cache, respects file locks on open notes, and lets the plugin invoke other Obsidian plugins (Templater, Dataview) through their APIs.

Current line: **`main` = 0.4.7** — the standalone in-process HTTP MCP server (promoted 2026-05-16); no separate binary, native semantic search via Transformers.js. The `packages/mcp-server` binary and `features/mcp-server-install` installer are retired. The 0.3.x stdio/binary line is archived at `archive/main-0.3.12` (abandoned; tags retained). The `[Unreleased]` block in `CHANGELOG.md` accumulates the next cut; consult `CHANGELOG.md` for its current contents (do not enumerate here — it drifts). License: MIT.

### Branch protection policy

**`main` is the production line** — standalone in-process HTTP MCP server, currently **0.4.7** (promoted 2026-05-16). The historical rule "don't merge `feat/http-embedded` → `main` until Stefano decides the 0.4.0 bump" is **discharged**: the promotion has happened; `main` IS the 0.4.x line. Normal branch + PR discipline now applies.

`feat/http-embedded` is a residual dev branch that became equal to `main` at promotion time. `main` is authoritative going forward; `feat/http-embedded` may be used for in-flight work or left as a historical marker — it no longer has "pre-release" status.

The 0.3.x stdio/binary line is **archived at `archive/main-0.3.12`** (do not delete it or its tags; users on old installs may reference them). Active development against 0.3.x is abandoned.

**Hard rules — apply unless Stefano explicitly authorizes the specific action:**

1. **All changes to `main` must go through a PR** — direct `git push origin main` is REJECTED by the `main-strict` ruleset (0 approvals required; self-merge is allowed). Branch + PR is always the path.
2. **Never force-push, rebase, or `reset --hard`** on `main` under any circumstance.
3. **Never delete or overwrite tags** on any `0.x.x` line (covers `0.3.0` through `0.3.12` archived stable + all `0.4.x` tags). Enforced by the `tags-protection` ruleset glob `0.*`.
4. **Never delete `0.3.x` or `0.4.x` GitHub releases** from the releases page.
5. **Never delete the `archive/main-0.3.12` branch** — it is the preserved record of the 0.3.x line.

If a request seems likely to compromise `main`'s functionality, stop and ask before acting.

**GitHub Rulesets active on `istefox/obsidian-mcp-connector`** (since 2026-05-05):

- **`General`** (branch): targets `main` + `feat/http-embedded`, rules: Restrict deletions + Block force pushes.
- **`main-strict`** (branch): targets `main` only, rule: Require pull request before merging (0 approvals). Direct push to `main` will be REJECTED.
- **`tags-protection`** (tag): targets pattern `0.*` (covers 0.1.x through 0.9.x), rules: Restrict updates + Restrict deletions + Block force pushes.

Bypass list is empty on all three — admin (Stefano) is also subject to the rules. In a true emergency, the path is: temporarily disable the ruleset → perform the operation → re-enable. Manage at https://github.com/istefox/obsidian-mcp-connector/settings/rules.

If you ever encounter a "GH013: Repository rule violations" error, the operation you attempted is structurally blocked — investigate why before disabling protection. Don't disable rulesets to "make it work" without confirming the action is intended.

## Stack

| Layer | Tech |
|---|---|
| Monorepo | Bun workspaces (`bun.lock`) — **do not use npm/yarn/pnpm** |
| Toolchain pinning | `mise.toml` (bun latest) |
| Language | TypeScript 5, strict mode, `verbatimModuleSyntax: true` |
| Runtime validation | **ArkType** (`arktype` 2.0.0-rc.30) at every external boundary |
| MCP | `@modelcontextprotocol/sdk` 1.29.0 |
| UI | Svelte 5.17 inside the Obsidian plugin (patched — see `patches/svelte@5.16.0.patch`) |
| Reactive deps | RxJS 7.8 (polls other Obsidian plugins until loaded) |
| HTML→Markdown | Turndown 7.2 |
| Test | `bun:test` (native) |
| Format | Prettier 3 (`.prettierrc.yaml`) — 2-space indent, 80 col |
| Build | `bun build --compile` for the server binary, custom `bun.config.ts` for the plugin |
| CI | GitHub Actions (`.github/workflows/release.yml`) — cross-platform binaries + SLSA provenance |

Path alias inside every package: **`$/*` → `src/*`**. Use it instead of relative imports across feature boundaries.

## Commands

From the repo root. See each package's `package.json` for the full script list.

```bash
bun install                           # Install all workspace dependencies
bun run check                         # Type-check every package (tsc --noEmit)
bun run dev                           # Watch all packages in parallel
bun run release                       # Cross-platform release build
bun run version [patch|minor|major]   # Atomic version bump + commit + tag
```

Per-package notable scripts: `bun run link` in `packages/obsidian-plugin` symlinks the built plugin into a local vault.

## Architecture

### Layout

- `packages/obsidian-plugin/` — Obsidian plugin (TS + Svelte 5); contains the in-process MCP server (HTTP-embedded, 0.4.x)
- `packages/shared/` — ArkType schemas, logger, cross-package types
- `packages/test-site/` — SvelteKit harness, not part of the shipped product
- `docs/` — architecture + feature specs (see References)
- `.clinerules` — **authoritative architecture contract, read first**

### Data flow (0.4.x HTTP-embedded)

```
Claude Desktop / MCP client
    │  HTTP / streamable-HTTP (MCP protocol)
    ▼
Obsidian plugin — in-process MCP server (0.4.x, port 27200 default)
    │  in-process function calls + Local REST API for auth/vault ops
    ▼
Obsidian (vault, Templater, Smart Connections, Dataview)
```

The MCP server **never** touches the vault filesystem directly, even when it would be faster. Bypassing Obsidian corrupts its metadata cache and breaks live editing.

### Entry points

- **Plugin** (also the MCP server host): `packages/obsidian-plugin/src/main.ts` → `class McpToolsPlugin extends Plugin`, loads features via their `setup()` functions, starts the in-process HTTP MCP server, registers the settings tab.
- **Shared**: `packages/shared/src/index.ts` → re-exports logger and types.

### Feature-based architecture

Every feature is a self-contained module in `src/features/<name>/` with a stable public shape (see `.clinerules` for the canonical spec):

```
feature/
├── components/   # Svelte UI (plugin only)
├── services/     # Business logic
├── constants/
├── types.ts      # ArkType schemas + TS types
├── utils.ts
└── index.ts      # Public API + setup function
```

Each `index.ts` exports a `setup()` that returns `{ success: true } | { success: false, error: string }`. A failing setup **must not** throw — return the error object so other features keep loading and the failure surfaces in the settings UI.

### Tool registration pattern (server)

Every MCP tool is declared with an ArkType schema + async handler through the shared `ToolRegistry` (never registered directly against the MCP SDK):

```typescript
tools.register(
  type({
    name: '"search_vault_smart"',
    arguments: {
      query: type("string>0").describe("A search phrase for semantic search"),
      "filter?": { /* ... */ },
    },
  }).describe("Human-readable tool description shown to the model"),
  async ({ arguments: args }) => {
    const files = ctx.plugin.app.vault.getMarkdownFiles();
    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  },
);
```

Rules:

- **Always** add `.describe()` on fields and on the top-level schema — that text becomes the model-facing documentation.
- Return MCP results shaped as `{ content: [{ type: "text", text: ... }] }`.
- Throw `new McpError(ErrorCode.*, message)` for protocol-level failures.
- **Boolean parameters arrive as strings** (`"true"`/`"false"`) from older MCP clients — `ToolRegistry` handles coercion centrally. Do not re-implement per tool; see `templates/index.ts` for an explicit `type("'true'|'false'")` workaround kept for belt-and-suspenders.
- Validate every untrusted JSON payload with ArkType first. Idiomatic pattern: `type("string.json.parse").pipe(schema)` — parses and validates in one expression. Use `.to()` to chain further transformations.
- **`ToolRegistry` is the only sanctioned way** to register tools and prompts. Do not register raw MCP handlers against the SDK directly. This is how boolean coercion, error formatting, and logging stay uniform.

## MCP surface (what this server exposes)

Capabilities declared: **`tools`** and **`prompts`**. No MCP resources are exposed.

### Tools (29 total, 0.4.x)

**Vault file management** — `packages/obsidian-plugin/src/features/mcp-tools/tools/`:

| Tool | Purpose |
|---|---|
| `get_server_info` | Local REST API status + auth check. Only tool that works without auth. |
| `get_active_file` | Content of the currently active note (markdown or JSON with tags + frontmatter). |
| `update_active_file` | Replace content of the active note. |
| `append_to_active_file` | Append to the active note. |
| `patch_active_file` | Insert/modify content relative to a heading, block reference, or frontmatter field. |
| `delete_active_file` | Delete the active note. |
| `show_file_in_obsidian` | Open a note in the Obsidian UI (optionally in a new leaf); creates it if missing. |
| `list_vault_files` | List files in a directory (root by default). |
| `get_vault_file` | Read an arbitrary file from the vault. |
| `create_vault_file` | Create or overwrite a file. |
| `append_to_vault_file` | Append to an arbitrary file. |
| `patch_vault_file` | Heading/block/frontmatter-aware insert into a file. |
| `delete_vault_file` | Delete a file. |
| `search_vault` | Search via Dataview DQL or JsonLogic query. |
| `search_vault_simple` | Plain text search with context window. |

**Semantic search** — `features/smart-connections/index.ts`:

| Tool | Purpose |
|---|---|
| `search_vault_smart` | Semantic search delegated to the Smart Connections plugin (`/search/smart` endpoint registered by this repo's plugin). Supports folder include/exclude filters and result limits. |

**Templater integration** — `features/templates/index.ts`:

| Tool | Purpose |
|---|---|
| `execute_template` | Execute a Templater template with dynamic arguments, optionally creating a new file at `targetPath`. Arguments are validated dynamically from the template's parameter syntax. |

**Web fetch** — `features/fetch/index.ts`:

| Tool | Purpose |
|---|---|
| `fetch` | Retrieve any URL and return Markdown (via Turndown) or raw HTML. Supports pagination (`maxLength`/`startIndex`) with built-in truncation hint. |

**Command execution** — `features/commands/index.ts`:

| Tool | Purpose |
|---|---|
| `list_obsidian_commands` | Read-only discovery. Returns every command registered in the vault (core + plugins) with optional substring filter. Always safe, no permission gate. |
| `execute_obsidian_command` | Gated execution. Every call goes through a rate limiter (100/minute tumbling window) and then the plugin's `/mcp-tools/command-permission/` endpoint, which checks the master toggle + per-command allowlist. Disabled by default. The plugin-side soft warning threshold (default 30/min) is user-configurable via the Advanced disclosure in settings (`commandPermissions.softRateLimit`). |

### Prompts

Prompts are **dynamically discovered** from the vault, not hardcoded — see `features/prompts/index.ts`:

- Source directory: `Prompts/` at the vault root.
- A file becomes an MCP prompt only if it has the tag `#mcp-tools-prompt`.
- Prompt arguments are parsed from Templater template syntax in the file body (`parseTemplateParameters`).
- On `GetPrompt`, the server runs the template through `/templates/execute` (Templater plugin), strips frontmatter, and returns the result as a user message.

This means prompt schemas are **runtime data**: they depend on the user's vault contents and change when they edit a prompt note. Full reference in `docs/features/prompt-system.md`.

## Conventions

Full spec lives in `.clinerules`. Highlights:

- **TypeScript strict mode** everywhere, no exceptions. `verbatimModuleSyntax: true` — use `import type` for type-only imports.
- **Prefer functional over OOP.** Pure functions, single responsibility, action-oriented names (`installMcpServer`, `getInstallationStatus`).
- **Never touch the vault filesystem directly from an MCP handler.** All vault reads/mutations go through Obsidian APIs — `plugin.app.vault.*` / `plugin.app.fileManager.*` / `vault.cachedRead` — never raw `fs`/`fsp`. This preserves Obsidian's metadata cache and respects file locks on open notes. (The server is in-process; there is no `makeRequest()` → Local REST API proxy layer.)
- **Never use `console.log`** in production code — use the shared `logger` from `packages/shared/src/logger.ts` with a structured context object (`logger.error("message", { requestId, error })`).
- **Settings are augmented via TypeScript module augmentation**, not a central types file:
  ```typescript
  declare module "obsidian" {
    interface McpToolsPluginSettings {
      myFeature?: { /* ... */ };
    }
  }
  ```
- **ArkType validation at every boundary** — external fetch responses, REST endpoint payloads, MCP tool arguments, prompt frontmatter. Add `.describe()` to improve error messages.
- **Feature name kebab-case**, **function camelCase**, **type PascalCase**, **constant SCREAMING_SNAKE_CASE**.

## Gotchas

Active traps in the current tree. Historical bugs already fixed are in `git log` — don't clutter this list with them.

- **`patches/svelte@5.16.0.patch`** forces Svelte to use `index-client.js` instead of `index-server.js` — required for Bun bundler compatibility. Re-verify if you upgrade Svelte.
- **`packages/obsidian-plugin/main.js` is the only shipped artifact** — CI regenerates it on tagged releases via `bun.config.ts`. Run `bun run build` from `packages/obsidian-plugin` locally; never commit the output.
- **Version bumps must go through `bun run version`** — it atomically updates `package.json`, `manifest.json`, `versions.json` and creates the git commit + tag. Manual edits get out of sync.
- **`packages/obsidian-plugin/main.js` is written at the package root, not `dist/`** — Obsidian expects that path. Do not move it.
- **External modules in `bun.config.ts`** (`obsidian`, `@codemirror/*`, `@lezer/*`) must stay external. Bundling them breaks the plugin on load.
- **Version macro** in `features/version/index.ts` uses Bun's `with { type: "macro" }` / `with { type: "json" }` import attribute — works on Bun's compile path, will break under plain tsc emit.
- **Smart Connections compatibility**: the plugin wrapper handles both v2.x (`window.SmartSearch`) and v3.0+ (`smartEnv.smart_sources`). Preserve both code paths when modifying.
- **`execute_template.createFile`** is typed as the string `"true"|"false"` (not boolean) because older MCP clients serialize booleans as strings — explicit workaround in `features/templates/index.ts`, kept as belt-and-suspenders for SDK 1.29.0.
- **`plugin.loadData()` / `plugin.saveData()` are NOT atomic** — default Obsidian persistence is two independent async calls. Any feature doing `load → modify → save` in response to concurrent events MUST serialize with a mutex. See `features/command-permissions/services/settingsLock.ts` for the canonical implementation + 35-way regression test.
- **Command-permission policy invariants** — `features/command-permissions/` is the security boundary for `execute_obsidian_command`. Whenever you touch `permissionCheck.ts`, preserve these load-bearing properties: (1) **deny by default** — `enabled !== true` short-circuits to deny BEFORE any allowlist check; (2) **two-phase mutex** — Phase A (load + decide-or-detect-modal-needed + save-on-fast-path) holds the lock; modal wait runs OUTSIDE the lock; Phase B (re-load + persist final outcome) re-acquires it, so concurrent requests serialize their I/O without serializing user interaction; (3) **the destructive heuristic is a nudge, not a gate** — matching commands disable "Allow always" but "Allow once" still works; presets in `presets.ts` MUST exclude every word the regex catches; (4) **allowlist entries are exact ids** — no wildcard support, deliberate. The full threat model and option matrix lives in `docs/design/issue-29-command-execution.md` — read it before changing the policy shape.
- **Every `from "obsidian"` import in `packages/shared/` must be `import type`.** The npm `obsidian` package ships only `.d.ts`; Obsidian injects the runtime module at plugin load. A value import survives `verbatimModuleSyntax` and fails `bun build --compile` with `Could not resolve "obsidian"`. The `packages/obsidian-plugin/` package is fine — value imports there are legitimate.

## Testing & CI

- Framework: `bun:test` (`import { describe, expect, test } from "bun:test"`).
- Tests live next to the code (`*.test.ts`). Run a single file with `bun test <path>`; run a whole package with `cd packages/<name> && bun test`. There is no monorepo-wide fan-out today — run `bun run check` from the root, then `bun test` in each package.
- **Plugin test infrastructure**:
  - `packages/obsidian-plugin/bunfig.toml` — `[test] preload` registers a synthetic `"obsidian"` module via `src/test-setup.ts`, so tests can import production modules that reference `Plugin`, `Notice`, `FileSystemAdapter`, `TFile`, etc.
  - `packages/obsidian-plugin/src/test-setup.ts` — the module mock. `FileSystemAdapter` accepts an optional `basePath` for anchoring tests at a real temp directory. Production code never constructs it itself — Obsidian does — so the extra parameter is invisible to the ship build. Also stubs `Modal` (shallow base class with `onOpen`/`onClose` plumbing) and the `svelte` module's `mount`/`unmount` as recorders — every call is pushed to the exported `svelteMockCalls.{mount,unmount}` object so tests can both inspect component props (including callback handles like `onDecision`) and assert mount/unmount pairing. Tests that use these helpers must reset `svelteMockCalls` in `beforeEach` for isolation (`import { svelteMockCalls } from "$/test-setup"`; `svelteMockCalls.mount = []; svelteMockCalls.unmount = [];`).
  - `packages/obsidian-plugin/.env.test` — fake `GITHUB_DOWNLOAD_URL` / `GITHUB_REF_NAME` for the build-time `environmentVariables()` macro. Bun auto-loads when `bun test` runs.
  - **Stubbing `os.homedir()`**: use `spyOn(os, "homedir").mockReturnValue(tmpRoot)` — Bun/Node cache HOME early, so runtime `process.env.HOME = …` is not reliable. See `config.test.ts` and `uninstall.test.ts`.
  - **Installer integration tests** use real shell scripts as fake binaries (tmpdir, `mode: 0o755`) instead of mocking `child_process.exec`. See `status.integration.test.ts`. macOS-guarded (shebang approach is Unix-only).
- **Still uncovered**: `installMcpServer` orchestration wrapper, `downloadFile` (HTTP + stream), Svelte component rendering (covered only by `svelte-check` and manual `bun run link` smoke tests).
- CI: `.github/workflows/release.yml` triggers on tag push, runs `bun run release`, cross-compiles all platforms, generates SLSA provenance, uploads release artifacts. **No test step in CI yet** — keep tests green locally before merging to `main`.

## Pre-commit checklist

**For any change:**

1. **`bun run check`** (at repo root) — TypeScript strict check across all packages. Must pass.
2. **Never bump version fields by hand.** Use `bun run version [patch|minor|major]`.

**For changes in `packages/obsidian-plugin/`:**

3. **`bun run build`** from the package — a clean prod build must succeed.
4. **Manual integration test** — `bun run link` into a throwaway vault, enable the plugin, verify: server install flow, Claude Desktop config write, REST endpoint registration, settings UI. Type checks do not catch UI or install-flow regressions.

**For changes in `packages/shared/`:**

3. **`bun run check` at the repo root** (again) — shared-package changes cascade; both runtime packages must still type-check.

## Project status (2026-05-16)

- `main` at **0.4.7** — standalone in-process HTTP MCP server (promoted 2026-05-16). Tools: 29. `minAppVersion: 1.7.2`. BRAT-distributed for community testers. Tag stack `0.4.0` → `0.4.7`.
- `archive/main-0.3.12` — the retired 0.3.x stdio/binary line (20 MCP tools). Preserved for historical reference; HEAD `76fa012` 2026-04-28; tag stack `0.3.0` → `0.3.12`. No active development.
- Community plugin store submission `obsidianmd/obsidian-releases#11919` open since 2026-04-13, automated lint cleared on 2026-04-18, **awaiting human review**. Consult `CHANGELOG.md` for the current `[Unreleased]` state.

## Pending work

Items in flight, ordered by priority:

1. **Store PR #11919 monitor** — passive wait. Routine `trig_015yL8D3VNao7nhRKjBu95ZK` (Mondays 07:00 UTC = 09:00 Rome CEST / 08:00 Rome CET) checks weekly and notifies only on real activity. The hourly issue `#79` watcher `trig_01Dx8sZTD78yBj7buuVYP9KE` remains active for orthogonal scope.
2. **Next version cut**: when ready, run `bun run version patch` + tag push; CI `release.yml` produces release artifacts. Consult `CHANGELOG.md` `[Unreleased]` for current pending entries.
3. **Marcoaperez next PR** (passive): inventory of 5+ tools agreed (`get_recent_files` / `get_document_map` / `get_periodic_note` family / `execute_dataview_query` / `get_vault_files`). PR #83 `list_tags` shipped 2026-05-05; next contribution stochastic in 1-2 week window. Mock infra `setMockFileStat()` already in `main` to be consumed when PR arrives.
4. **Community store listing**: gated on store PR #11919 acceptance.

Items resolved and out of "pending":

- ~~`#3` installer 404 — fixed in 0.3.5, validated by @Metal0gic.~~
- ~~Maintainership stance — settled 2026-04-24.~~
- ~~Binary content types for `get_vault_file` — landed in 0.3.4 (#59).~~
- ~~Phases 1-4 of the HTTP-embedded pivot — all landed in `0.4.0-alpha.1` through `0.4.0` stable (cut 2026-05-04). Native semantic search via Transformers.js verified end-to-end in vault TEST (alpha-stage `bun.config.ts` redirect `onnxruntime-node` → `onnxruntime-web` for Electron renderer is part of the bundle config).~~
- ~~Soak rounds 1 → 6 (folotp): all closed, regression-free byte-exact across `0.4.4` + `0.4.5` cuts on the `patch_vault_file` safety surface (`#80` H2-root reject + `#81` block-in-table reject + `#84` block-in-fenced-code reject all preserved in carryover spot-check).~~
- ~~`patch_vault_file` safety regressions — all reported variants closed: `#76` heading blank-line in `0.4.1`, `#80` + `#81` in `0.4.2`, `#84` in `0.4.3`. Helpers `hasParentH1` + `isInsideTableOrFencedCode` exported from `patchHelpers.ts`.~~
- ~~Marcoaperez `list_tags` (PR #83) — merged 2026-05-05 in cycle 5, second external maintainer-grade contributor confirmed.~~
- ~~Folotp `#86` (parent dir mkdirp + 2 dir tools) — shipped in 0.4.5, cycle 6 closed bilaterally.~~

## Soak preflight: chain identification first

When a soak round comes in (folotp / marcoaperez / grimlor / any external tester), confirm **which MCP path the client is actually exercising before interpreting any verdict**. The current (0.4.x) architecture is in-process HTTP-embedded; the legacy 0.3.x stdio/binary line is archived and abandoned. However, a tester can have both installed simultaneously: the legacy binary at `~/Library/Application Support/obsidian-mcp-tools/bin/mcp-server` persists from any pre-0.4.x install unless explicitly deleted, and `claude_desktop_config.json` is not auto-rewritten on plugin update. A tester who BRAT-pinned the plugin on top of a `0.3.x` install can have Claude Desktop routing through the legacy binary while the 0.4.x plugin is concurrently loaded — which makes any verdict about "0.4.x behavior" suspect until the chain is identified.

Three discriminators, applied as a first-line check in any soak comment **before** posting verdicts:

1. **Process inventory** — `ps aux | grep -E 'mcp-server|mcp-remote'`. Legacy stdio chain (0.3.x, archived) shows the old binary process; HTTP-embedded chain (0.4.x, current) shows `npx mcp-remote` (or no bridge process at all if the client speaks streamable-http natively).
2. **`get_server_info` shape** — call the tool from the client. **Legacy chain returns `apiExtensions[]`** (the LRA extension manifest list); **HTTP-embedded returns no `apiExtensions` field** (the in-process server doesn't expose LRA's manifest concept). Field absence is a positive HTTP-embedded marker.
3. **Tool namespace prefix on the client side** — `mcp__obsidian-mcp-tools__*` (legacy 0.3.x binary) vs. `mcp__mcp-tools-istefox__*` (0.4.x in-process plugin). Visible in the client's tool list before any tool is called.

A soak verdict that doesn't cite at least one of these as confirmed-positive for the intended chain is provisional. The 2026-05-04 round-3 soak by folotp on `0.4.0-beta.3` mis-attributed three of its verdicts (H2-root reject, block-in-table reject, `#74` double-prefix) because the chain identification was inferred from `claude_desktop_config.json` content rather than runtime-checked. Two of the three turned out to be real `0.4.x` regressions (filed as `#80`, `#81`), one was a legacy-chain-only artifact (`#74` resolution). Three lost cycles because the chain wasn't pinned at the start.

When you ask a tester to soak a candidate cut (BRAT-pin or beta tag), include the three discriminator checks as part of the report template. When you read a soak report, scan for chain identification first; if absent, ask before drafting verdicts.

## Outreach triage methodology

### Foundational principle: read fully, analyze deeply, take the time

**Before posting any reply, comment, follow-up, or triage on any GitHub thread (project issues, PRs, review comments, third-party dependencies), read the entire thread end-to-end and analyze it.** This is non-negotiable and supersedes every rule below; the rules are concrete instances of this principle, not substitutes for it. Stefano has flagged this expectation explicitly after a cluster of failure modes in a single 24-hour window: "i post, gli issues ecc... vanno letti interamente ma soprattutto **analizzati**! prenditi il tempo che vuoi, ma vanno analizzati a fondo!" Take that as standing instruction for every outreach action, not just the ones that look ambiguous.

What "read fully + analyze" means in practice:

- **Read the issue/PR body in full**, including code blocks, hyperlinks, referenced design docs, and screenshots.
- **Read every prior comment** in the thread chronologically. Identify who has authority on what (upstream maintainer, dependency maintainer, original reporter, validated contributor) and what they have already established as fact, retracted, or refined.
- **Map the state**: what is settled, what is open, what is disputed, who is asking what of whom — before drafting your reply.
- **For technical claims**, run the targeted code grep + hand-trace yourself. Don't infer behaviour from the comment author's framing alone.
- **If an offer is multi-point or structured**, enumerate the points before drafting; ensure the reply addresses each.

There is **no time pressure** on outreach or triage. Take whatever time is required. The cost of a 5-minute deeper read is one session-time unit; the cost of posting on a misread thread is a relationship with a domain authority + a follow-up correction + an entry in this rule list. The concrete rules below all exist because of failures of this foundational principle in a single 24-hour window. If this principle is followed, the others mostly take care of themselves.

### When triaging an issue or any candidate for cross-link outreach

**Never skip without informed evidence.** Before marking a candidate as "skip", apply these two checks in order:

1. **Read the full issue body.** Excerpt-level reading misses substance — the asker's context, the bug shape, the specific repro that may already be addressed in this codebase. Comment counts and labels are not enough.
2. **Targeted code grep.** When the claim is technical (parser bug, transport issue, tool behaviour), grep for the load-bearing function and hand-trace against the asker's fixture. A 5-minute trace beats a "cannot verify" assumption.

If **both** checks fail to unblock an informed position, skip is justified — and frame any comment to future-you that way ("did not verify"). If **either** unblocks one, engage with the confidence the evidence supports.

### Sweep enumeration rule

When doing a periodic sweep of issues / PRs, **enumerate `state=open` without `since=` filter**. Filtering by recent activity excludes old-but-still-open items that have been languishing without engagement. The 2026-05-04 deep review surfaced 10 never-commented items (3 issues + 7 PRs, including a 2025-05 multi-vault PR and a 2025-07 NFS-symlink bug) that the prior `since=2026-04-29` sweep had hidden. Use `gh api '/repos/.../issues?state=open&per_page=100' --jq 'sort_by(.number) | .[] | …'` for the canonical full inventory.

### Stale-claim audit on prior outreach

When a major release event happens (architecture pivot, stable cut, deprecation), audit prior outreach comments for claims that are no longer true under the new release. The 2026-04-21 outreach script template said "fixed in v0.3.0" for #61 (toolToggle), which was accurate at the time, but the 0.4.0 architecture pivot **hid the toolToggle UI** (Known limitations entry) — leaving the prior comment misleading for users who BRAT-default-installed `0.4.x` after the cut. Don't rewrite history; post a follow-up with the version-specific delta. Cheap honesty, prevents user disappointment downstream.

### Validated-contributor engagement rule

When a project issue is **OPEN, authored by a validated maintainer-grade contributor (folotp / marcoaperez / grimlor)**, and has **zero comments after >12h**, treat it as engagement-priority regardless of whether you've been pinged. These contributors invest meaningful effort into proposals; silence past the 12h mark reads as drop signal even if the issue is "future scope, no commitment". Post a substantive triage comment within the next session: technical preference between proposed options, implementation footprint estimate, timeline expectation framed against current gating constraints. The comment doesn't have to commit to a milestone — but it has to engage with the substance. The 2026-05-04 fork #77 (folotp's partial-read RFC) was sat for ~13h with the `enhancement` label and no other action because the prior session's triage note ("future scope, no commitment") was inherited as a passive-monitor signal in the next session's sweep; that framing was wrong. "Future scope" gates milestone commitment, not engagement.

### Authority disambiguation rule

When triaging or following up on a third-party issue, **read the full comment thread, not just the issue body**. If a **domain authority** has already disambiguated the framing in a prior comment — typically: the maintainer of an upstream dependency mentioned in the report (e.g. `coddingtonbear` on Local REST API issues), the original bug reporter retracting or refining the claim, or a project maintainer on their own repo — your reply MUST acknowledge that disambiguation, not re-assert the original framing.

Re-asserting after a domain authority has corrected the framing reads as either inattention or insistence, both of which damage relationships with the people whose project you're indirectly building on. A concrete example: a 2026-05-04 follow-up on an LRA compatibility issue posted a claim that "nothing changed in LRA `v3.4.x`" — but the LRA maintainer (`coddingtonbear`) had already replied 2026-02-22 explaining that the missing fields were the documented response shape for unauthenticated requests. A second follow-up was needed to acknowledge the authoritative read and correct the record. Concrete check before posting: skim every prior comment in the thread, look specifically for replies from people whose repo or project is referenced in the issue body, and if they've spoken authoritatively, mirror their framing in yours.

### Multi-point offer acknowledgement rule

When a validated contributor makes a **multi-point engagement offer** (test bench with multiple deliverable types, fixture variants on request, verify-before-cut commitment, etc.), the response needs two layers, both explicit:

1. **Preamble — explicit thanks for the offer shape itself**, said out loud rather than folded implicitly into the technical reply. High-investment engagement offers (continuous test bench, expanded fixture sets on demand, verify-before-cut commitment) carry a symbolic-acknowledgement cost that a purely-technical reply doesn't pay; the contributor invested effort signalling commitment, and the implicit-thanks-via-engagement loop only closes if the symbolic side is acknowledged separately. Articulate **what about the engagement shape is load-bearing for the project** — not generic gratitude.
2. **Point-by-point acceptance**: enumerate accepted points 1, 2, 3 in the same order the contributor wrote them; pin scope per-point; link to the current flow context (e.g. "default order: wait for disambig step X, then either Y or Z").

Implicit single-point responses to multi-point offers read as engagement loss — the contributor invested effort enumerating each commitment, and a generic "happy to ship X" reply only acknowledging one of them silently drops the others. A concrete example: a 2026-05-04 reply to folotp's three-point engagement offer paraphrased the debug-build point into a narrower scope and didn't acknowledge the other two (verify-4-variants-before-cut, additional-variants-on-request) or the test-bench offer shape itself. Two follow-ups were needed to repair: one for point-by-point acceptance, a separate one for explicit thanks. Doing both in the original reply would have been one message.

**Why these rules exist:** the 2026-05-04 outreach round initially skipped two candidates on weak grounds (couldn't verify a fix before reading the actual code, mistaken "marketing-bait" before reading the full body). Both turned around on a 5-minute deeper look. The same-day deep re-analysis surfaced: 10 never-commented items the morning sweep had missed (since-filter blind spot), 1 stale claim (#61 toolToggle in 0.4.0), 1 missed engagement on a high-quality validated-contributor proposal (#77 sat 13h with no triage), 1 multi-point engagement offer answered with a single-point reply, and 1 stale-claim follow-up that re-asserted a misframing a domain authority had already corrected on the thread. Lazy skip + filtered enumeration + un-audited prior comments + inherited passive-monitor framing + asymmetric reply to multi-point offers + un-read prior comments by domain authorities each cost reach.

## References

**In-repo docs** (read before implementing a new feature):

- `.clinerules` — authoritative feature architecture, ArkType conventions, error handling contract.
- `docs/project-architecture.md` — monorepo overview (aligned with `.clinerules`).
- `docs/features/prompt-system.md` — authoritative reference for the prompt feature. Read before touching the prompts feature or the template execution endpoint in the plugin.
- `docs/design/issue-29-command-execution.md` — design review for Obsidian command execution (threat model, policy options, phased plan). Authoritative when resuming issue #29 / PR #47.
- `CONTRIBUTING.md`, `SECURITY.md`.

**Live project state**:

- [Open issues](https://github.com/istefox/obsidian-mcp-connector/issues) / [Open PRs](https://github.com/istefox/obsidian-mcp-connector/pulls) — always cross-check GitHub for anything landed since.
- Discord `#maintainers` channel (invite in README) — low traffic, contains root-cause analysis for `patch_vault_file`.

**Upstream dependencies worth knowing**:

- [Model Context Protocol spec](https://modelcontextprotocol.io) — for boolean/schema shape gotchas.
- [Obsidian Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) — the HTTPS bridge this server depends on.
- [Local REST API OpenAPI reference](https://coddingtonbear.github.io/obsidian-local-rest-api/) — especially `PATCH /vault/{filename}`, whose header-based request format is hard to generate correctly.
