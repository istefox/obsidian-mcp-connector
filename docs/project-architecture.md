> Reflects the current in-process architecture (0.20.0 line). For exact versions, the tool list, and release detail, see README.md and CHANGELOG.md.

# Project Architecture

Use this structure and these conventions for new features.

## Monorepo Structure

The project is a Bun monorepo:

- `packages/obsidian-plugin`: the Obsidian plugin, which hosts the in-process HTTP MCP server
- `packages/shared`: code shared across packages
- `docs/`: project documentation, including the architecture decision records under `docs/architecture/`
- root `manifest.json`, `versions.json`, `package.json`: plugin metadata and build config

### Package Organization

```
.
├── manifest.json          # Plugin metadata (id, version, minAppVersion) — read by Obsidian
├── versions.json          # Plugin version → minAppVersion map
├── package.json           # Build scripts and dependencies
└── packages/
    ├── obsidian-plugin/   # Obsidian plugin (in-process MCP server)
    │   └── src/
    │       ├── features/  # Feature modules
    │       └── main.ts    # Plugin entry point
    └── shared/            # Shared utilities and types
        └── src/
            ├── types/     # Common interfaces
            ├── logger.ts  # Shared logger
            └── index.ts   # Public API
```

## Feature-Based Architecture

The plugin is organized by feature. Each feature is a self-contained module that sets itself up, owns its dependencies, and keeps running even if another feature fails.

Current features: core (plugin initialization and settings), mcp-transport (the in-process HTTP MCP server), mcp-tools (MCP tool handlers for vault, fetch, commands, Canvas, and more), mcp-apps (the `ui://` resource that renders `search_vault_smart` and `search_vault_simple` results in a host that speaks the MCP Apps extension), prompts (vault-driven MCP prompts, tag-gated), semantic-search (native semantic search via Transformers.js), command-permissions (gated execution of Obsidian commands), adaptive-tool-loading (profile-based tool activation with frequency promotion), tool-toggle (enable or disable individual tools), and mcp-client-config (writes the MCP client config such as claude_desktop_config.json).

### Feature Structure (convention for new features)

```
src/features/<feature>/
├── components/   # UI components
├── services/     # business logic
├── types.ts      # feature-specific types
├── utils.ts      # feature-specific utilities
├── constants.ts  # feature-specific constants
└── index.ts      # public API with a setup function
```

### Feature Management

Each feature exports a setup function for initialization. Features initialize independently, handle their own dependencies, continue running if other features fail, and log failures for debugging.

```typescript
export async function setup(plugin: Plugin): Promise<SetupResult> {
  // Check dependencies
  // Initialize services
  // Register event handlers
  return { success: true } || { success: false, error: "reason" };
}
```

### Settings Management

Use TypeScript module augmentation to extend the `McpToolsPluginSettings` interface:

```typescript
// packages/obsidian-plugin/src/types.ts
declare module "obsidian" {
  interface McpToolsPluginSettings {
    version?: string;
  }

  interface Plugin {
    loadData(): Promise<McpToolsPluginSettings>;
    saveData(data: McpToolsPluginSettings): Promise<void>;
  }
}

// packages/obsidian-plugin/src/features/some-feature/types.ts
declare module "obsidian" {
  interface McpToolsPluginSettings {
    featureName?: {
      setting1?: string;
      setting2?: boolean;
    };
  }
}
```

Extending the settings interface gives type-safe access to feature settings via `Plugin.loadData()` and `Plugin.saveData()`.

### Version Management

The plugin ships a single version, with no separate server binary. The version lives in the root `manifest.json` and `package.json`, `versions.json` maps each plugin version to its minimum Obsidian version, and `scripts/version.ts` bumps all three in one step.

### UI Integration

The core feature provides a `PluginSettingTab` that loads UI from each feature, keeps the settings layout consistent, and renders conditionally based on feature state.

### Error Handling

Features implement consistent error handling: they return descriptive error messages, log detailed information for debugging, give the user feedback through the Obsidian Notice API, and clean up resources on failure.

