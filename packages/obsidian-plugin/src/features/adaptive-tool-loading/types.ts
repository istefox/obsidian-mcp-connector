declare module "obsidian" {
  interface McpToolsPluginSettings {
    toolLoading?: {
      profile: "all" | "core" | "adaptive";
      counters: Record<string, number>;
      promoted: string[];
    };
  }
}

export {};
