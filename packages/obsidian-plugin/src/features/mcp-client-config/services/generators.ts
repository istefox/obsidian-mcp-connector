import { type } from "arktype";

/**
 * Pure JSON generators for the three MCP client families the plugin
 * targets. Each function returns the inner
 * `mcpServers` entry only — the UI calls `wrapInMcpServers()` if it
 * wants the full ready-to-paste block.
 *
 * Why three shapes:
 *
 *  1. **Claude Desktop** — does not support direct HTTP MCP transport
 *     yet (anthropics/claude-code#30327). Bridge through the official
 *     `mcp-remote` stdio shim invoked via `npx`.
 *  2. **Claude Code CLI** — supports HTTP MCP transports natively as
 *     `{ type: "http", url, headers }`.
 *  3. **Streamable-HTTP clients** (Cursor, Cline, Continue, Windsurf,
 *     VS Code) — use `{ type: "streamable-http", url, headers }`. A
 *     few clients spell the field `streamableHttp` instead; the
 *     Settings UI surfaces that note next to the copy button.
 *
 * No side effects, no I/O. The Settings UI calls these to populate
 * three "Copy" buttons; the test harness compares structural output.
 */

export const clientConfigInputSchema = type({
  /**
   * Full MCP endpoint URL, including scheme and `/mcp` path. Always
   * `http://127.0.0.1:<port>/mcp` in 0.4.0 — the plugin binds
   * loopback only.
   */
  url: type(/^https?:\/\//).describe(
    "MCP endpoint URL, e.g. http://127.0.0.1:27200/mcp",
  ),
  /** Bearer token. Written verbatim into the Authorization header. */
  token: "string > 0",
  /** Override the entry key. Defaults to FORK_PLUGIN_ID. */
  "pluginId?": "string",
});

export type ClientConfigInput = typeof clientConfigInputSchema.infer;

// ---------------------------------------------------------------------------
// Claude Desktop — npx mcp-remote bridge
// ---------------------------------------------------------------------------

export type ClaudeDesktopEntry = {
  command: "npx";
  args: string[];
};

/**
 * The canonical `npx mcp-remote` bridge invocation. Single source of
 * truth for both consumers of this shape — the Settings-tab copy button
 * (claudeDesktopConfig) and the direct config writer (claudeDesktop.ts)
 * — so a future flag or header change cannot drift between them.
 *
 * It used to name a third consumer, the .mcpb manifest. That stopped
 * being true when ADR-0013 replaced the bundle's npx entry with the
 * pure-Node shim: `mcpbGenerator.ts` emits `command: "node"` against
 * `server/index.js` and does not import this function at all. A comment
 * claiming a coupling that no longer exists is worse here than no
 * comment, since this one exists to promise there is no drift.
 */
export function mcpRemoteInvocation(
  url: string,
  token: string,
): ClaudeDesktopEntry {
  return {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      url,
      "--header",
      `Authorization: Bearer ${token}`,
    ],
  };
}

export function claudeDesktopConfig(
  input: ClientConfigInput,
): ClaudeDesktopEntry {
  return mcpRemoteInvocation(input.url, input.token);
}

// ---------------------------------------------------------------------------
// Claude Code CLI — native HTTP transport
// ---------------------------------------------------------------------------

export type ClaudeCodeEntry = {
  type: "http";
  url: string;
  headers: { Authorization: string };
};

export function claudeCodeConfig(input: ClientConfigInput): ClaudeCodeEntry {
  return {
    type: "http",
    url: input.url,
    headers: { Authorization: `Bearer ${input.token}` },
  };
}

// ---------------------------------------------------------------------------
// Streamable-HTTP clients (Cursor / Cline / Continue / Windsurf / VS Code)
// ---------------------------------------------------------------------------

export type StreamableHttpEntry = {
  type: "streamable-http";
  url: string;
  headers: { Authorization: string };
};

export function streamableHttpConfig(
  input: ClientConfigInput,
): StreamableHttpEntry {
  return {
    type: "streamable-http",
    url: input.url,
    headers: { Authorization: `Bearer ${input.token}` },
  };
}

// ---------------------------------------------------------------------------
// Per-vault entry key
// ---------------------------------------------------------------------------

/** Lowercase ASCII words of the vault name: "My Vault" is `["my", "vault"]`. May be empty. */
export function vaultNameWords(vaultName: string): string[] {
  return vaultName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The client-config key for this vault: `obsidian_<vault>`, words joined
 * by `_`, so "My Vault" is `obsidian_my_vault`. A fixed key made every vault
 * paste over every other one in a client that holds several. A vault name
 * with no ASCII alphanumerics falls back to plain `obsidian`.
 *
 * Codex keeps its own merged form (`codexServerId`): its vault-named
 * entries exist only for settings older than the route id, and renaming
 * them would orphan the entry already in `config.toml` (ADR-0021).
 */
export function vaultServerId(vaultName: string): string {
  const words = vaultNameWords(vaultName);
  return words.length > 0 ? `obsidian_${words.join("_")}` : "obsidian";
}

// ---------------------------------------------------------------------------
// Wrapper helper
// ---------------------------------------------------------------------------

/**
 * Wrap an inner entry under `mcpServers.<serverId>` to produce a
 * ready-to-paste block. Used by the Settings UI Copy buttons so the
 * user pastes a complete JSON object straight into their client
 * config file.
 */
export function wrapInMcpServers<T>(
  entry: T,
  serverId: string,
): { mcpServers: Record<string, T> } {
  return {
    mcpServers: {
      [serverId]: entry,
    },
  };
}
