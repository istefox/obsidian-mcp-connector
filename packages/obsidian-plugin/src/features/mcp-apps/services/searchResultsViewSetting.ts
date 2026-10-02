/**
 * The MCP Apps off switch (discussion #543, ADR-0018 addendum).
 *
 * Some hosts render the `ui://` search-results view fully expanded and
 * uncollapsible, so one search buries the conversation. The view is
 * therefore switchable: a vault-wide default in the `mcpTools` slice and
 * a per-token override in that token's policy, the override winning when
 * set. Both default to on, so nothing changes for a vault that never
 * touches the setting.
 *
 * What "off" means on the wire, and what it deliberately leaves alone:
 *
 * - `tools/list` entries for the two search tools lose their `_meta.ui`
 *   and `_meta["ui/resourceUri"]` pointers, so a host never learns there
 *   is a view to render.
 * - `tools/call` results lose the `_meta` row payload, on every era. The
 *   search tools already withhold it when told the client declared no UI
 *   support; the switch reuses that path by forcing the signal to `false`.
 * - The `ui://` resource stays listed and readable, and the extension
 *   capability stays declared. Those are server facts, not per-caller
 *   ones, and a host that reads the resource without a pointer from a
 *   tool has nothing to attach it to. Withdrawing them would also move
 *   the `initialize` bytes for every token because of one token's choice.
 */

import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";

/**
 * Default for `mcpTools.searchResultsView`. On, because the view shipped
 * on in 2.0.0 and the switch exists for the hosts where it misbehaves,
 * not to retire the feature.
 */
export const DEFAULT_SEARCH_RESULTS_VIEW = true;

/**
 * The `_meta` keys `tools/list` drops when the view is off — the two
 * forms `wireSearchResultsApp` writes. Exported so the registry's strip
 * and the writer cannot drift apart.
 */
export const SEARCH_RESULTS_UI_META_KEYS: readonly string[] = [
  "ui",
  "ui/resourceUri",
];

/** The one field of a token's policy this module reads. */
export type SearchResultsViewPolicy = {
  /** `undefined` means "inherit the vault-wide setting". */
  searchResultsView?: boolean;
};

/** The vault-wide default, as stored. Absent or malformed → the default. */
export async function readGlobalSearchResultsView(
  plugin: PluginDataLike | undefined,
): Promise<boolean> {
  if (!plugin) return DEFAULT_SEARCH_RESULTS_VIEW;
  const slice = (await new SettingsStore(plugin).readSlice("mcpTools")) as
    | { searchResultsView?: unknown }
    | undefined;
  const value = slice?.searchResultsView;
  return typeof value === "boolean" ? value : DEFAULT_SEARCH_RESULTS_VIEW;
}

/**
 * Whether the search-results view is in force for one caller: the
 * token's override when it has one, the vault-wide setting otherwise.
 * Pure over its inputs so the two layers can be tested apart from the
 * settings read.
 */
export function effectiveSearchResultsView(
  global: boolean,
  policy: SearchResultsViewPolicy,
): boolean {
  return typeof policy.searchResultsView === "boolean"
    ? policy.searchResultsView
    : global;
}

/** {@link effectiveSearchResultsView} over the stored vault-wide value. */
export async function resolveSearchResultsView(
  plugin: PluginDataLike | undefined,
  policy: SearchResultsViewPolicy,
): Promise<boolean> {
  // Skip the settings read when the override decides: it is the common
  // case for a token that opted out, and tools/* pays this per request.
  if (typeof policy.searchResultsView === "boolean") {
    return policy.searchResultsView;
  }
  return readGlobalSearchResultsView(plugin);
}
