# MCP Connector for Obsidian

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/istefox/obsidian-mcp-connector?display_name=tag)](https://github.com/istefox/obsidian-mcp-connector/releases/latest)
[![Build status](https://img.shields.io/github/actions/workflow/status/istefox/obsidian-mcp-connector/release.yml)](https://github.com/istefox/obsidian-mcp-connector/actions)
[![License](https://img.shields.io/github/license/istefox/obsidian-mcp-connector)](LICENSE)

[Features](#features) | [Adaptive tool loading](#adaptive-tool-loading) | [Installation](#installation) | [Quick setup for clients](#quick-setup-for-clients) | [Prompts](#using-prompts) | [Command execution](#command-execution) | [Troubleshooting](#troubleshooting) | [Security](#security) | [Development](#development) | [Support](#support)

MCP Connector lets AI applications like Claude Desktop, Claude Code, Cursor, Cline, Continue, Windsurf, and VS Code securely access and work with your Obsidian vault through the [Model Context Protocol](https://modelcontextprotocol.io). [^2]

## Architecture

The plugin hosts the MCP server in-process inside Obsidian and exposes Streamable HTTP on `127.0.0.1:27200`. No native binary ships from this repository, so there is no platform-specific executable to download and run from GitHub Releases.

- **HTTP-native MCP clients** (Claude Code, Cursor, Cline, Continue, Windsurf, VS Code) connect directly to the local HTTP endpoint.
- **Claude Desktop** (which speaks only stdio MCP) connects through the official `npx mcp-remote` bridge, a two-line config the plugin generates for you.
- **Native semantic search** runs entirely on-device via Transformers.js. No cloud, no Smart Connections requirement.
- **Everything runs through Obsidian's own APIs.** Vault reads, writes, plain-text search, and Dataview queries all go through `app.vault`, `app.metadataCache`, and the Dataview plugin API in-process. No external HTTP service is required.

## Features

> **Tip:** all 48 tools are active by default. You can cut the per-session token cost with [adaptive tool loading](#adaptive-tool-loading), which keeps a small core active and promotes the rest on demand.

When connected to an MCP-compatible client, this plugin enables:

- **Vault access**: read, write, and patch notes through typed tools (`get_vault_file`, `create_vault_file`, `patch_vault_file`, `rename_vault_file`, `rename_heading`, `list_vault_files`, `create_vault_directory`, `delete_vault_directory`, and more) with native binary content for images and audio. Missing parent directories on a `create` or `append` path are auto-created. `rename_vault_file` preserves link integrity across the vault via `app.fileManager.renameFile`; `rename_heading` renames a heading in place and rewrites every wikilink, markdown link, and subheading-path reference pointing at it across the vault.
- **Note properties**: `get_note_property`, `set_note_property`, `delete_note_property`, and `list_property_values` read and edit frontmatter fields directly, including listing every value a property takes across the whole vault.
- **Semantic search**: `search_vault_smart` over an on-device embedding index. Four providers are available on demand: native MiniLM-L6-v2 (~25 MB, default), Gemma 300M (768d, recommended for non-Latin vaults), Multilingual-E5-Base (768d), and Smart Connections (if installed). Providers download once and swap live without a restart; the vault is re-indexed in the background while the previous provider keeps serving. A startup banner suggests the best provider based on your vault's character distribution.
- **Plain-text and structured search**: `search_vault_simple` (text plus context windows) and `search_vault` (Dataview DQL or JsonLogic). `execute_dataview_query` runs Dataview DQL in-process via the plugin API and returns typed results (`table`, `list`, `task`, `calendar`). DQL needs the Dataview community plugin; the JsonLogic path needs nothing.
- **Periodic notes**: `get_or_create_daily_note`, `get_or_create_periodic_note` (daily, weekly, monthly, quarterly, yearly), and `append_to_periodic_note`. Each call auto-creates the note with your configured template if it does not exist yet. Works with both the native Daily Notes plugin and the Periodic Notes community plugin.
- **Vault graph and navigation**: `get_vault_file_partial` (frontmatter field, heading section, block range, or document outline, a context-efficient partial read), `list_tags` (all vault tags with usage counts), `get_files_by_tag` (hierarchical matching), `get_recent_files` (ordered by mtime), `get_outgoing_links`, `get_backlinks`, and `show_file_in_obsidian` (reveal a note in the Obsidian UI).
- **Vault intelligence**: `find_broken_links` (link targets that do not resolve, with source file and line number), `find_orphaned_notes` (notes with zero incoming resolved links), `search_and_replace` (regex find-and-replace across the vault or scoped paths, `dry_run:"true"` by default for a safe preview), `get_note_outline` (heading TOC with level, text, line number, and anchor slug), and `list_bookmarks` (the full native Obsidian bookmark hierarchy: files, folders, searches, headings, blocks, groups).
- **Canvas**: `get_canvas` reads a `.canvas` file as structured nodes and edges, capping long text-node content with a `textTruncated` flag to bound token cost. `add_canvas_node` appends a text, file, or link node with automatic placement to the right of the existing layout, creating the canvas and parent folders if the path does not exist. `connect_canvas_nodes` draws an edge between two nodes by id. Writes preserve every existing field, including styling, so a canvas edited in Obsidian round-trips through a tool write with clean diffs.
- **Template execution**: invoke Templater templates as MCP tool calls with dynamic parameters.
- **Prompt library**: author MCP prompts as plain markdown files in your vault's `Prompts/` folder. No plugins required, the in-process renderer handles everything. See [Using prompts](#using-prompts) below.
- **Command execution** (opt-in): authorize the agent to run specific Obsidian commands (e.g. `editor:toggle-bold`, `graph:open`) from a per-vault allowlist. Disabled by default; every invocation is audited. See [Command execution](#command-execution) below.
- **Web fetch**: the `fetch` tool retrieves arbitrary URLs and returns Markdown via Turndown, with pagination for long pages.

**Typed output on every tool.** Each tool result carries a `structuredContent` object next to the text payload, so clients that support it (Claude Desktop, Claude Code) get a typed object without parsing a JSON string. The text stays byte-identical, so clients that read only text keep working unchanged. Every tool also declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so a client can skip the confirmation prompt on read-only calls and gate it on destructive ones. List and scan tools take a `limit` (default 200, clamped to 1000) and flag `truncated: true` with a full `total` when a large vault would otherwise return an unbounded array.

46 vault tools in total, plus two always-on meta-tools (`tool_catalog`, `activate_tool`) that power [adaptive tool loading](#adaptive-tool-loading), for 48 tools in all. Full list in the plugin's settings, **Tools available** section.

## Adaptive tool loading

Every tool a server advertises costs context-window tokens on each session: the client downloads the full JSON schema of every active tool before the model says a word. With all 48 tools active that is roughly 10K tokens per session. Adaptive tool loading lets you cut that cost without losing access to any tool.

### Profiles

Pick a profile in **Settings, MCP Connector, Tool Loading**:

| Profile | Active tools | Best for |
|---|---|---|
| **All** (default) | All 46 tools + both meta-tools | Maximum capability, no behavior change from earlier versions |
| **Core** | 13 essential tools + `tool_catalog` | Minimum token cost, static surface that never changes mid-session |
| **Adaptive** | Core + frequency-promoted tools + both meta-tools | Token savings that converge on your actual usage |

The Core set covers the everyday operations: server info, active-file read/write/append, vault file read/create/list, both search tools, tags, note properties, and the daily note.

### The two meta-tools

- **`tool_catalog`** (always active, read-only): returns the full inventory of all tools with their status (`active`, `inactive`, `promoted`), call counts, and descriptions for inactive ones. The model always knows what exists and what is switched off, regardless of profile.
- **`activate_tool`** (Adaptive and All profiles only): promotes an inactive tool by name. The tool becomes available immediately, no reconnect needed. By default the promotion lasts until the plugin reloads; pass `persist: true` to write it to the plugin data so it survives reloads. Every promotion shows an Obsidian notice (`MCP Connector: "<tool>" promoted to active`) so you always see when the model expands its own tool surface. In the Core profile this meta-tool is not exposed: Core means a fixed surface, and the model cannot grow it.

### Frequency promotion

In Adaptive mode the plugin counts tool calls. When a non-core tool reaches 3 calls, it is promoted automatically and stays active on subsequent connects. The **Tool Loading** settings section lists the currently promoted tools, lets you remove any of them, and has a **Reset** button that clears counters and promotions while keeping your profile choice.

### Typical flow in Adaptive mode

1. The model needs a tool that is not active (say `find_broken_links`).
2. It calls `tool_catalog`, sees the tool exists but is inactive.
3. It calls `activate_tool` with `{"name": "find_broken_links"}`, the tool is usable immediately and you see a notice in Obsidian.
4. If you use that tool often, frequency promotion makes it permanent without anyone asking.

## Prerequisites

### Required

- [Obsidian](https://obsidian.md/) v1.7.2 or higher.
- An MCP-compatible client. Examples: [Claude Desktop](https://claude.ai/download), [Claude Code](https://docs.anthropic.com/claude/docs/claude-code), [Cursor](https://cursor.com), [Cline](https://github.com/cline/cline), [Continue](https://continue.dev), [Windsurf](https://codeium.com/windsurf), [VS Code](https://code.visualstudio.com).
- For **Claude Desktop only**: [Node.js](https://nodejs.org) (any LTS version), required to run the `npx mcp-remote` bridge. The plugin auto-detects your Node install (including Homebrew on macOS) and offers a one-click install if it is missing.

### Optional

- [Templater](https://silentvoid13.github.io/Templater/): needed only for the `execute_template` tool. The prompt library works without it.
- [Dataview](https://blacksmithgu.github.io/obsidian-dataview/): needed only for DQL queries through `search_vault` and `execute_dataview_query`. The JsonLogic path in `search_vault` works without it.
- [Smart Connections](https://smartconnections.app/): an alternative semantic-search backend. The native MiniLM provider works just as well; Smart Connections is only useful if you are already invested in its ecosystem.

## Installation

MCP Connector is available in the Obsidian community plugin store and via BRAT. Use either.

### Option A, Community plugin store

1. **Settings, Community plugins, Browse**, search **"MCP Connector"**.
2. Install and enable. Obsidian shows a *"This plugin has not been manually reviewed by Obsidian staff"* notice; community plugins pass an automated build and security review, not a hand audit.
3. Open the plugin settings and use the **Quick setup for clients** section to wire up your MCP client.

### Option B, BRAT

Prefer the latest build, or the store entry has not propagated to your client yet? Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable the **Obsidian42, BRAT** plugin from the community store.
2. **Settings, BRAT, Add Beta plugin**, paste `istefox/obsidian-mcp-connector`.
3. BRAT installs the latest GitHub release; enable **MCP Connector** in Community plugins.
4. Jump to **Quick setup for clients** in the plugin settings.

That's it. **No binary to install, no separate download.** The MCP server starts as soon as you enable the plugin.

## Quick setup for clients

The plugin settings expose three **Copy config** buttons, one per supported client family. Each button copies a ready-to-paste JSON snippet to the clipboard.

### Claude Desktop

Claude Desktop only speaks stdio MCP, so it reaches the in-process server through the official [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge (Anthropic-maintained, no third-party code in the auth path). Node.js must be on your PATH. The plugin auto-detects it and offers a one-click Homebrew install if it is missing.

**Recommended: download the `.mcpb` extension**

1. In the plugin settings, under **Quick setup for clients**, click **Download .mcpb**.
2. Drag the file onto Claude Desktop.
3. The extension installs with no prompt and shows a blue connector icon in Settings → Extensions.

The bundle embeds your current bearer token and port directly, so no copy-paste step is required. Do not share the file. Node.js must be on your PATH (the plugin settings show a warning if it is missing).

If you rotate your token or change the server port, download a fresh `.mcpb` and drag it onto Claude Desktop to replace the existing extension.

**Alternative: manual JSON config**

For advanced users or when the `.mcpb` flow is not available:

1. Click **Claude Desktop** under **Copy config snippets**. The snippet looks like:
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
2. Paste it into your `claude_desktop_config.json` (Claude Desktop, Settings, Developer, Edit Config).
3. Restart Claude Desktop.

Or tick **Auto-write Claude Desktop config** in the plugin settings. The plugin keeps the file in sync on token rotation, with a `.backup` written before each rewrite.

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

Once configured, your client should expose **48 MCP tools** from this server (46 vault tools + 2 meta-tools, with the default **All** profile, fewer if you selected the Core or Adaptive [tool loading profile](#adaptive-tool-loading)), plus any prompts you have tagged with `#mcp-tools-prompt` in a `Prompts/` folder at your vault root.

To verify the connection works end-to-end, ask the agent to call `get_server_info`. A successful response confirms the client can reach the in-process server and the bearer token is correct. For deeper inspection (request/response logs, tool schema inspection without an LLM in the loop), use [`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector):

```bash
npx -y @modelcontextprotocol/inspector
# point it at http://127.0.0.1:27200/mcp with your bearer token
```

## Using prompts

The plugin lets you author **MCP prompts** as plain markdown files in your vault. Your prompt library lives alongside your notes, in a folder called `Prompts/` at the root of the vault. Every MCP-compatible client (Claude Desktop, Claude Code, Cursor, Cline, Continue) will surface these prompts in its own UI, typically as slash commands or attachments.

### Requirements

- A folder named exactly `Prompts` (capital `P`) at the root of your vault. That is it, **no additional plugins required**. The prompt renderer runs in-process inside the plugin.

If you use other Templater expressions in the prompt body (e.g. `<% tp.date.now() %>`), they are passed through verbatim; the MCP server does not evaluate them. Only `<% tp.mcpTools.prompt(...) %>` declarations and `{{arg}}` placeholders are processed.

### Creating a prompt in 60 seconds

1. Create a new folder called `Prompts` at the root of your vault (if it does not exist already).
2. Create a new markdown note inside it, e.g. `Prompts/weekly-review.md`.
3. Add frontmatter with the `mcp-tools-prompt` tag and a short description:

   ```markdown
   ---
   tags:
     - mcp-tools-prompt
   description: Summarize my recent daily notes on a given topic
   ---

   Summarize my notes from the past **<% tp.mcpTools.prompt("days", "How many days back to look, e.g. 7") %>** days
   about **<% tp.mcpTools.prompt("topic", "The subject, e.g. 'writing habits'") %>**.

   Give me the three most recurring themes and one action item I should act on this week.
   ```

4. Save the file.
5. In your MCP client, refresh or reconnect to the server. The new prompt will appear, named after the filename (`weekly-review.md`), with two parameters: `days` and `topic`.
6. Invoke it from your client's UI (e.g. the attachment or slash-command menu in Claude Desktop), fill in the parameters, and the rendered text becomes the first message of a new conversation.

### How parameters work

Parameters are declared anywhere in the prompt body using this syntax:

```
<% tp.mcpTools.prompt("parameter_name", "Description shown to the user") %>
```

This line is stripped from the rendered output, it is a declaration only. The actual value is injected wherever you write `{{parameter_name}}` in the body. You can use the same name multiple times; the client asks for it once and injects the value everywhere.

```markdown
Summarize my notes about **{{topic}}** from the past {{days}} days.
Focus on how {{topic}} relates to my long-term goals.
```

### Other ways to tag a prompt

Instead of frontmatter, you can drop an inline `#mcp-tools-prompt` hashtag anywhere in the body. Both forms are accepted by the server. Use whichever fits your note-taking style.

### Where is the full reference?

This section covers the 90% case. For the complete contract (folder naming, frontmatter schema, parameter parsing rules, execution flow, known limitations), see **[`docs/features/prompt-system.md`](docs/features/prompt-system.md)**.

## Command execution

The agent can run Obsidian commands on your behalf, the same entries you see in the command palette, but **only if you explicitly authorize them**. This feature is disabled by default and has no effect until you turn it on.

### How it works

Two MCP tools are always advertised to the client:

- `list_obsidian_commands`: read-only discovery, always safe. Returns every command registered in the vault (core plus plugins), optionally filtered by a substring. Use this first to find the `id` of a command you want to allow.
- `execute_obsidian_command`: gated. Every call is checked against your allowlist.
  - **If the command is on your allowlist**, it runs immediately.
  - **If it is not on your allowlist** (and the master toggle is ON), a confirmation modal pops up in Obsidian with three buttons: **Deny**, **Allow once**, **Allow always**. The HTTP call long-polls for up to 30 seconds waiting for your decision. "Allow always" adds the command to your allowlist so future calls skip the modal.
  - **If the master toggle is OFF**, every call is denied immediately. No modal, no prompt.

On top of the allowlist and confirmation flow, `execute_obsidian_command` is rate-limited to **100 calls per minute** (hard limit, server-side tumbling window) to protect the vault from runaway loops. The confirmation modal also surfaces a secondary **soft warning at 30 calls/minute**, visible to you as a red-bordered notice so you can abort a suspicious burst manually.

### Destructive-command heuristic

If the command id or its human name contains a word commonly associated with data loss (`delete`, `remove`, `uninstall`, `trash`, `clean`/`cleanup`, `purge`, `drop`, `reset`, `clear`, `wipe`), the confirmation modal shows a red warning and **disables the "Allow always" button**. You can still run the command via "Allow once", but the heuristic nudges you to think twice before adding it to your persistent allowlist. This is intentionally a nudge, not a gate: plugin authors use words creatively, so the filter catches the obvious cases and lets everything else through.

### Enabling it

1. Open **Settings, Community plugins, MCP Connector, Command execution**.
2. Tick **Enable MCP command execution**. Save.
3. From this point forward, whenever the agent invokes a command that is not on your allowlist, a modal will pop up asking for confirmation.
4. If you prefer to pre-authorize commands up front (rather than hit a modal on first call), you have three ways:
   - **Quick-add presets** (fastest): expand **Quick-add presets** and click **Add all** next to **Editing**, **Navigation**, or **Search**. Each preset is a curated list of common, non-destructive built-ins; only commands that actually exist in your vault are added, and duplicates are skipped.
   - **Browse available commands**: expand the browser, filter by id or name, and click **Add** next to each command you trust.
   - **Paste directly** into the allowlist textarea, comma- or newline-separated.
   Either way, click **Save** to persist.

### Advanced settings

Under the **Advanced** disclosure you can override the **soft rate-limit warning threshold** (default: 30 calls/minute). When the agent exceeds this rate, the confirmation modal surfaces a red banner so you can spot a runaway loop. The threshold is informational only; the in-process MCP server's hard limit of 100/minute is enforced server-side and is not configurable from the UI.

### What gets logged

Every allow/deny decision is appended to a ring buffer of the last 50 invocations, visible under **Recent invocations** in the same settings section. The audit log includes the command id, the decision, the timestamp, and (for denied calls) the reason. The buffer is pruned automatically so `data.json` stays bounded.

You can export the current buffer as CSV via the **Export CSV** button at the top of the Recent invocations list. The download uses the fixed schema `timestamp,commandId,decision,reason` and is RFC 4180 quoted, so it opens cleanly in Excel, Numbers, LibreOffice, or any standard CSV reader.

### Security model

- **Deny by default.** The master toggle is off out of the box. An empty allowlist with the toggle on is still deny-all.
- **No wildcards.** Allowlist entries must be exact command ids, there is no `editor:*` pattern.
- **No auto-discovery dumps.** The agent must call `list_obsidian_commands` or the user must paste ids; the allowlist is never populated automatically.
- **Per-vault.** The allowlist lives in each vault's plugin `data.json`. A different vault starts from zero.

## Troubleshooting

### Claude Desktop can't reach the server

- **Symptom**: Claude Desktop logs show `Failed to connect`, `ENOENT`, or `command not found`.
- **Check**: open the plugin settings, **Quick setup for clients**, the **Node.js detection** panel reports whether `node` and `npx` are reachable on the path Obsidian inherits when launched from Finder or Spotlight (a common gap on macOS for users who installed Node via Homebrew).
- **Fix**: if the panel shows "Not found", click **Install via Homebrew** (macOS) or follow the platform-specific link to install Node manually. Restart Obsidian after installing.

### "Server disconnected" or ECONNREFUSED in Claude Desktop

- **Symptom**: Claude Desktop shows `Server disconnected`; its logs show `ECONNREFUSED 127.0.0.1:<port>`.
- **Fix**: fully quit Claude Desktop (Cmd+Q on macOS) and reopen it. Claude Desktop only re-reads `claude_desktop_config.json` at launch, so closing the window or an in-app restart is not enough. With auto-write on (the default) the plugin keeps the config in sync afterward.
- Still failing? Confirm the port in `claude_desktop_config.json` (`http://127.0.0.1:<port>/mcp`) matches the port the plugin logs on start (Settings, **Open Logs**), and make sure only one Obsidian vault has the plugin enabled (two instances contend for the port). Then fully restart Claude Desktop again.

### `tool/call` returns HTTP 401

- The bearer token in your client config does not match the plugin's current token. Open the plugin settings, **Bearer token**, click **Show** to reveal the current token and **Copy** to copy it. Update your client config and restart the client.

### Native semantic search downloads slowly on first call

- Expected. The first `search_vault_smart` call (when `provider="native"`, or `"auto"` without Smart Connections) downloads ~25 MB from HuggingFace. The model is cached in the browser Cache API; subsequent reloads are instant.
- A non-fatal warning `Unable to determine content-length from response headers` may appear in DevTools console during the first download; `onnxruntime-web` recovers via an expandable buffer and search results are unaffected.

### General logs

Open the plugin settings, **Open Logs** under Resources, or look at Obsidian's developer console (`Cmd+Opt+I` / `Ctrl+Shift+I`).

## Security

### No binary shipped

This plugin **does not ship a platform-specific binary**. The MCP server runs in-process inside Obsidian's Electron renderer. Removing the binary closes the supply-chain attack surface that comes with auto-downloading and executing a signed-but-pre-built executable from GitHub Releases.

### Local-only HTTP

The MCP server listens on `127.0.0.1:27200`. The bind address is hardcoded to loopback; no external network exposure. Bearer-token authentication is required on every request; the token is generated per install and can be rotated from the plugin settings.

### Bearer token

- Generated locally on first plugin load, stored in the plugin's `data.json` (per-vault).
- Visible in the plugin settings, **Bearer token**, **Show** (hidden by default).
- **Rotate** invalidates the in-process transport and restarts it immediately, so the new token takes effect on the next request. Update your client configs after rotating.

### Plugin runtime

- All vault access goes through Obsidian's `app.vault` and `app.workspace` APIs, so Obsidian's permission model applies.
- Command execution is opt-in with a per-vault allowlist; see [Command execution](#command-execution).

### Reporting Security Issues

Please report security vulnerabilities via our [security policy](SECURITY.md). Do not report security vulnerabilities in public issues.

## Development

This project uses a Bun monorepo with a feature-based architecture. For the full architecture contract see [`docs/project-architecture.md`](docs/project-architecture.md).

### Workspace

```
packages/
├── obsidian-plugin/   # The plugin: in-process MCP server, registered tools, settings UI, transport
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

- **[istefox-dt-mcp](https://github.com/istefox/istefox-dt-mcp)**: MCP server for [DEVONthink 4](https://www.devontechnologies.com/apps/devonthink) (macOS). Six outcome-oriented tools, preview-then-apply with audit log and selective undo, optional local RAG (ChromaDB plus sentence-transformers), `.mcpb` bundle for Claude Desktop. Privacy-first, local-only. Listed on [Glama](https://glama.ai/mcp/servers/istefox/istefox-dt-mcp). MIT.

## License

[MIT License](LICENSE).

## Footnotes

[^2]: For more information about the Model Context Protocol, see [MCP Introduction](https://modelcontextprotocol.io/introduction).
