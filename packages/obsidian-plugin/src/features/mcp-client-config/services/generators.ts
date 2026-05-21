import { type } from "arktype";
import { FORK_PLUGIN_ID } from "./claudeDesktop";

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

export function claudeDesktopConfig(
  input: ClientConfigInput,
): ClaudeDesktopEntry {
  return {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      input.url,
      "--header",
      `Authorization: Bearer ${input.token}`,
    ],
  };
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
// Wrapper helper
// ---------------------------------------------------------------------------

/**
 * Wrap an inner entry under `mcpServers.<pluginId>` to produce a
 * ready-to-paste block. Used by the Settings UI Copy buttons so the
 * user pastes a complete JSON object straight into their client
 * config file.
 */
export function wrapInMcpServers<T>(
  entry: T,
  pluginId: string = FORK_PLUGIN_ID,
): { mcpServers: Record<string, T> } {
  return {
    mcpServers: {
      [pluginId]: entry,
    },
  };
}
