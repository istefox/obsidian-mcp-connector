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

Current features: core (plugin initialization and settings), mcp-transport (the in-process HTTP MCP server), mcp-tools (MCP tool handlers for vault, fetch, commands, Canvas, and more), prompts (vault-driven MCP prompts, tag-gated), semantic-search (native semantic search via Transformers.js), command-permissions (gated execution of Obsidian commands), adaptive-tool-loading (profile-based tool activation with frequency promotion), tool-toggle (enable or disable individual tools), and mcp-client-config (writes the MCP client config such as claude_desktop_config.json).

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
