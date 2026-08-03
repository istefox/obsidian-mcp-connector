# Prompt system

This document is the **authoritative reference** for how the prompt feature works end-to-end: the vault-side contract an Obsidian user must follow to author a prompt, and the server-side machinery that discovers, validates, and executes those prompts through the Model Context Protocol.

It replaces the earlier `prompt-requirements.md`, which was an implementation planning doc written before the feature shipped and no longer reflects reality.

## What is a prompt (MCP context)

The Model Context Protocol distinguishes two kinds of things a server can expose to a client:

- **Tools** — actions the agent can take (read a file, search, execute a template). The agent decides when to call them.
- **Prompts** — pre-written, parameterized messages the *user* can invoke from a chat input, typically to insert a well-crafted context or instruction into the conversation. The client (Claude Desktop, Cline, Claude Code, Zed, …) renders them in its "slash command" or "attachment" UI so the user can pick one and supply any arguments.

This plugin makes every markdown file in your vault's `Prompts/` folder that is tagged `mcp-tools-prompt` available as an MCP prompt. The **vault itself becomes your prompt library**, editable with the same tool you already use for notes — no separate UI, no separate config file, no developer work.

## The vault-side contract

To make a file available as a prompt, you must satisfy **three** conditions. Miss any one of them and the file will be silently skipped during discovery.

### 1. The file must live in a folder named `Prompts/` at the vault root

The folder name is **exact and case-sensitive**. It is hardcoded to `Prompts` (capital P, no trailing slash, no nested subfolders — only direct children of `Prompts/` are scanned).

- ✅ `{vault}/Prompts/my-prompt.md`
- ❌ `{vault}/prompts/my-prompt.md` (lowercase p)
- ❌ `{vault}/Prompts/subfolder/my-prompt.md` (nested)
- ❌ `{vault}/MCP Prompts/my-prompt.md` (different folder name)
- ❌ `{vault}/Notes/Prompts/my-prompt.md` (not at root)

If the `Prompts/` folder does not exist at all, the server returns an empty list of prompts — no error. You can create the folder from within Obsidian whenever you're ready to start writing prompts.

### 2. The file must be tagged `mcp-tools-prompt`

Obsidian supports **two** ways to attach a tag to a note and both are accepted:

**Option A — Frontmatter tag** (recommended):

```yaml
---
tags:
  - mcp-tools-prompt
description: Generate a weekly review based on my daily notes
---
```

**Option B — Inline hashtag** in the body:

```markdown
#mcp-tools-prompt

Generate a weekly review based on my daily notes from the past 7 days.
```

Both forms are accepted. The server checks whether any tag equals `"mcp-tools-prompt"` — no `#` prefix, no variation allowed. Tag names like `mcp_tools_prompt`, `MCP-Tools-Prompt`, or `prompt` will not match. Scalar YAML tags (a bare string instead of a list) are also coerced automatically.

Files without this tag are silently filtered out of the prompt list. This lets you keep other kinds of notes in the `Prompts/` folder (drafts, documentation, shared templates) without exposing them to MCP clients.

### 3. The file must be a `.md` file

Non-markdown files in `Prompts/` (`.canvas`, `.pdf`, images, etc.) are skipped. This is a cheap extension check before the server bothers fetching the file's content.

## Frontmatter

The frontmatter schema is simple:

| Field | Required | Type | Purpose |
|---|---|---|---|
| `tags` | yes (if not using inline hashtag) | string list | Must include `mcp-tools-prompt`. |
| `description` | no | string | Shown to the LLM as the prompt's description in `prompts/list`. Strongly recommended — this is how the user (and the model, when helping the user pick a prompt) understands what the prompt does. |

Any other frontmatter fields are ignored by the server. You can keep your own metadata alongside (e.g. Dataview fields, author notes, a timestamp) and it will not interfere with prompt discovery.

## Prompt arguments: Templater syntax

A prompt can accept **arguments** that the user supplies at invocation time — for example a topic, a date range, a person's name. Arguments are declared **inside the prompt body** using a specific Templater pattern:

