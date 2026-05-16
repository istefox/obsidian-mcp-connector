> Reflects the 0.4.x in-process architecture. Authoritative contract: CLAUDE.md / .clinerules.

# Project Architecture

Use the following structure and conventions for all new features.

## Monorepo Structure

This project uses a monorepo with multiple packages:

- `packages/obsidian-plugin` - The Obsidian plugin (hosts the in-process HTTP MCP server)
- `packages/shared` - Shared code between packages
- `docs/` - Project documentation
- `docs/features` - Feature requirements

### Package Organization

```
packages/
├── obsidian-plugin/     # Obsidian plugin (in-process MCP server, 0.4.x)
│   ├── src/
│   │   ├── features/   # Feature modules
│   │   └── main.ts     # Plugin entry point
│   └── manifest.json   # Plugin metadata
│
└── shared/             # Shared utilities and types
    └── src/
        ├── types/      # Common interfaces
        ├── utils/      # Common utilities
        └── constants/  # Shared configuration
```

## Feature-Based Architecture

The Obsidian plugin uses a feature-based architecture where each feature is a self-contained module.

### Feature Structure

```
src/features/
├── core/                # Plugin initialization and settings
├── mcp-tools/           # MCP tool handlers (vault, fetch, commands)
├── mcp-transport/       # In-process HTTP MCP server
├── prompts/             # MCP prompts (vault-driven, tag-gated)
├── mcp-client-config/   # claude_desktop_config.json writer
├── semantic-search/     # Native semantic search via Transformers.js
└── migration/           # Settings migration helpers

Each feature contains:
feature/
├── components/    # UI components
├── services/     # Business logic
├── types.ts      # Feature-specific types
├── utils.ts      # Feature-specific utilities
├── constants.ts  # Feature-specific constants
└── index.ts      # Public API with setup function
```

### Feature Management

Each feature exports a setup function for initialization:

```typescript
export async function setup(plugin: Plugin): Promise<SetupResult> {
  // Check dependencies
  // Initialize services
  // Register event handlers
  return { success: true } || { success: false, error: "reason" };
}
```

Features:

- Initialize independently
- Handle their own dependencies
- Continue running if other features fail
- Log failures for debugging

### McpToolsPlugin Settings Management

Use TypeScript module augmentation to extend the McpToolsPluginSettings interface:

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

Extending the settings interface allows for type-safe access to feature settings
via `McpToolsPlugin.loadData()` and `McpToolsPlugin.saveData()`.

### Version Management

Unified version approach:

- Plugin and server share version number
- Version stored in plugin manifest
- Server binaries include version in filename
- Version checked during initialization

### UI Integration

The core feature provides a PluginSettingTab that:

- Loads UI components from each feature
- Maintains consistent UI organization
- Handles conditional rendering based on feature state

### Error Handling

Features implement consistent error handling:

- Return descriptive error messages
- Log detailed information for debugging
- Provide user feedback via Obsidian Notice API
- Clean up resources on failure
