/**
 * Client-facing tool metadata, keyed by public tool name: the MCP `title`
 * field and the `anthropic/*` `_meta` hints Claude Code reads. Applied by
 * `registerTools` alongside `TOOL_ANNOTATIONS`; both are looked up by name
 * at `list()` time, so the meta-tools registered later in
 * `composeToolRegistry` are covered too.
 *
 * Every value here is a hint. A client that does not read the key sees an
 * extra field and nothing else changes.
 *
 * Sources, checked 2026-10-02 against code.claude.com/docs/en/mcp:
 * - `anthropic/alwaysLoad: true` keeps a tool loaded under Claude Code's
 *   tool search, which otherwise defers every MCP tool behind a search
 *   step. The three meta-tools are the plugin's own loading mechanism
 *   (ADR-0011): a model that cannot see `tool_catalog` has no way to learn
 *   what else exists, so they must never be deferred.
 * - `anthropic/maxResultSizeChars` raises Claude Code's inline threshold
 *   for that tool's text results (default ~25,000 tokens, hard ceiling
 *   500,000 chars); past it the result is written to a file and replaced by
 *   a path. `get_vault_file` has a user-set ceiling of up to 10 MiB
 *   (`maxTextOutputKB`), so it declares the ceiling and lets the plugin's
 *   own truncation govern. The two search tools return the model's working
 *   material and are bounded by `limit`; 200,000 keeps a large page of
 *   results inline without inviting a dump.
 */

/** MCP `Tool.title`: hosts label an MCP Apps frame with `name` when absent. */
export const TOOL_TITLES: Record<string, string> = {
  search_vault_simple: "Search vault",
  search_vault_smart: "Semantic search",
};

/** `_meta` keys read by Claude Code. */
export const TOOL_CLIENT_META: Record<string, Record<string, unknown>> = {
  tool_catalog: { "anthropic/alwaysLoad": true },
  activate_tool: { "anthropic/alwaysLoad": true },
  activate_tools: { "anthropic/alwaysLoad": true },
  get_vault_file: { "anthropic/maxResultSizeChars": 500_000 },
  search_vault_simple: { "anthropic/maxResultSizeChars": 200_000 },
  search_vault_smart: { "anthropic/maxResultSizeChars": 200_000 },
};