```markdown
<% tp.mcpTools.prompt("topic", "The subject you want me to write about") %>
```

The server parses the prompt file's content with a regex, finds each `<% tp.mcpTools.prompt(name, description) %>` call it finds. The first argument becomes the parameter's **name**, the second becomes its **description** shown to the client UI.

### Rules and gotchas

- **The function name must be exactly `tp.mcpTools.prompt`.** Not `tp.prompt`, not `mcpTools.prompt`, not `prompt`. The AST matcher looks for the specific member-expression chain `tp → mcpTools → prompt`.
- **Arguments must be string literals.** `tp.mcpTools.prompt("topic")` works. `tp.mcpTools.prompt(someVar)` does not — the parser only accepts literal strings, not expressions, variables, or template interpolations.
- **The second argument (description) is optional** but strongly recommended. Without it, the client UI shows the parameter name only and the user has to guess what to type.
- **All parameters are optional at validation time.** The server does not currently enforce "required" arguments — if the user omits one, the Templater function simply returns an empty string when invoked inside the template. This is a deliberate choice: it keeps prompts usable even when invoked with partial inputs. If you need a parameter to be mandatory, guard it inside the template body (e.g. `<% if (tp.mcpTools.prompt("topic") === "") return "Please supply a topic" %>`).
- **Templater modifier characters** (`*`, `-`, `_`) on the tag delimiters are supported: `<%* … %>`, `<%- … -%>`, etc. The parser strips them before running the AST walk.
- **Duplicate names are allowed** but pointless — the client only displays each unique parameter once in its UI, and all usages inside the template reference the same value.

### Using arguments inside the template

Arguments are substituted at execution time using `{{name}}` Mustache-style placeholders. You can scatter them throughout the template freely:

```markdown
Write a {{length}} summary about **{{topic}}**.

Focus on:
- How {{topic}} relates to productivity
- Practical takeaways the reader can apply today
```

In the example above, `topic` appears twice but only shows up **once** in the client's parameter form (declared via a single `<% tp.mcpTools.prompt("topic", …) %>`). The user enters it once and the value is injected everywhere.

## A complete example

