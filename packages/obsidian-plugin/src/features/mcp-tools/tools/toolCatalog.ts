import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import {
  isActiveFor,
  isAllowedInScope,
} from "$/features/adaptive-tool-loading/resolveToolScope";
import type { RegistryLike } from "$/features/adaptive-tool-loading/types";
import type { PluginReadLike, ToolScope } from "$/shared/types";

export const toolCatalogSchema = type({
  name: '"tool_catalog"',
  arguments: {},
}).describe(
  "Lists all available MCP tools with their status (active/inactive/promoted/unavailable), call count, and description for inactive tools. Use this to discover which tools are currently loaded and which can be activated. Call counts are vault-wide, not per client.",
);

type ToolEntry = {
  name: string;
  /**
   * `inactive` means activatable; `unavailable` means the connecting
   * token's allowed-tools list excludes it, so `activate_tool` would
   * refuse it too (ADR-0014 §9).
   */
  status: "active" | "inactive" | "promoted" | "unavailable";
  /**
   * Omitted entirely when the count is 0 (ADR-0023 R-04): a never-called
   * tool is the common case across the whole catalog, and `"call_count":0`
   * on every one of ~50 entries is pure wire cost. Absent therefore reads
   * as zero — the field is only present once a tool has actually been
   * called.
   */
  call_count?: number;
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
  scope,
}: {
  registry: RegistryLike;
  plugin: PluginLike;
  /**
   * The calling client's resolved surface. Absent means "no per-client
   * policy" — the pre-ADR-0014 global view, kept for the settings UI and
   * unit tests.
   */
  scope?: ToolScope;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const entries = registry.listAll();
  const raw = (await plugin.loadData()) as Record<string, unknown> | null;
  const toolLoading = (raw?.toolLoading ?? {}) as {
    counters?: Record<string, number>;
    promoted?: string[];
    profiles?: Record<string, { promoted?: string[] }>;
  };
  // Counters are vault-wide by design (ADR-0014 §1): call frequency
  // describes the vault's work, not the client's identity.
  const counters = toolLoading.counters ?? {};
  // The promoted list is per token, and the legacy global one is only
  // the mirror of the first token's — reading it under a scope would
  // report another client's promotions.
  const promotedList = scope
    ? toolLoading.profiles?.[scope.id]?.promoted
    : toolLoading.promoted;
  const promoted = new Set<string>(
    Array.isArray(promotedList) ? promotedList : [],
  );

  const catalog: ToolEntry[] = entries
    .filter((entry) => !entry.userDisabled)
    .map((entry) => {
      const callCount = counters[entry.name] ?? 0;
      // Spread-in only when non-zero: the key's absence means zero
      // (see ToolEntry.call_count). A conditional spread rather than
      // `call_count: undefined` because the catalog is JSON-serialized
      // and both forms serialize identically — the spread is the one
      // that also keeps the in-memory object honest for unit tests.
      const countField = callCount > 0 ? { call_count: callCount } : {};
      const isActive = isActiveFor(entry.enabled, entry.name, scope);
      if (isActive) {
        return {
          name: entry.name,
          status: promoted.has(entry.name) ? "promoted" : "active",
          ...countField,
        };
      }
      // Outside the token's ceiling: report it, but without the
      // description — the description exists to help decide whether to
      // activate, and this one can never be activated.
      if (scope && !isAllowedInScope(scope, entry.name)) {
        return {
          name: entry.name,
          status: "unavailable",
          ...countField,
        };
      }
      return {
        name: entry.name,
        status: "inactive",
        ...countField,
        description: entry.description
          ? firstSentence(entry.description)
          : undefined,
      };
    });

  return successText(JSON.stringify(catalog));
}