## MCP Request Path

The transport serves two protocol eras on one endpoint, `POST /mcp` (ADR-0016). Every request goes through one chain, is classified once, and is then served by the era it belongs to:

```
POST /mcp
 └─ runMiddleware        method + path → Origin → MCP-Protocol-Version (pre-2026 half)
    (httpServer.ts)      → bearer auth (tokenId); then the declared-length body cap
 └─ readBodyWithCap      the body is read ONCE, here, and shared from here on
    (mcpServer.ts)
 └─ classifyEra          isLegacyRequest, from that single read
    (eraRouter.ts)
     ├─ legacy → NodeStreamableHTTPServerTransport, per request, stateless
     └─ modern → createMcpHandler(factory, { legacy: "reject" }) via toNodeHandler
          └─ buildMcpServer(tokenId)   ← reached by both branches, built in one place
```

- **The body is read once.** `readBodyWithCap` drains the stream before anything else runs, so the classifier and whichever handler serves the request are both fed the same parsed value. A second read yields an empty stream and a spurious parse error. A body that fails `JSON.parse` classifies legacy without a `Request` being constructed at all.
- **The protocol-version rung is split by era.** `checkProtocolVersion` (`middleware.ts`) rejects a pre-2026 revision this server does not serve, at 400, in the chain, before auth. A 2026-era revision is deferred instead: only classification can tell whether the SDK's validation ladder owns the answer, and that answer carries `supported` and `requested` where this project's error body carries neither. `applyDeferredVersionRung` (`eraRouter.ts`) answers the deferred case that then classifies legacy, so no unsupported-version 400 is lost.
- **`buildMcpServer(tokenId)` is the single construction site for both eras.** The legacy branch calls it directly; the modern branch reaches it through the SDK's `McpServerFactory`, which receives the token id as pass-through `AuthInfo.clientId` — never the bearer secret. Tool-scope resolution, registry wiring, prompt handlers and usage counting exist once, so per-token tool surfaces cannot drift between the two paths.
- **Lifecycle differs by branch.** `buildMcpServer` closes nothing. The legacy branch owns its own `finally` teardown; on the modern branch the SDK entry owns the instance.
- **`server/discover` is not hand-written.** The SDK's serving entry installs it on whatever instance the factory returns, and stamps server identity into every modern result's `_meta`. A hand-built `McpServer` answers `-32601` to it.
- Each classified request is counted against its era in `mcpTransport.eraCounters`, batched in memory and flushed through `SettingsStore.updateSlice`. The counter is diagnostic: nothing reads it at runtime.

## Resources Surface

`buildMcpServer(tokenId)` also declares a `resources` capability (ADR-0018) and registers two methods against a `ResourceRegistry` filled at composition time, shaped like the existing `PromptRegistry`:

- `resources/list` — returns the registry's static `ui://` entries with their mime type.
- `resources/read` — returns the generated HTML for a known `ui://` URI at `text/html;profile=mcp-app`; an unknown URI is a protocol error naming it, never an empty result.
- `resources/templates/list` — not registered. Declaring the capability makes the SDK constructor install all three resource handlers; overriding `list` and `read` and leaving the third alone means the SDK's own handler answers `{ resourceTemplates: [] }`.

The registry serves `ui://` application resources only, and nothing else. `ToolScope`, the per-token allowlist and `userDisabled` are all tool-level concepts that do not reach `resources/read` — putting vault content on this surface would need a policy model designed from scratch, so vault notes are deliberately not exposed here. The registry is populated once, from a static declaration, and never dereferences a token id.

Both capability fields are declared explicitly — `resources: { subscribe: false, listChanged: false }` — because the SDK rewrites a bare `{}` to `listChanged: true` at handler-registration time, and this transport is POST-only so `subscribe` can never be honoured. The two search tools carry `_meta.ui.resourceUri` on their `tools/list` entries, pointing at the one static `ui://mcp-connector/search-results` page; their results carry the structured row payload in the result's own `_meta`, success branch only.
