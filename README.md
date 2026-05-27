# MCP Connector for Obsidian

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/istefox/obsidian-mcp-connector)](https://github.com/istefox/obsidian-mcp-connector/releases/latest)
[![Build status](https://img.shields.io/github/actions/workflow/status/istefox/obsidian-mcp-connector/release.yml)](https://github.com/istefox/obsidian-mcp-connector/actions)
[![License](https://img.shields.io/github/license/istefox/obsidian-mcp-connector)](LICENSE)

[Features](#features) | [Installation](#installation) | [Quick setup for clients](#quick-setup-for-clients) | [Migration from 0.3.x](#migration-from-03x) | [Prompts](#using-prompts) | [Command execution](#command-execution) | [Troubleshooting](#troubleshooting) | [Security](#security) | [Development](#development) | [Support](#support)

MCP Connector lets AI applications like Claude Desktop, Claude Code, Cursor, Cline, Continue, Windsurf, and VS Code securely access and work with your Obsidian vault through the [Model Context Protocol](https://modelcontextprotocol.io). [^2]

## Architecture

Starting with **0.4.0**, the plugin hosts the MCP server **in-process inside Obsidian** and exposes Streamable HTTP on `127.0.0.1:27200`. There is **no native binary shipped from this repository** — eliminating the supply-chain risk that comes with downloading and executing a platform-specific executable from GitHub Releases.

- **HTTP-native MCP clients** (Claude Code, Cursor, Cline, Continue, Windsurf, VS Code) connect directly to the local HTTP endpoint.
- **Claude Desktop** (which speaks only stdio MCP) connects through the official `npx mcp-remote` bridge — a two-line config the plugin generates for you.
- **Native semantic search** runs entirely on-device via Transformers.js + `Xenova/all-MiniLM-L6-v2` (~25 MB, downloaded once and cached). No cloud, no Smart Connections requirement.
- **Local REST API is now optional**: only the `search_vault` tool (Dataview DQL / JsonLogic queries) needs it, and that tool returns an actionable error if it isn't installed. The other 29 tools work without it. [^4]

## Features

When connected to an MCP-compatible client, this plugin enables:

- **Vault access** — read, write, and patch notes through 18 typed tools (`get_vault_file`, `create_vault_file`, `patch_vault_file`, `rename_vault_file`, `rename_heading`, `list_vault_files`, `create_vault_directory`, `delete_vault_directory`, …) with native binary content for images and audio. Missing parent directories on a `create`/`append` path are auto-created. `rename_vault_file` preserves link integrity across the vault via `app.fileManager.renameFile`; `rename_heading` renames a heading in place and rewrites every wikilink / markdown link / subheading-path reference pointing at it across the vault.
- **Semantic search** — `search_vault_smart` over an on-device embedding index. Four providers available on demand: **native MiniLM-L6-v2** (~25 MB, default), **Gemma 300M** (768d, recommended for non-Latin vaults), **Multilingual-E5-Base** (768d), and Smart Connections (if installed). Providers download once and swap live without restart; the vault is re-indexed in the background while the previous provider continues serving. A startup banner suggests the best provider based on your vault's character distribution.
- **Plain-text + structured search** — `search_vault_simple` (text + context windows) and `search_vault` (DQL / JsonLogic via Local REST API). `execute_dataview_query` runs Dataview DQL in-process via the plugin API — returns typed results (`table` / `list` / `task` / `calendar`) without requiring Local REST API.
- **Periodic notes** — `get_or_create_daily_note`, `get_or_create_periodic_note` (daily / weekly / monthly / quarterly / yearly), and `append_to_periodic_note`. Each call auto-creates the note with your configured template if it doesn't exist yet. Works with both the native Daily Notes plugin and the Periodic Notes community plugin.
- **Vault graph & navigation** — `get_vault_file_partial` (frontmatter field, heading section, block range, or document outline — context-efficient partial read), `list_tags` (all vault tags with usage counts), `get_files_by_tag` (files by tag, hierarchical matching), `get_recent_files` (recently modified files ordered by mtime), `get_outgoing_links` (all links emanating from a note: wikilinks, markdown links, embeds, frontmatter links), `get_backlinks` (files that link to a given note).
- **Vault intelligence** — five read/write tools for vault-wide analysis: `find_broken_links` (all wikilink, markdown, embed, and frontmatter link targets that don't resolve, with source file + line number), `find_orphaned_notes` (notes with zero incoming resolved links), `search_and_replace` (regex find-and-replace across vault or scoped paths, `dry_run:"true"` by default for safe preview), `get_note_outline` (heading TOC with level, text, line number, and anchor slug), `list_bookmarks` (full native Obsidian bookmark hierarchy: files, folders, searches, headings, blocks, groups).
- **Template execution** — invoke Templater templates as MCP tool calls with dynamic parameters.
- **Prompt library** — author MCP prompts as plain markdown files in your vault's `Prompts/` folder. No plugins required — the in-process renderer handles everything. See [Using prompts](#using-prompts) below.
- **Command execution** (opt-in) — authorize the agent to run specific Obsidian commands (e.g. `editor:toggle-bold`, `graph:open`) from a per-vault allowlist. Disabled by default; every invocation is audited. See [Command execution](#command-execution) below.
- **Web fetch** — `fetch` tool retrieves arbitrary URLs and returns Markdown via Turndown, with pagination for long pages.

43 MCP tools in total. Full list in the plugin's settings → **Tools available** section.

## Prerequisites

### Required

- [Obsidian](https://obsidian.md/) v1.7.2 or higher.
- An MCP-compatible client. Examples: [Claude Desktop](https://claude.ai/download), [Claude Code](https://docs.anthropic.com/claude/docs/claude-code), [Cursor](https://cursor.com), [Cline](https://github.com/cline/cline), [Continue](https://continue.dev), [Windsurf](https://codeium.com/windsurf), [VS Code](https://code.visualstudio.com).
- For **Claude Desktop only**: [Node.js](https://nodejs.org) (any LTS version) — required to run the `npx mcp-remote` bridge. The plugin auto-detects your Node install (including Homebrew on macOS) and offers a one-click install if missing.

### Optional

- [Templater](https://silentvoid13.github.io/Templater/) — needed only for the `execute_template` tool. The prompt library works without it.
- [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) — needed only for the `search_vault` tool (DQL / JsonLogic queries). All other tools work without it. [^4]
- [Smart Connections](https://smartconnections.app/) — alternative semantic-search backend. The native MiniLM provider works just as well; Smart Connections is only useful if you are already invested in its ecosystem.

## Installation

MCP Connector is available in the Obsidian community plugin store **and** via BRAT — use either.

### Option A — Community plugin store

1. **Settings → Community plugins → Browse**, search **"MCP Connector"**.
2. Install + Enable. Obsidian shows a *"This plugin has not been manually reviewed by Obsidian staff"* notice — community plugins pass an automated build/security review, not a hand audit.
3. The first-load migration modal opens if you have a 0.3.x install — confirm or skip the steps it proposes (see [Migration from 0.3.x](#migration-from-03x) below).
4. Open the plugin settings and use the **Quick setup for clients** section to wire up your MCP client.

### Option B — BRAT

Prefer the latest build, or the store entry hasn't propagated to your client yet? Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable the **Obsidian42 — BRAT** plugin from the community store.
2. **Settings → BRAT → Add Beta plugin**, paste `istefox/obsidian-mcp-connector`.
3. BRAT installs the latest GitHub release; enable **MCP Connector** in Community plugins.
4. The first-load migration modal opens if applicable; otherwise jump straight to **Quick setup for clients** in the plugin settings.

That's it. **No binary to install, no separate download.** The MCP server starts as soon as you enable the plugin.

## Quick setup for clients

The plugin settings expose three **Copy config** buttons — one per supported client family. Each button copies a ready-to-paste JSON snippet to the clipboard.

### Claude Desktop

Claude Desktop only speaks stdio MCP, so it reaches the in-process server through the official [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge (Anthropic-maintained, no third-party code in the auth path).

1. Click **Copy config for Claude Desktop**. The snippet looks like:
   ```json
   {
     "mcpServers": {
       "obsidian-mcp-connector": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote",
           "http://127.0.0.1:27200/mcp",
           "--header",
           "Authorization: Bearer YOUR_TOKEN"
         ]
       }
     }
   }
   ```
2. Paste it into your `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit Config).
3. Restart Claude Desktop.

Or tick **Auto-write Claude Desktop config** in the plugin settings — the plugin keeps the file in sync on token rotation, with a `.backup` written before each rewrite.

### Claude Code

Claude Code speaks HTTP transport natively. Click **Copy config for Claude Code** and paste into `~/.claude.json` (project scope) or `~/.claude/settings.json` (global scope):

```json
{
  "mcpServers": {
    "obsidian-mcp-connector": {
      "type": "http",
      "url": "http://127.0.0.1:27200/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

Or use `claude mcp add` from the CLI with the same fields.

### Cursor / Cline / Continue / Windsurf / VS Code

Click **Copy config for streamable-http clients**. The snippet uses the generic streamable-http payload shape these clients accept; consult each client's own docs for the exact config-file location and any wrapping keys.

### Verifying the setup

Once configured, your client should expose **43 MCP tools** from this server, plus any prompts you have tagged with `#mcp-tools-prompt` in a `Prompts/` folder at your vault root.

To verify the connection works end-to-end, ask the agent to call `get_server_info`. A successful response confirms the client can reach the in-process server and the bearer token is correct. For deeper inspection (request/response logs, tool schema inspection without an LLM in the loop), use [`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector):

```bash
npx -y @modelcontextprotocol/inspector
# point it at http://127.0.0.1:27200/mcp with your bearer token
```

## Migration from 0.3.x

If you are upgrading from `0.3.x` (the binary-shipping line), the first plugin load on 0.4.0 detects your existing state and opens a **migration modal** with up to three opt-in steps:

1. **Rewrite Claude Desktop config** — replaces the old binary entry in `claude_desktop_config.json` with the `mcp-remote` bridge config. A `.backup` file is written before the rewrite. The legacy plugin config key (if present from 0.3.x) is removed at the same time.
2. **Delete the legacy binary** — the orphan `mcp-server` binary at the previous install location (`~/Library/Application Support/obsidian-mcp-tools/bin/`, `~/.local/share/obsidian-mcp-tools/bin/`, or `%APPDATA%\obsidian-mcp-tools\bin\`).
3. **Prune legacy plugin keys** — `installLocation` and `platformOverride` keys in the plugin's `data.json` are no longer used in 0.4.0.

Each step is independent — a failure in one does not skip the others. The modal can be dismissed without action, and `migration.skippedAt` is persisted so it does not re-open on every plugin load.

If you skip the migration, the plugin still works — but you'll have an orphan binary on disk and a stale Claude Desktop config entry pointing at it.

### Verifying the legacy binary is gone

After the migration modal completes step 2 (or after you remove the binary by hand), confirm that nothing lingers at the previous install location:

```bash
# macOS
ls ~/Library/Application\ Support/obsidian-mcp-tools/bin/mcp-server

# Linux
ls ~/.local/share/obsidian-mcp-tools/bin/mcp-server

# Windows (PowerShell)
Test-Path "$env:APPDATA\obsidian-mcp-tools\bin\mcp-server.exe"
```

A clean migration returns `No such file or directory` (macOS / Linux) or `False` (Windows). If the binary is still present, the modal's step 2 was either skipped, dismissed, or failed silently — remove the file manually and restart your MCP client (Claude Desktop, Cowork, Cursor, …) so it reconnects through the in-process HTTP transport instead of the legacy stdio path.

If you dismissed the modal accidentally, you can re-open the migration check from **Settings → MCP Tools → Migration from 0.3.x → Re-run migration check**.

## Using prompts

The plugin lets you author **MCP prompts** as plain markdown files in your vault. Your prompt library lives alongside your notes, in a folder called `Prompts/` at the root of the vault. Every MCP-compatible client (Claude Desktop, Claude Code, Cursor, Cline, Continue, …) will surface these prompts in its own UI — typically as slash commands or attachments.

### Requirements

- A folder named exactly `Prompts` (capital `P`) at the root of your vault. That's it — **no additional plugins required**. The prompt renderer runs in-process inside the plugin.

If you use other Templater expressions in the prompt body (e.g. `<% tp.date.now() %>`), they are passed through verbatim — the MCP server does not evaluate them. Only `<% tp.mcpTools.prompt(…) %>` declarations and `{{arg}}` placeholders are processed.

### Creating a prompt in 60 seconds

1. Create a new folder called `Prompts` at the root of your vault (if it doesn't exist already).
2. Create a new markdown note inside it, e.g. `Prompts/weekly-review.md`.
3. Add frontmatter with the `mcp-tools-prompt` tag and a short description:

   ```markdown
   ---
   tags:
     - mcp-tools-prompt
   description: Summarize my recent daily notes on a given topic
   ---

   Summarize my notes from the past **<% tp.mcpTools.prompt("days", "How many days back to look, e.g. 7") %>** days
   about **<% tp.mcpTools.prompt("topic", "The subject — e.g. 'writing habits'") %>**.

   Give me the three most recurring themes and one action item I should act on this week.
   ```

4. Save the file.
5. In your MCP client, refresh or reconnect to the server. The new prompt will appear — named after the filename (`weekly-review.md`) — with two parameters: `days` and `topic`.
6. Invoke it from your client's UI (e.g. the attachment or slash-command menu in Claude Desktop), fill in the parameters, and the rendered text becomes the first message of a new conversation.

### How parameters work

Parameters are declared anywhere in the prompt body using this syntax:

```
<% tp.mcpTools.prompt("parameter_name", "Description shown to the user") %>
```

This line is stripped from the rendered output — it is a declaration only. The actual value is injected wherever you write `{{parameter_name}}` in the body. You can use the same name multiple times; the client asks for it once and injects the value everywhere.

```markdown
Summarize my notes about **{{topic}}** from the past {{days}} days.
Focus on how {{topic}} relates to my long-term goals.
```

### Other ways to tag a prompt

Instead of frontmatter, you can drop an inline `#mcp-tools-prompt` hashtag anywhere in the body. Both forms are accepted by the server. Use whichever fits your note-taking style.

### Where is the full reference?

This section covers the 90% case. For the complete contract (folder naming, frontmatter schema, parameter parsing rules, execution flow, known limitations), see **[`docs/features/prompt-system.md`](docs/features/prompt-system.md)**.

## Command execution

The agent can run Obsidian commands on your behalf — the same entries you see in the command palette — but **only if you explicitly authorize them**. This feature is disabled by default and has no effect until you turn it on.

### How it works

Two MCP tools are always advertised to the client:

- `list_obsidian_commands` — read-only discovery, always safe. Returns every command registered in the vault (core + plugins), optionally filtered by a substring. Use this first to find the `id` of a command you want to allow.
- `execute_obsidian_command` — gated. Every call is checked against your allowlist.
  - **If the command is on your allowlist** → it runs immediately.
  - **If it is not on your allowlist** (and the master toggle is ON) → a confirmation modal pops up in Obsidian with three buttons: **Deny**, **Allow once**, **Allow always**. The HTTP call long-polls for up to 30 seconds waiting for your decision. "Allow always" adds the command to your allowlist so future calls skip the modal.
  - **If the master toggle is OFF** → every call is denied immediately. No modal, no prompt.

On top of the allowlist + confirmation flow, `execute_obsidian_command` is rate-limited to **100 calls per minute** (hard limit, server-side tumbling window) to protect the vault from runaway loops. The confirmation modal also surfaces a secondary **soft warning at 30 calls/minute**, visible to you as a red-bordered notice so you can abort a suspicious burst manually.

### Destructive-command heuristic

If the command id or its human name contains a word commonly associated with data loss (`delete`, `remove`, `uninstall`, `trash`, `clean`/`cleanup`, `purge`, `drop`, `reset`, `clear`, `wipe`), the confirmation modal shows a red warning and **disables the "Allow always" button**. You can still run the command via "Allow once" — but the heuristic nudges you to think twice before adding it to your persistent allowlist. This is intentionally a nudge, not a gate: plugin authors use words creatively, so the filter catches the obvious cases and lets everything else through.

### Enabling it

1. Open **Settings → Community plugins → MCP Connector → Command execution**.
2. Tick **Enable MCP command execution**. Save.
3. From this point forward, whenever the agent invokes a command that is not on your allowlist, a modal will pop up asking for confirmation.
4. If you prefer to pre-authorize commands up front (rather than hit a modal on first call), you have three ways:
   - **Quick-add presets** (fastest): expand **Quick-add presets** and click **Add all** next to **Editing**, **Navigation**, or **Search**. Each preset is a curated list of common, non-destructive built-ins; only commands that actually exist in your vault are added, and duplicates are skipped.
   - **Browse available commands**: expand the browser, filter by id or name, and click **Add** next to each command you trust.
   - **Paste directly** into the allowlist textarea — comma- or newline-separated.
   Either way, click **Save** to persist.

### Advanced settings

Under the **Advanced** disclosure you can override the **soft rate-limit warning threshold** (default: 30 calls/minute). When the agent exceeds this rate, the confirmation modal surfaces a red banner so you can spot a runaway loop. The threshold is informational only — the in-process MCP server's hard limit of 100/minute is enforced server-side and is not configurable from the UI.

### What gets logged

Every allow/deny decision is appended to a ring buffer of the last 50 invocations, visible under **Recent invocations** in the same settings section. The audit log includes the command id, the decision, the timestamp, and (for denied calls) the reason. The buffer is pruned automatically so `data.json` stays bounded.

You can export the current buffer as CSV via the **Export CSV** button at the top of the Recent invocations list. The download uses the fixed schema `timestamp,commandId,decision,reason` and is RFC 4180 quoted, so it opens cleanly in Excel, Numbers, LibreOffice, or any standard CSV reader.

### Security model

- **Deny by default.** The master toggle is off out of the box. An empty allowlist with the toggle on is still deny-all.
- **No wildcards.** Allowlist entries must be exact command ids — there is no `editor:*` pattern.
- **No auto-discovery dumps.** The agent must call `list_obsidian_commands` or the user must paste ids; the allowlist is never populated automatically.
- **Per-vault.** The allowlist lives in each vault's plugin `data.json`. A different vault starts from zero.

For the full threat model and the rationale behind these decisions, see **[`docs/design/issue-29-command-execution.md`](docs/design/issue-29-command-execution.md)**.

## Troubleshooting

If you encounter issues:

### Claude Desktop can't reach the server

- **Symptom**: Claude Desktop logs show `Failed to connect`, `ENOENT`, or `command not found`.
- **Check**: open the plugin settings → **Quick setup for clients** → the **Node.js detection** panel reports whether `node` and `npx` are reachable on the path Obsidian inherits when launched from Finder/Spotlight (a common gap on macOS for users who installed Node via Homebrew).
- **Fix**: if the panel shows "Not found", click **Install via Homebrew** (macOS) or follow the platform-specific link to install Node manually. Restart Obsidian after installing.

### "Server disconnected" after updating from a pre-0.4.9 build

- **Symptom**: Claude Desktop shows `MCP mcp-tools-istefox: Server disconnected`; its logs show `ECONNREFUSED 127.0.0.1:<port>`.
- **Cause**: pre-0.4.9 builds could fail to release the server port on Obsidian reload/disable and "walk" to the next one (27200 → 27201 → …), so `claude_desktop_config.json` may point at an old walked port while 0.4.9 now correctly binds the default. 0.4.9 fixes the walk; the stale config is a one-time leftover from the old build, not a recurring issue.
- **Fix**: **fully quit Claude Desktop (Cmd+Q on macOS) and reopen it** — Claude Desktop only re-reads `claude_desktop_config.json` at launch; closing the window or an in-app restart is not enough. With auto-write on (the default) the plugin keeps the config in sync afterward.
- Still failing? Confirm the port in `claude_desktop_config.json` (`http://127.0.0.1:<port>/mcp`) matches the port the plugin logs on start (Settings → **Open Logs**), ensure only one Obsidian vault has the plugin enabled (two instances contend for the port), then fully restart Claude Desktop again.

### `tool/call` returns HTTP 401

- The bearer token in your client config does not match the plugin's current token. Open the plugin settings → **Bearer token** → click **Show** to reveal the current token and **Copy** to copy it. Update your client config and restart the client.

### Native semantic search downloads slowly on first call

- Expected. The first `search_vault_smart` call (when `provider="native"`, or `"auto"` without Smart Connections) downloads ~25 MB from HuggingFace. The model is cached in the browser Cache API; subsequent reloads are instant.
- A non-fatal warning `Unable to determine content-length from response headers` may appear in DevTools console during the first download — `onnxruntime-web` recovers via an expandable buffer; search results are unaffected.

### Migration modal didn't run

- The modal only opens if the first-load detector finds at least one of: legacy `installLocation` / `platformOverride` keys in `data.json`, an orphan `mcp-server` binary at the previous install location, or a Claude Desktop config entry pointing at the binary.
- If you dismissed it accidentally, you can re-open it from the plugin settings → **Migration from 0.3.x** → **Re-run migration check**.

### General logs

Open the plugin settings → **Open Logs** under Resources, or look at Obsidian's developer console (`Cmd+Opt+I` / `Ctrl+Shift+I`).

## Security

### No binary shipped

Starting with 0.4.0, this plugin **does not ship a platform-specific binary**. The MCP server runs in-process inside Obsidian's Electron renderer. Eliminating the binary closes the supply-chain attack surface that comes with auto-downloading and executing a signed-but-pre-built executable from GitHub Releases.

### Local-only HTTP

The MCP server listens on `127.0.0.1:27200`. The bind address is hardcoded to loopback; no external network exposure. Bearer-token authentication is required on every request; the token is generated per install and can be rotated from the plugin settings.

### Bearer token

- Generated locally on first plugin load, stored in the plugin's `data.json` (per-vault).
- Visible in the plugin settings → **Bearer token** → **Show** (hidden by default).
- **Rotate** invalidates the in-process transport and restarts it immediately, so the new token takes effect on the next request. Update your client configs after rotating.

### Plugin runtime

- All vault access goes through Obsidian's `app.vault` and `app.workspace` APIs (Obsidian's permission model applies).
- Local REST API is no longer required for most tools — see [Architecture](#architecture).
- Command execution is opt-in with a per-vault allowlist; see [Command execution](#command-execution).

### Reporting Security Issues

Please report security vulnerabilities via our [security policy](SECURITY.md). Do not report security vulnerabilities in public issues.

## Development

This project uses a Bun monorepo with a feature-based architecture. For the full architecture contract see [`.clinerules`](.clinerules) and [`docs/project-architecture.md`](docs/project-architecture.md).

### Workspace

```
packages/
├── obsidian-plugin/   # The plugin: in-process MCP server, registered tools, settings UI, migration modal, transport
├── shared/            # Shared ArkType schemas and types
└── test-site/         # SvelteKit harness (dev-only, not shipped)
```

### Building

```bash
bun install                    # Install workspace dependencies
bun run check                  # Type-check every package
bun run dev                    # Watch all packages
bun run build                  # Production build
```

The plugin's `main.js` is written at the package root (`packages/obsidian-plugin/main.js`); Obsidian expects that path. Do not move it.

### Requirements

- [Bun](https://bun.sh/) latest (pinned via `mise.toml`)
- TypeScript 5+

### Contributing

**Before contributing, please read our [Contributing Guidelines](CONTRIBUTING.md) including our community standards and behavioral expectations.**

1. Fork the repository.
2. Create a feature branch from `main`.
3. Make your changes; keep PRs scoped.
4. Run tests:
   ```bash
   bun test
   ```
5. Submit a pull request.

We welcome genuine contributions but maintain strict community standards. Be respectful and constructive in all interactions.

## Support

- [Open an issue](https://github.com/istefox/obsidian-mcp-connector/issues) for bug reports and feature requests.
- GitHub issues are the right channel for help with **MCP Connector**.

**Please read our [Contributing Guidelines](CONTRIBUTING.md) before posting.** We maintain high community standards and have zero tolerance for toxic behavior.

## Changelog

See [GitHub Releases](https://github.com/istefox/obsidian-mcp-connector/releases) and [`CHANGELOG.md`](CHANGELOG.md) for the detailed changelog.

## Other MCP servers by istefox

- **[istefox-dt-mcp](https://github.com/istefox/istefox-dt-mcp)** — MCP server for [DEVONthink 4](https://www.devontechnologies.com/apps/devonthink) (macOS). Six outcome-oriented tools, preview-then-apply with audit log + selective undo, optional local RAG (ChromaDB + sentence-transformers), `.mcpb` bundle for Claude Desktop. Privacy-first, local-only. Listed on [Glama](https://glama.ai/mcp/servers/istefox/istefox-dt-mcp). MIT.

## License

[MIT License](LICENSE) — Licensed MIT; portions originally derived from an MIT-licensed project — see LICENSE.

## Footnotes

[^1]: For information about Claude data privacy and security, see [Claude AI's data usage policy](https://support.anthropic.com/en/articles/8325621-i-would-like-to-input-sensitive-data-into-free-claude-ai-or-claude-pro-who-can-view-my-conversations).
[^2]: For more information about the Model Context Protocol, see [MCP Introduction](https://modelcontextprotocol.io/introduction).
[^3]: For a list of available MCP Clients, see [MCP Example Clients](https://modelcontextprotocol.io/clients).
[^4]: Local REST API was a hard requirement on the 0.3.x line. Starting with 0.4.0 it is optional and only enables the `search_vault` tool (DQL / JsonLogic queries). The other 42 tools work without it; `search_vault` returns an actionable error if it isn't installed. As of `0.4.5`, `search_vault` reads the LRA host and port from the plugin's live settings instead of a hardcoded `127.0.0.1:27124`, so reconfiguring LRA's listen port no longer requires a plugin restart.
