/**
 * Settings augmentation for the tool-toggle feature. Lives here (not in
 * the root plugin types.ts) so the feature stays self-contained per the
 * .clinerules feature architecture rule.
 */
declare module "obsidian" {
  interface McpToolsPluginSettings {
    toolToggle?: {
      /**
       * List of MCP tool names the user has chosen to disable. Persisted
       * by `plugin.saveData()` and applied in-process by
       * `applyDisabledToolsFilter` at registry setup. (The former server
       * binary read it as the `OBSIDIAN_DISABLED_TOOLS` env var.)
       */
      disabled?: string[];
    };
  }
}

export {};
