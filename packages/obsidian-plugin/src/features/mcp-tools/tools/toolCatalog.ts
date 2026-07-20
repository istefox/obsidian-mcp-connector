import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { RegistryLike } from "$/features/adaptive-tool-loading/types";
import type { PluginReadLike } from "$/shared/types";

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

// Read-only persistence view (PluginReadLike, no saveData): the
// catalog never writes.
type PluginLike = PluginReadLike;

// Inactive tools only surface their first sentence — the remaining prose is
// pure token cost in the catalog listing. Split on the first ". " sentence
// boundary and keep the period; a single-sentence description is returned
// verbatim.
function firstSentence(description: string): string {
  const i = description.indexOf(". ");
  return i === -1 ? description : description.slice(0, i + 1);
}

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

  const catalog: ToolEntry[] = entries
    .filter((entry) => !entry.userDisabled)
    .map((entry) => {
      const callCount = counters[entry.name] ?? 0;
      if (!entry.enabled) {
        return {
          name: entry.name,
          status: "inactive",
          call_count: callCount,
          description: entry.description
            ? firstSentence(entry.description)
            : undefined,
        };
      }
      return {
        name: entry.name,
        status: promoted.has(entry.name) ? "promoted" : "active",
        call_count: callCount,
      };
    });

  return successText(JSON.stringify(catalog));
}
