export const PROMOTION_THRESHOLD = 3;

/** Always active regardless of profile — informational, no side effects. */
export const ALWAYS_ACTIVE_TOOLS: readonly string[] = ["tool_catalog"];

/** Active only in adaptive and all profiles — can expand the tool surface. */
export const ADAPTIVE_META_TOOLS: readonly string[] = ["activate_tool"];

/** Combined set used for promotion-exclusion checks in recordCall. */
export const META_TOOLS: readonly string[] = [
  ...ALWAYS_ACTIVE_TOOLS,
  ...ADAPTIVE_META_TOOLS,
];

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
