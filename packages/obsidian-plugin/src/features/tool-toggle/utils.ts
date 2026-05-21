/**
 * Canonical list of MCP tool names exposed by the in-process server.
 * Authoritative source for the settings UI checkbox grid; the runtime
 * filter in `mcp-tools/index.ts:registerTools` reads
 * `toolToggle.disabled` and skips matching `registry.register()`
 * calls, so the client's `tools/list` only returns the enabled
 * subset.
 *
 * If the registry adds or removes a tool, update this list and the
 * matching `ifEnabled(...)` block in `mcp-tools/index.ts`.
 */
export const KNOWN_MCP_TOOL_NAMES: readonly string[] = [
  // Health
  "get_server_info",
  // Active-file ops (features/mcp-tools/tools/*ActiveFile.ts)
  "get_active_file",
  "update_active_file",
  "append_to_active_file",
  "patch_active_file",
  "delete_active_file",
  "show_file_in_obsidian",
  // Vault-file ops (features/mcp-tools/tools/*VaultFile.ts)
  "list_vault_files",
  "get_vault_file",
  "create_vault_file",
  "append_to_vault_file",
  "patch_vault_file",
  "delete_vault_file",
  // Search (features/mcp-tools/tools/searchVault*.ts)
  "search_vault",
  "search_vault_simple",
  "search_vault_smart",
  // Obsidian command execution (features/mcp-tools/tools/*ObsidianCommand.ts)
  "list_obsidian_commands",
  "execute_obsidian_command",
  // Web fetch + Templater (features/mcp-tools/tools/{fetch,executeTemplate}.ts)
  "fetch",
  "execute_template",
] as const;

/**
 * Tools that mutate the vault or the host system. Surfaced in the
 * settings UI as a one-click "Disable destructive operations" preset
 * for users who want a read-only MCP surface.
 */
export const DESTRUCTIVE_TOOL_NAMES: readonly string[] = [
  "delete_active_file",
  "delete_vault_file",
  "update_active_file",
  "append_to_active_file",
  "patch_active_file",
  "create_vault_file",
  "append_to_vault_file",
  "patch_vault_file",
  "execute_obsidian_command",
  "execute_template",
] as const;

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

/**
 * Format a list of disabled tool names as the exact string expected
 * by the `OBSIDIAN_DISABLED_TOOLS` env var. Returns `undefined` when
 * the list would be empty so callers can omit the env var entirely
 * rather than writing `OBSIDIAN_DISABLED_TOOLS: ""` to the client
 * config file.
 *
 * Exported for unit testing.
 */
export function serializeDisabledToolsToEnv(
  disabled: readonly string[],
): string | undefined {
  const cleaned = disabled.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) return undefined;
  return cleaned.join(", ");
}
