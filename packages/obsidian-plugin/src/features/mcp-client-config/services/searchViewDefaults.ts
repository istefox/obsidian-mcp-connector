import {
  readPolicy,
  updateTokenPolicy,
} from "$/features/adaptive-tool-loading/tokenPolicyStore";
import type { PluginDataLike } from "$/shared/types";

/**
 * Clients that cannot render the MCP Apps `ui://` search-results view
 * still receive its `_meta` payload in the legacy era, about 3.8 KB on a
 * 3-result search, more than the result itself (#626). The Codex install
 * and the Claude Code config copy know which client the token is for, so
 * they turn the view off for that token.
 *
 * Only a token that still inherits the vault-wide setting is touched: an
 * explicit choice in Access Control, on or off, is the user's and wins.
 */

/** True when `tokenId` has no per-token `searchResultsView` override. */
export async function inheritsSearchResultsView(
  plugin: PluginDataLike,
  tokenId: string,
): Promise<boolean> {
  const policy = await readPolicy(plugin, tokenId);
  return typeof policy.searchResultsView !== "boolean";
}

/**
 * Sets `searchResultsView: false` on `tokenId` when it still inherits.
 * Re-reads first, so a choice made while a modal was open is kept.
 * Returns whether it wrote.
 */
export async function hideSearchResultsViewIfInherited(
  plugin: PluginDataLike,
  tokenId: string,
): Promise<boolean> {
  if (!(await inheritsSearchResultsView(plugin, tokenId))) return false;
  await updateTokenPolicy(plugin, tokenId, { searchResultsView: false });
  return true;
}

/** The sentence a Notice appends when the view was turned off. */
export const SEARCH_VIEW_HIDDEN_NOTICE =
  "The search-results view is now off for this token, since this client cannot show it. Change it in Access Control.";
