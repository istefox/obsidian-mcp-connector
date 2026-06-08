import { type } from "arktype";

export const toolCatalogSchema = type({
  name: '"tool_catalog"',
  arguments: {},
}).describe(
  "Lists all available MCP tools with their status (active/inactive/promoted), call count, and description for inactive tools. Use this to discover which tools are currently loaded and which can be activated.",
);

type ToolEntry = {
  name: string;
  status: "active" | "inactive" | "promoted";
  call_count: number;
  description?: string;
};

type RegistryLike = {
  listAll: () => { name: string; description: string; enabled: boolean }[];
};

type PluginLike = {
  loadData: () => Promise<unknown>;
};

export async function toolCatalogHandler({
  registry,
  plugin,
}: {
  registry: RegistryLike;
  plugin: PluginLike;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const entries = registry.listAll();
  const raw = (await plugin.loadData()) as Record<string, unknown> | null;
  const toolLoading = (raw?.toolLoading ?? {}) as {
    counters?: Record<string, number>;
    promoted?: string[];
  };
  const counters = toolLoading.counters ?? {};
  const promoted = new Set<string>(
    Array.isArray(toolLoading.promoted) ? toolLoading.promoted : [],
  );

  const catalog: ToolEntry[] = entries.map((entry) => {
    const callCount = counters[entry.name] ?? 0;
    if (!entry.enabled) {
      return {
        name: entry.name,
        status: "inactive",
        call_count: callCount,
        description: entry.description || undefined,
      };
    }
    return {
      name: entry.name,
      status: promoted.has(entry.name) ? "promoted" : "active",
      call_count: callCount,
    };
  });

  return {
    content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }],
  };
}
