/**
 * Tools the desktop plugin registers that the headless server cannot
 * serve, because they need the running Obsidian app: the open file and
 * the workspace, the command palette, and the Dataview, Templater and
 * Bookmarks plugins. `registerTools.test.ts` checks that this list and
 * the headless registration together account for every desktop tool, and
 * the smoke test checks that the bundle serves none of them.
 */
export const DESKTOP_ONLY_TOOLS: readonly string[] = [
  "get_active_file",
  "update_active_file",
  "append_to_active_file",
  "patch_active_file",
  "delete_active_file",
  "show_file_in_obsidian",
  "get_workspace_state",
  "list_bookmarks",
  "execute_dataview_query",
  "list_obsidian_commands",
  "execute_obsidian_command",
  "execute_template",
];
