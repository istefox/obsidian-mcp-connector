# MCP Connector for Obsidian

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/istefox/obsidian-mcp-connector?display_name=tag)](https://github.com/istefox/obsidian-mcp-connector/releases/latest)
[![Build status](https://img.shields.io/github/actions/workflow/status/istefox/obsidian-mcp-connector/release.yml)](https://github.com/istefox/obsidian-mcp-connector/actions)
[![License](https://img.shields.io/github/license/istefox/obsidian-mcp-connector)](LICENSE)

[Features](#features) | [Adaptive tool loading](#adaptive-tool-loading) | [Per-client tokens](#per-client-tokens) | [Installation](#installation) | [Connecting a client](#connecting-a-client) | [Prompts](#using-prompts) | [Command execution](#command-execution) | [Troubleshooting](#troubleshooting) | [Security](#security) | [Development](#development) | [Support](#support)

MCP Connector lets AI applications like Claude Desktop, Claude Code, Cursor, Cline, Continue, Windsurf, and VS Code securely access and work with your Obsidian vault through the [Model Context Protocol](https://modelcontextprotocol.io). [^2]

## Architecture

The plugin hosts the MCP server in-process inside Obsidian and exposes Streamable HTTP on `127.0.0.1:27200`. No native binary ships from this repository, so there is no platform-specific executable to download and run from GitHub Releases.

- **HTTP-native MCP clients** (Claude Code, Cursor, Cline, Continue, Windsurf, VS Code) connect directly to the local HTTP endpoint.
- **Claude Desktop** (which speaks only stdio MCP) connects through the official `npx mcp-remote` bridge, a two-line config the plugin generates for you. On Windows, where `mcp-remote` currently hangs on connect, a bundled POST-only Python bridge replaces it (see [Troubleshooting](#troubleshooting)).
- **Native semantic search** runs entirely on-device via Transformers.js. No cloud, no Smart Connections requirement.
- **Everything runs through Obsidian's own APIs.** Vault reads, writes, plain-text search, and Dataview queries all go through `app.vault`, `app.metadataCache`, and the Dataview plugin API in-process. No external HTTP service is required.

### Protocol compatibility

The connector speaks MCP protocol revision `2025-11-25` and earlier, which is what every current client uses. Nothing you have configured needs to change.

MCP published revision `2026-07-28` on 28 July 2026, moving the protocol to a stateless request/response core. Support for it is in progress and tracked in [#407](https://github.com/istefox/obsidian-mcp-connector/issues/407): the connector already runs on the v2 TypeScript SDK, and adopting the new revision is a separate opt-in. Servers can serve both revisions from one endpoint, so this will not be a flag day.

## Features

> **Tip:** all 51 tools are active by default. You can cut the per-session token cost with [adaptive tool loading](#adaptive-tool-loading), which keeps a small core active and promotes the rest on demand.

When connected to an MCP-compatible client, this plugin enables:

- **Vault access**: read, write, and patch notes through typed tools (`get_vault_file`, `create_vault_file`, `patch_vault_file`, `rename_vault_file`, `rename_heading`, `list_vault_files`, `create_vault_directory`, `delete_vault_directory`, and more) with native binary content for images and audio. Missing parent directories on a `create` or `append` path are auto-created. `rename_vault_file` preserves link integrity across the vault via `app.fileManager.renameFile`; `rename_heading` renames a heading in place and rewrites every wikilink, markdown link, and subheading-path reference pointing at it across the vault. `get_vault_files` reads up to 20 text/markdown files in a single call, one result per path, so a multi-note task no longer costs one round-trip per file. `get_vault_file` text output is capped at a configurable ceiling (Settings → MCP Connector, default 100 KB) — an oversized note comes back truncated with a hint to use `get_vault_file_partial` for a specific range instead of blowing the client's context window.
- **Note properties**: `get_note_property`, `set_note_property`, `delete_note_property`, and `list_property_values` read and edit frontmatter fields directly, including listing every value a property takes across the whole vault.
- **Semantic search**: `search_vault_smart` over an on-device embedding index, each result anchored to a 0-indexed line (null under Smart Connections, which doesn't expose one). While the index is still building (first use, or right after a provider switch), the tool returns a structured error with `filesIndexed`/`filesTotal`/`percent` and, once a build rate is known, an estimated `retryAfterSeconds` — a client that sends `_meta.progressToken` also gets a `notifications/progress` push on the same call. Four providers are available on demand: native MiniLM-L6-v2 (~25 MB, default), Gemma 300M (768d, recommended for non-Latin vaults), Multilingual-E5-Base (768d), and Smart Connections (if installed). Providers download once and swap live without a restart; the vault is re-indexed in the background while the previous provider keeps serving. A startup banner suggests the best provider based on your vault's character distribution. The index persists as 16 segments sharded by file path, so editing one note only rewrites that note's segment, not the whole index, keeping saves fast in large vaults.
- **Plain-text and structured search**: `search_vault_simple` (text plus context windows, each hit anchored to a 0-indexed line) and `search_vault` (Dataview DQL or JsonLogic). `execute_dataview_query` runs Dataview DQL in-process via the plugin API and returns typed results (`table`, `list`, `task`, `calendar`). DQL needs the Dataview community plugin; the JsonLogic path needs nothing.
- **Periodic notes**: `get_or_create_daily_note`, `get_or_create_periodic_note` (daily, weekly, monthly, quarterly, yearly), and `append_to_periodic_note`. Each call auto-creates the note with your configured template if it does not exist yet. Works with both the native Daily Notes plugin and the Periodic Notes community plugin.
- **Vault graph and navigation**: `get_vault_file_partial` (frontmatter field, heading section, block range, raw line range, or document outline, a context-efficient partial read), `list_tags` (all vault tags with usage counts), `get_files_by_tag` (hierarchical matching), `get_recent_files` (ordered by mtime), `get_outgoing_links`, `get_backlinks`, and `show_file_in_obsidian` (reveal a note in the Obsidian UI). `get_vault_overview` returns a one-call snapshot (active file, note count, top-level folder distribution, top tags, recent files), replacing the 3-5 separate calls a session otherwise needs just to get oriented.
- **Vault intelligence**: `find_broken_links` (link targets that do not resolve, with source file and line number), `find_orphaned_notes` (notes with zero incoming resolved links), `search_and_replace` (regex find-and-replace across the vault or scoped paths, `dry_run:"true"` by default for a safe preview), `get_note_outline` (heading TOC with level, text, line number, and anchor slug), and `list_bookmarks` (the full native Obsidian bookmark hierarchy: files, folders, searches, headings, blocks, groups).
- **Canvas**: `get_canvas` reads a `.canvas` file as structured nodes and edges, capping long text-node content with a `textTruncated` flag to bound token cost. `add_canvas_node` appends a text, file, or link node with automatic placement to the right of the existing layout, creating the canvas and parent folders if the path does not exist. `connect_canvas_nodes` draws an edge between two nodes by id. Writes preserve every existing field, including styling, so a canvas edited in Obsidian round-trips through a tool write with clean diffs.
- **Template execution**: invoke Templater templates as MCP tool calls with dynamic parameters.
- **Prompt library**: author MCP prompts as plain markdown files in your vault's `Prompts/` folder. No plugins required, the in-process renderer handles everything. See [Using prompts](#using-prompts) below.
- **Command execution** (opt-in): authorize the agent to run specific Obsidian commands (e.g. `editor:toggle-bold`, `graph:open`) from a per-vault allowlist. Disabled by default; every invocation is audited. See [Command execution](#command-execution) below.
- **Web fetch**: the `fetch` tool retrieves arbitrary URLs and returns Markdown via Turndown, with pagination for long pages.

**Typed output on every tool.** Each tool result carries a `structuredContent` object next to the text payload, so clients that support it (Claude Desktop, Claude Code) get a typed object without parsing a JSON string. The text stays byte-identical, so clients that read only text keep working unchanged. Every tool also declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so a client can skip the confirmation prompt on read-only calls and gate it on destructive ones. List and scan tools take a `limit` (default 200, clamped to 1000) and flag `truncated: true` with a full `total` when a large vault would otherwise return an unbounded array.

48 vault tools in total, plus three always-on meta-tools (`tool_catalog`, `activate_tool`, `activate_tools`) that power [adaptive tool loading](#adaptive-tool-loading), for 51 tools in all. Full list in the plugin's settings, **Tools available** section.

## Adaptive tool loading

Every tool a server advertises costs context-window tokens on each session: the client downloads the full JSON schema of every active tool before the model says a word. With all 51 tools active that is roughly 10K tokens per session. Adaptive tool loading lets you cut that cost without losing access to any tool.

### Profiles

Pick a profile in **Settings, MCP Connector, Tool Loading**:

| Profile | Active tools | Best for |
|---|---|---|
| **All** (default) | All 48 tools + all three meta-tools | Maximum capability, no behavior change from earlier versions |
| **Core** | 13 essential tools + `tool_catalog` | Minimum token cost, static surface that never changes mid-session |
| **Adaptive** | Core + frequency-promoted tools + all three meta-tools | Token savings that converge on your actual usage |

The Core set covers the everyday operations: server info, active-file read/write/append, vault file read/create/list, both search tools, tags, note properties, and the daily note.

### The three meta-tools

- **`tool_catalog`** (always active, read-only): returns the full inventory of all tools with their status (`active`, `inactive`, `promoted`), call counts, and descriptions for inactive ones. The model always knows what exists and what is switched off, regardless of profile.
- **`activate_tool`** (Adaptive and All profiles only): promotes an inactive tool by name. The tool becomes available immediately, no reconnect needed. By default the promotion lasts until the plugin reloads; pass `persist: true` to write it to the plugin data so it survives reloads. Every promotion shows an Obsidian notice (`MCP Connector: "<tool>" promoted to active`) so you always see when the model expands its own tool surface. In the Core profile this meta-tool is not exposed: Core means a fixed surface, and the model cannot grow it.
- **`activate_tools`** (Adaptive and All profiles only): promotes several inactive tools in one call instead of one `activate_tool` call per tool, refreshing the client's tool list only once. Use it whenever a task needs more than one inactive tool at a time.

### Frequency promotion

In Adaptive mode the plugin counts tool calls. When a non-core tool reaches 3 calls, it is promoted automatically and stays active on subsequent connects. The **Tool Loading** settings section lists the currently promoted tools, lets you remove any of them, and has a **Reset** button that clears counters and promotions while keeping your profile choice.

### Typical flow in Adaptive mode

1. The model needs a tool that is not active (say `find_broken_links`).
2. It calls `tool_catalog`, sees the tool exists but is inactive.
3. It calls `activate_tool` with `{"name": "find_broken_links"}`, the tool is usable immediately and you see a notice in Obsidian.
4. If you use that tool often, frequency promotion makes it permanent without anyone asking.

## Per-client tokens

The vault holds a list of bearer tokens, not a single one. Each token stands for one client, and each token has its own tool surface: Claude Code can keep all 51 tools while claude.ai sees only the 13-tool Core set, from the same vault, with no second server and no restart. The token presented on a request is what tells the two apart, so the split works even though the transport keeps no session state.

The list lives in **Settings, MCP Connector, Access control**. Each row shows the label, the profile in force, how many tools that token can reach, and per-row controls to show and copy the secret, copy a client config, download a `.mcpb` bundle, regenerate, and revoke. **Add token** asks for a label and is capped at 10 tokens per vault. Labels are cosmetic and may repeat.

Upgrading from 0.28.x needs nothing from you: the token you already have becomes the first row, labelled **Default**, with the same string, and your current profile and promoted tools become that row's policy. Every client you have configured keeps working unchanged.

### Per-token profiles

The profile picker under **Tool Loading** applies to the token selected in the list, not to the vault. All, Core, and Adaptive mean exactly what they mean in [Adaptive tool loading](#adaptive-tool-loading); they are simply chosen per client now.

Promotions follow the same line. When a client calls `activate_tool`, the tool becomes available to that client only, and `persist: true` writes it to that token's promoted list. Call counts stay vault-wide, because how often a tool is used describes your vault rather than the client that happened to call it, so every Adaptive token crosses the promotion threshold at the same time and gets the tool in its own list.

Tools you switch off under **Tools available** stay off for every token. That setting is yours, and no client can reach past it or discover that it exists.

### Limit to specific tools

Off by default, and while it is off a token behaves exactly as in earlier versions. Turn on **Limit to specific tools** for a token and the checklist becomes a hard ceiling: a tool outside the list is never advertised to that client, cannot be called, and `activate_tool` refuses it with a message saying the token's list does not include it. An empty list is legal and means the three meta-tools and nothing else; the settings panel flags it so it does not look like "no limit".

The profile itself is not a ceiling. Core is a starting point that `activate_tool` is meant to widen, which is what makes it usable rather than crippling. Use the allowlist when you want a boundary a client cannot talk its way past. `tool_catalog`, `activate_tool`, and `activate_tools` always stay reachable, so a client is never left without a way to see what exists and ask for it.

### Revoking or regenerating a token

> **Warning.** Both actions invalidate the token's current string, and the string is not recoverable. It is stored nowhere else, there is no undo, and nothing in the plugin can print it again once it is gone.

**Revoke** deletes the token. Every client configured with it, every `.mcpb` bundle exported for it, and any Windows bridge config holding it stop working at the next request: the server answers 401, and the bundle fails with an error telling you to re-export. One exception, for bundles only: a `.mcpb` exported before 1.0.0 carries no token id and resolves whichever token is currently first in the list, so revoking the first token re-points that bundle at the next one instead of cutting it off. Export a fresh bundle once after upgrading and the exception is gone. Other tokens are untouched, which is the point — rotating one client's credential no longer breaks all of them. Revoke asks for a confirmation naming the label and is disabled when only one token is left.

**Regenerate** replaces the secret in place, keeping the token's id, label, profile, promoted list and allowlist. Every client holding the old string starts getting 401 at its next request and needs the new one pasted in. Installed `.mcpb` bundles are the exception: they resolve their token from the vault by id at connect time, so they pick up the new secret on their own.

Neither action restarts the HTTP transport, so the port cannot drift and in-flight requests finish; the next request simply sees the new list.

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
3. Open the plugin settings and use the **Access control** section to wire up your MCP client.

### Option B, BRAT

Prefer the latest build, or the store entry has not propagated to your client yet? Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable the **Obsidian42, BRAT** plugin from the community store.
2. **Settings, BRAT, Add Beta plugin**, paste `istefox/obsidian-mcp-connector`.
3. BRAT installs the latest GitHub release; enable **MCP Connector** in Community plugins.
4. Jump to **Access control** in the plugin settings.

That's it. **No binary to install, no separate download.** The MCP server starts as soon as you enable the plugin.

## Connecting a client

Every client is wired up from its own row in **Access control**. Each row carries three **Copy config** buttons, one per supported client family, and a **.mcpb** button; whichever you use, the snippet or bundle authenticates as that row's token and no other. There is deliberately no vault-wide export: a credential always leaves the plugin naming the client it belongs to.

### Claude Desktop

Claude Desktop only speaks stdio MCP. The recommended `.mcpb` extension bridges to the in-process server directly, with no external runtime dependency. The alternative manual JSON config instead reaches it through the official [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge (Anthropic-maintained, no third-party code in the auth path), which needs Node.js on your PATH.

**Recommended: download the `.mcpb` extension**

1. In the plugin settings, under **Access control**, click **.mcpb** on the row of the token this client should use. A fresh vault has one row, labelled *Default*.
2. Drag the file onto Claude Desktop.
3. The extension installs with no prompt and shows a blue connector icon in Settings → Extensions.

The bundle is tied to the token you exported it from and resolves that token's secret and the live port from the vault at connect time, so no copy-paste step is required. Do not share the file. The extension runs entirely on Claude Desktop's own bundled Node.js runtime, so no separate Node install or PATH configuration is needed for this flow.

Regenerating that token's secret or changing the server port needs no action: the bundle picks both up on its next connect. Revoking the token does break it, deliberately — the extension then fails with an error asking for a re-export, instead of quietly falling back to another token's access. (A bundle exported before 1.0.0 predates the token id and does fall back to whichever token is now first; re-export it once to close that gap.) Export a fresh `.mcpb` from the row of the token you want it to use and drag it onto Claude Desktop to replace the existing extension.

**Alternative: manual JSON config**

For advanced users or when the `.mcpb` flow is not available. This path runs `npx mcp-remote` via your own Node install, so Node.js must be on your PATH; the plugin auto-detects it and offers a one-click Homebrew install if it is missing.

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

Or tick **Keep `claude_desktop_config.json` in sync with this token** on that token's row in **Access control**. The plugin then rewrites the file whenever that token's secret is regenerated, with a `.backup` written before each rewrite. Only one token can hold it — the file has a single entry for this vault — and regenerating any other token leaves it alone. Revoking the owning token removes the entry rather than pointing it at a different token.

**Windows note: use the POST-only bridge**

On Windows, `mcp-remote` has a bug that makes Claude Desktop hang for 60 seconds on connect, then fail with "Could not attach to MCP server". This is not a plugin bug: the same hang shows up against unrelated MCP servers, and Claude Code over direct HTTP is fine. Until `mcp-remote` ships a fix ([geelen/mcp-remote#296](https://github.com/geelen/mcp-remote/issues/296)), Windows users should skip `mcp-remote` and run the bundled bridge instead.

`scripts/obsidian_mcp_bridge.py` is a small Python script, standard library only with nothing to install, that talks to the plugin over POST requests, so it never opens the stream that triggers the hang. Point `claude_desktop_config.json` at it:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "python",
      "args": ["C:\\Users\\you\\obsidian_mcp_bridge.py", "http://127.0.0.1:27200/mcp"],
      "env": { "OBSIDIAN_BEARER_TOKEN": "paste-your-token-here" }
    }
  }
}
```

Full setup, including how to grab the script and verify it works, is in [docs/windows-post-only-bridge.md](docs/windows-post-only-bridge.md). macOS and Linux are not affected; use the standard `mcp-remote` config above.

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

Once configured, your client should expose **51 MCP tools** from this server (48 vault tools + 3 meta-tools, with the default **All** profile, fewer if you selected the Core or Adaptive [tool loading profile](#adaptive-tool-loading)), plus any prompts you have tagged with `#mcp-tools-prompt` in a `Prompts/` folder at your vault root.

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

### Embedding notes in a prompt

A prompt body can pull in another note with Obsidian's own embed syntax, and the content is inlined before the prompt reaches the model:

```markdown
Here is my current project brief:

![[Projects/Q3 brief]]

Using it, draft this week's plan.
```

`![[note]]`, `![[note|alias]]`, `![[note#Heading]]` and `![[note#^blockid]]` all work. Expansion happens after your parameters are filled in, so `![[{{note}}]]` lets the client choose which note to embed. The prompt arrives complete, instead of costing the model a tool call per note.

An embed that cannot be resolved is never dropped silently: the `![[…]]` stays in place followed by a comment saying why, so you can see what happened instead of wondering where the text went. Embeds inside an embedded note are not followed (one level only), and a render inlines at most 32 KB across at most 20 embeds. An embed that would blow the budget is skipped whole rather than cut off mid-sentence.

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
- **Check**: open the plugin settings, **Claude Desktop integration**, the **Node.js detection** panel reports whether `node` and `npx` are reachable on the path Obsidian inherits when launched from Finder or Spotlight (a common gap on macOS for users who installed Node via Homebrew).
- **Fix**: if the panel shows "Not found", click **Install via Homebrew** (macOS) or follow the platform-specific link to install Node manually. Restart Obsidian after installing.

### "Server disconnected" or ECONNREFUSED in Claude Desktop

- **Symptom**: Claude Desktop shows `Server disconnected`; its logs show `ECONNREFUSED 127.0.0.1:<port>`.
- **Fix**: fully quit Claude Desktop (Cmd+Q on macOS) and reopen it. Claude Desktop only re-reads `claude_desktop_config.json` at launch, so closing the window or an in-app restart is not enough. With auto-write on (the default) the plugin keeps the config in sync afterward.
- Still failing? Confirm the port in `claude_desktop_config.json` (`http://127.0.0.1:<port>/mcp`) matches the port the plugin logs on start (Settings, **Open Logs**), and make sure only one Obsidian vault has the plugin enabled (two instances contend for the port). Then fully restart Claude Desktop again.

### Claude Desktop extension (.mcpb) shows disconnected most of the time

- **Symptom**: the installed Claude Desktop extension is disconnected, stuck, or "busy" on most connection attempts, with no clear error in Claude.
- **Cause** (fixed in v0.26.0): before that version, the downloaded `.mcpb` baked the HTTP port and bearer token into `manifest.json` as a literal command, captured once at export. If the plugin later bound to a different port (no Fixed Port set, multiple vaults open) or the token changed, the installed extension kept using the stale values indefinitely.
- **Fix**: update the plugin to v0.26.0 or later, then re-export the `.mcpb` from Settings, **Access control**, the **.mcpb** button on that token's row, and reinstall it in Claude Desktop once. From that version on, the bundle reads the live port and token from the vault at connect time, so it keeps working across a token rotation or a port change with no further re-export.

### Claude Desktop hangs ~60s on Windows, then "Could not attach to MCP server"

- **Symptom**: on Windows, the connection starts, the logs show the `initialize` request sent, then 60 seconds of silence and a timeout. Reproducible across restarts and across different MCP servers on the same machine.
- **Cause**: a bug in the `mcp-remote` bridge on Windows, not in the plugin. The plugin answers an identical request in milliseconds over direct HTTP, and Claude Code is unaffected. Tracked upstream at [geelen/mcp-remote#296](https://github.com/geelen/mcp-remote/issues/296).
- **Fix**: replace `mcp-remote` with the POST-only bridge in [`scripts/obsidian_mcp_bridge.py`](scripts/obsidian_mcp_bridge.py), confirmed working on Windows. See [docs/windows-post-only-bridge.md](docs/windows-post-only-bridge.md) for setup, and the Windows note in [Connecting a client](#claude-desktop).

### Claude Desktop extension hangs ~60s on macOS with "Use Built-in Node.js for MCP" enabled

- **Symptom**: the extension installs and shows as enabled, but every connection attempt sits silent for exactly 60 seconds, then Claude Desktop's logs show `MCP error -32001: Request timed out`. No response, not even the connector's own internal timeout error, ever reaches Claude Desktop first.
- **Cause**: a bug in the connector, fixed in v1.0.1. The bundled shim started itself only when it was the process entry point, the usual `require.main === module` check. With **Use Built-in Node.js for MCP** on, Claude Desktop does not run `node server/index.js`: it loads the bundle through its own host script with `import()`, and under that loader the check is false. The process started and then sat idle, reading no request at all, which is why not even the connector's own timeout could answer. [korotovsky/slack-mcp-server#152](https://github.com/korotovsky/slack-mcp-server/issues/152) reports the same signature for an unrelated `.mcpb` extension, most likely the same guard. Reported as [#412](https://github.com/istefox/obsidian-mcp-connector/issues/412).
- **Fix**: update the plugin to v1.0.1 or later, then re-export the `.mcpb` from Settings, **Access control**, the **.mcpb** button on that token's row, and reinstall it in Claude Desktop once. The setting can stay on.
- **On 1.0.0 and earlier**: Claude Desktop, Settings, Extensions, disable **Use Built-in Node.js for MCP**, then fully quit (Cmd+Q) and reopen Claude Desktop. That spawns the connector as a normal child process on system Node.js, where the old check holds. The connector needs no `npx` or shell PATH resolution (fixed in v0.27.0), so any system Node.js install works.
- **Note on diagnostics**: on the built-in-Node path Claude Desktop does not write the connector's own `stderr` to `mcp-server-Obsidian MCP Connector.log`, so its startup banner and per-request lines are missing there even when everything works. To collect them, run the shim directly (`node "$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.stefano-ferri.obsidian-mcp-connector/server/index.js"`) or turn the setting off for the duration of the test.

### `tool/call` returns HTTP 401

- The bearer token in your client config matches none of the vault's tokens, which is also what you see after that token was regenerated or revoked. Open the plugin settings, **Access control**, find the row for that client, click **Show** to reveal its current string and **Copy** to copy it. Update your client config and restart the client. If the row is gone, the token was revoked: add a new one and configure the client with it.

### Native semantic search downloads slowly on first call

- Expected. The first `search_vault_smart` call (when `provider="native"`, or `"auto"` without Smart Connections) downloads ~25 MB from HuggingFace. The model is cached in the browser Cache API; subsequent reloads are instant.
- A non-fatal warning `Unable to determine content-length from response headers` may appear in DevTools console during the first download; `onnxruntime-web` recovers via an expandable buffer and search results are unaffected.

### General logs

Open the plugin settings, **Open Logs** under Resources, or look at Obsidian's developer console (`Cmd+Opt+I` / `Ctrl+Shift+I`).

## Security

### No binary shipped

This plugin **does not ship a platform-specific binary**. The MCP server runs in-process inside Obsidian's Electron renderer. Removing the binary closes the supply-chain attack surface that comes with auto-downloading and executing a signed-but-pre-built executable from GitHub Releases.

### Local-only HTTP

The MCP server listens on `127.0.0.1:27200`. The bind address is hardcoded to loopback; no external network exposure. Bearer-token authentication is required on every request; the tokens are generated per install and can be added, regenerated and revoked from the plugin settings.

### Bearer tokens

- Generated locally, stored in the plugin's `data.json` (per-vault). One is minted on first plugin load; you can add up to 10, one per client. See [Per-client tokens](#per-client-tokens).
- Visible in the plugin settings, **Access control**, **Show** on the token's row (hidden by default).
- A presented token is compared against every configured token, and a miss is a bare 401 that says nothing about which tokens exist.
- **Regenerate** replaces one token's secret and **Revoke** deletes it; either takes effect on the next request, with no transport restart and no effect on the other tokens. Update the affected client configs afterwards. Neither is recoverable.

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
