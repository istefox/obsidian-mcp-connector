import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool annotations (spec 2025-03-26+), keyed by public tool name.
 *
 * These are HINTS for clients (confirmation gating, visual badges) —
 * never security boundaries. Spec defaults for a non-listed field:
 * readOnlyHint false, destructiveHint true, idempotentHint false,
 * openWorldHint true. Every vault tool sets openWorldHint: false
 * (closed domain); `fetch` is the only open-world tool.
 *
 * destructiveHint is explicit on every writer, including where it
 * matches the spec default, so the classification is reviewable here
 * instead of implied. The mcpServer full-registry test enforces that
 * every registered tool has an entry.
 */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

/** Additive writers: they never overwrite or remove existing content. */
const SAFE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/** Writers that can overwrite or remove existing content. */
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Health / server
  get_server_info: READ_ONLY,

  // Active file
  get_active_file: READ_ONLY,
  // Replaces the whole file content.
  update_active_file: { ...DESTRUCTIVE, idempotentHint: true },
  append_to_active_file: SAFE_WRITE,
  patch_active_file: DESTRUCTIVE,
  delete_active_file: DESTRUCTIVE,
  // Only changes which file the Obsidian UI shows.
  show_file_in_obsidian: { ...READ_ONLY, idempotentHint: true },

  // Vault files
  list_vault_files: READ_ONLY,
  get_vault_file: READ_ONLY,
  get_vault_files: READ_ONLY,
  get_vault_file_partial: READ_ONLY,
  // Overwrites when the path already exists (documented behavior).
  create_vault_file: { ...DESTRUCTIVE, idempotentHint: true },
  // Same overwrite semantics as create_vault_file, for binary content.
  create_vault_binary_file: { ...DESTRUCTIVE, idempotentHint: true },
  append_to_vault_file: SAFE_WRITE,
  patch_vault_file: DESTRUCTIVE,
  delete_vault_file: DESTRUCTIVE,
  rename_vault_file: DESTRUCTIVE,
  rename_heading: DESTRUCTIVE,
  create_vault_directory: { ...SAFE_WRITE, idempotentHint: true },
  delete_vault_directory: DESTRUCTIVE,

  // Search
  search_vault: READ_ONLY,
  search_vault_simple: READ_ONLY,
  search_vault_smart: READ_ONLY,
  search_and_replace: DESTRUCTIVE,

  // Network
  fetch: { readOnlyHint: true, openWorldHint: true },

  // Obsidian commands / integrations
  // Commands are arbitrary; assume the worst.
  execute_obsidian_command: DESTRUCTIVE,
  list_obsidian_commands: READ_ONLY,
  // Templater templates can run user-defined code and write files.
  execute_template: DESTRUCTIVE,
  execute_dataview_query: READ_ONLY,

  // Graph / metadata
  find_broken_links: READ_ONLY,
  find_orphaned_notes: READ_ONLY,
  get_backlinks: READ_ONLY,
  get_outgoing_links: READ_ONLY,
  get_files_by_tag: READ_ONLY,
  list_tags: READ_ONLY,
  list_property_values: READ_ONLY,
  get_note_outline: READ_ONLY,

  // Note properties
  get_note_property: READ_ONLY,
  // Replaces the existing value for the key.
  set_note_property: { ...DESTRUCTIVE, idempotentHint: true },
  delete_note_property: DESTRUCTIVE,

  // Periodic notes / misc
  get_recent_files: READ_ONLY,
  get_vault_overview: READ_ONLY,
  list_bookmarks: READ_ONLY,
  get_or_create_daily_note: { ...SAFE_WRITE, idempotentHint: true },
  get_or_create_periodic_note: { ...SAFE_WRITE, idempotentHint: true },
  append_to_periodic_note: SAFE_WRITE,

  // Canvas
  get_canvas: READ_ONLY,
  add_canvas_node: SAFE_WRITE,
  connect_canvas_nodes: SAFE_WRITE,

  // Adaptive-loading meta-tools (registered in mcpServer.ts; lookup is
  // name-keyed at list() time, so the entry can live here regardless).
  tool_catalog: READ_ONLY,
  activate_tool: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  activate_tools: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
