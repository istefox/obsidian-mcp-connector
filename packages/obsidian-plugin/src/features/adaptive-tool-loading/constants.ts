export const PROMOTION_THRESHOLD = 3;

/**
 * Meta-tools that are always active regardless of profile and can never be
 * demoted.
 *
 * `activate_tool` MUST be here: it is the only in-band promotion mechanism,
 * so demoting it (as the `core` profile used to) makes promotion impossible
 * — an inactive tool cannot activate other tools, a circular dead end where
 * `tool_catalog` advertises a tool as promotable but the promotion call
 * fails. `tool_catalog` is here so the catalog itself is always
 * discoverable.
 */
export const ALWAYS_ACTIVE_TOOLS: readonly string[] = [
  "tool_catalog",
  "activate_tool",
  "activate_tools",
];

/** Combined set used for promotion-exclusion checks in recordCall. */
export const META_TOOLS: readonly string[] = [...ALWAYS_ACTIVE_TOOLS];

export const CORE_SET: readonly string[] = [
  "get_server_info",
  "get_active_file",
  "update_active_file",
  "append_to_active_file",
  "get_vault_file",
  "list_vault_files",
  "create_vault_file",
  "search_vault",
  "search_vault_simple",
  "list_tags",
  "get_note_property",
  "set_note_property",
  "get_or_create_daily_note",
];