```markdown
---
tags:
  - mcp-tools-prompt
description: Summarize my recent daily notes on a given topic
---

<%*
// This comment block is a Templater run mode — it's ignored by the
// prompt parser because the parser only extracts tp.mcpTools.prompt()
// calls, not plain JS statements.
-%>

Summarize my notes from the past **<% tp.mcpTools.prompt("days", "How many days back to look, e.g. 7") %>** days
about **<% tp.mcpTools.prompt("topic", "The subject — e.g. 'writing habits'") %>**.

Give me:

1. The three most recurring themes.
2. Any contradictions I wrote down on different days.
3. An action item I should act on this week.

Ignore any note that contains the tag `#archive`.
```

When this file is placed at `{vault}/Prompts/daily-notes-summary.md`, an MCP client will see a new prompt called `daily-notes-summary` with:

- Description: *"Summarize my recent daily notes on a given topic"* (from frontmatter)
- Parameters: `days` (*"How many days back to look, e.g. 7"*), `topic` (*"The subject — e.g. 'writing habits'"*)

The user clicks it in the client UI, fills in `days=7` and `topic=focus habits`, and the client sends the rendered text as the first message of a new conversation.

## How the server actually runs a prompt

This is the flow the user doesn't see but which every maintainer should understand before changing anything.

### Discovery — `prompts/list`

Triggered when the MCP client asks "what prompts are available?":

1. `app.vault.getMarkdownFiles()` — enumerate all `.md` files in the vault (in-process, zero HTTP calls).
2. Filter to files whose path starts with `Prompts/` and have no further `/` after the prefix (flat root only).
3. For each surviving file:
   1. `app.metadataCache.getFileCache(file)?.frontmatter` — read frontmatter from Obsidian's in-memory metadata cache.
   2. Validate with `PromptFrontmatterSchema` (requires the `mcp-tools-prompt` tag). On failure → skip silently.
   3. `app.vault.cachedRead(file)` → read the file body from the cache.
   4. Parse `<% tp.mcpTools.prompt(name, description) %>` declarations with a regex to build the argument list.
4. Return a `PromptListEntry[]` containing `{ name, description, arguments }` for each surviving file.

Cost: no HTTP calls, no filesystem I/O — everything is served from Obsidian's in-memory vault and metadata cache. Discovery is effectively instant.

### Execution — `prompts/get`

Triggered when the user selects a prompt and clicks "insert" in the client UI:

1. Locate `Prompts/{name}.md` via `app.vault.getAbstractFileByPath()`. If absent → `McpError(InvalidParams)`.
2. Re-validate the frontmatter (same `PromptFrontmatterSchema` check as discovery). If invalid → `McpError(InvalidParams)`.
3. `app.vault.cachedRead(file)` → read the raw content.
4. Render the prompt:
   1. `stripFrontmatter` — remove the `---…---` block.
   2. `stripArgDeclarations` — remove lines containing `<% tp.mcpTools.prompt(…) %>`.
   3. `substituteArgs` — replace every `{{key}}` placeholder with the user-supplied value. Unknown keys are left as-is.
   4. Trim leading blank lines left after stripping declarations.
5. `expandEmbeds` — expand `![[note]]` transclusions (see below).
6. Wrap the result in an MCP `GetPromptResult`:
   ```ts
   { messages: [{ role: "user", content: { type: "text", text: rendered } }] }
   ```

### Transclusion — `![[note]]` in a prompt body

A prompt body may embed another note with Obsidian's own syntax, and the note's content is inlined
before the prompt reaches the model. A "weekly review" prompt therefore arrives already carrying the
notes it refers to, instead of costing a tool call per note after the fact.

Supported forms: `![[note]]`, `![[note|alias]]` (the alias is display-only and is discarded),
`![[note#Heading]]` (the section down to the next heading of the same or a higher level), and
`![[note#^blockid]]`.

Expansion runs **after** argument substitution, so `![[{{note}}]]` resolves through an argument
value — the client picks the note, the prompt embeds it. The reverse is deliberately not true:
`{{placeholder}}` appearing *inside* an embedded note is left literal and never substituted. An
embedded note is data, not a template, and substituting into it would let any note in the vault
consume the prompt's arguments.

Embedded content is passed through `stripFrontmatter` and `stripArgDeclarations`, matching how
Obsidian renders a transclusion and preventing a shared preamble that is itself a prompt file from
leaking its `<% tp.mcpTools.prompt(…) %>` line.

**Nothing is ever dropped silently.** When an embed cannot be expanded — target not found, not a
markdown file, heading or block missing, nested one level deep, or over budget — the original
`![[…]]` token is kept verbatim and followed by an HTML comment naming the reason:

```
![[Missing note]] <!-- prompt-transclusion: not expanded (not found) -->
```

The token stays useful (the model can follow it with `get_vault_file`) and the comment is invisible
if the text is ever rendered.

Limits, all fixed rather than configurable:

| Limit | Value | Why |
| --- | --- | --- |
| Depth | 1 | Embeds inside embedded content are not followed. A counter is a stronger guard than cycle detection: a self-embed inlines once and stops, and `A → B → A` cannot close. |
| Total embedded bytes | 32 KB per render, cumulative, first-fit in document order | A prompt body enters the conversation unconditionally, so it gets a tighter budget than a tool result. Deliberately **not** `mcpTools.maxTextOutputKB`: that is the `get_vault_file` ceiling, and raising it for file reads must not uncap prompt payloads. |
| Embeds expanded | 20 per render | Bounds the number of vault reads one `prompts/get` can trigger. |

An over-budget embed is **skipped whole, never truncated** — a note cut mid-sentence is worse input
than a pointer the model can choose to follow. A prompt with no embeds is returned byte for byte
unchanged.

Two deliberate divergences from Obsidian's own rendering: a nested heading path (`![[note#A#B]]`) is
not resolved and falls to the "heading not found" marker, and an embed inside a code fence **is**
expanded, where Obsidian would leave it alone. A fence-aware scanner is disproportionate for this
surface.

Note: **Templater is not required** for this implementation. `<% tp.mcpTools.prompt(…) %>` lines are stripped from the rendered output; any other Templater expressions (`<% tp.date.now() %>`, `<%* … %>`, etc.) are returned **verbatim** in the text — they are not evaluated by the MCP server. If you need evaluated Templater output, run the template through Obsidian's Templater plugin separately.

## Known limitations

- **No "required" argument enforcement.** All parameters are optional from the validator's point of view. If the user omits one, the `{{placeholder}}` is left as-is in the rendered text.
- **No nested `Prompts/` subfolders.** Only direct children of `Prompts/` are scanned. If you want to organize prompts by category, use tag-based or frontmatter-based filtering inside the folder.
- **Filenames are the prompt IDs.** There's no separate "name" field in the frontmatter that would let you rename the prompt displayed to the client without renaming the file. If you want a prettier name, rename the file.
- **Transclusion does not recurse.** An embed inside an embedded note is left as literal text with a marker. One level is intentional, not a placeholder for a deeper implementation.
- **Prompts cannot emit images, audio, or multiple messages.** The result is always a single user message with `type: "text"`. Multimodal prompts would require a significant refactor.
- **Templater expressions not evaluated.** Only `{{arg_name}}` placeholders are substituted. All other Templater expressions (`<% tp.date.now() %>`, `<%* … %>`, etc.) are passed through verbatim.
- **No error when a file almost-satisfies the contract.** If you misspell the tag or put the file in `prompts/` (lowercase), the file is silently skipped — there is no diagnostic in the plugin settings telling you which files were considered and rejected. If you expect a prompt to appear and it doesn't, check the three conditions above in order.

## Client-side: how to invoke prompts

This section is client-specific — each MCP client surfaces prompts differently.

### Claude Desktop

Prompts appear in the "Attach from MCP" button at the bottom of the chat input. Click the paperclip-style icon, pick the MCP server (`mcp-tools-istefox`), then the prompt you want. If the prompt has arguments, Claude Desktop prompts you for each one. Pressing Enter sends the rendered text as the first user message.

### Claude Code (Anthropic CLI)

Prompts appear as slash commands: `/mcp__mcp-tools-istefox__my-prompt`. Arguments are passed inline after the slash command. See the Claude Code docs for the exact syntax, which may change between versions.

### Other clients

Consult your client's documentation. The MCP specification reserves the right for clients to expose prompts however they like — slash commands, modal dialogs, dropdowns, inline buttons, etc.

## References

- Feature entry point: `packages/obsidian-plugin/src/features/prompts/index.ts` — `setup()` wires the `PromptRegistry` with lister and wildcard handler; `teardown()` stops the vault watcher.
- Prompt discovery: `packages/obsidian-plugin/src/features/prompts/services/promptDiscovery.ts` — `discoverPrompts()` and `parseArgDeclarations()`.
- Prompt renderer: `packages/obsidian-plugin/src/features/prompts/services/promptRenderer.ts` — `renderPrompt()`, `stripFrontmatter()`, `stripArgDeclarations()`, `substituteArgs()`.
- Vault watcher: `packages/obsidian-plugin/src/features/prompts/services/vaultWatcher.ts` — `createVaultWatcher()` registers `create`/`delete`/`rename` event refs.
- Prompt registry: `packages/obsidian-plugin/src/features/mcp-transport/services/promptRegistry.ts` — `PromptRegistryClass` with `setLister`, `setHandler`, `list`, `dispatch`.
- MCP wiring: `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts` — `createMcpService()` constructs `PromptRegistryClass` and wires `ListPromptsRequestSchema` + `GetPromptRequestSchema`.
- Frontmatter schema: `packages/shared/src/types/prompts.ts` — `PromptFrontmatterSchema` with the `mcp-tools-prompt` tag narrow.
- [Model Context Protocol prompts spec](https://modelcontextprotocol.io/docs/concepts/prompts) — upstream protocol documentation.
