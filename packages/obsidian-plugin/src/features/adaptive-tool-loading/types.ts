declare module "obsidian" {
  interface McpToolsPluginSettings {
    toolLoading?: {
      profile: "all" | "core" | "adaptive";
      counters: Record<string, number>;
      promoted: string[];
    };
  }
}

/**
 * Minimal structural view of the tool registry used by the
 * adaptive-loading meta-tools. Defined here (not as the concrete
 * ToolRegistryClass type) so handlers stay testable with plain mocks.
 * Extend locally where a consumer needs more (e.g. disableByName).
 */
export type RegistryLike = {
  listAll: () => {
    name: string;
    description: string;
    enabled: boolean;
    userDisabled: boolean;
  }[];
};
