import { TOOL_ANNOTATIONS } from "$/features/mcp-tools/toolAnnotations";
import { ALWAYS_ACTIVE_TOOLS } from "$/features/adaptive-tool-loading/constants";

/**
 * Tool names the settings UI lets the user disable, derived from the
 * annotation table rather than maintained by hand. The mcpServer
 * full-registry test enforces that every registered tool has an
 * annotations entry, so the table is the one list that cannot drift
 * from the registry.
 *
 * The adaptive-loading meta-tools (`tool_catalog`, `activate_tool`,
 * `activate_tools`) are left out: they are the mechanism a client uses
 * to reach every other tool, and disabling them would silently break
 * the adaptive mode without disabling any vault capability. The runtime
 * filter in `tool-toggle/services/applyFilter.ts` still honours any
 * name a user wrote into `data.json` by hand.
 */
export const KNOWN_MCP_TOOL_NAMES: readonly string[] = Object.keys(
  TOOL_ANNOTATIONS,
).filter((name) => !ALWAYS_ACTIVE_TOOLS.includes(name));

/**
 * Tools that can write to the vault or the host system: every tool
 * whose annotations do not carry `readOnlyHint: true`. Additive writers
 * (append, create directory, periodic-note creation) count as well,
 * since the preset promises a read-only MCP surface, not merely a
 * non-destructive one. Surfaced in the settings UI as the one-click
 * "Disable write operations" preset.
 */
export const DESTRUCTIVE_TOOL_NAMES: readonly string[] =
  KNOWN_MCP_TOOL_NAMES.filter(
    (name) => TOOL_ANNOTATIONS[name]?.readOnlyHint !== true,
  );

/**
 * Parse the comma-or-newline-separated list of tool names the user
 * types into the settings textarea. Whitespace around each entry is
 * trimmed and empty entries (from double commas, trailing commas, or
 * blank lines) are dropped. Duplicates are preserved so the user sees
 * exactly what they typed.
 *
 * Exported for unit testing.
 */
export function parseDisabledToolsCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
