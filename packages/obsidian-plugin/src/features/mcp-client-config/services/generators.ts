import { type } from "arktype";
import { FORK_PLUGIN_ID } from "./claudeDesktop";

/**
 * Pure generators for the MCP client families the plugin targets. The
 * JSON ones return the inner `mcpServers` entry only — the UI calls
 * `wrapInMcpServers()` if it wants the full ready-to-paste block.
 *
 * Why these shapes:
 *
 *  1. **Claude Desktop** — the legacy manual path bridges through the
 *     `mcp-remote` stdio shim invoked via `npx`. The supported path is
 *     the `.mcpb` export (`mcpbGenerator.ts`), which does not use this.
 *  2. **Claude Code CLI** — supports HTTP MCP transports natively as
 *     `{ type: "http", url, headers }`. Its docs route configuration
 *     through `claude mcp add` (the CLI owns `~/.claude.json`), so the
 *     Settings UI copies that command; the JSON entry is what goes into
 *     a project's `.mcp.json`.
 *  3. **Streamable-HTTP clients** (Cursor, Continue, Windsurf, VS Code)
 *     — use `{ type: "streamable-http", url, headers }`.
 *  4. **Cline** — same fields, but its config reader wants
 *     `type: "streamableHttp"` and treats a missing type as legacy SSE
 *     (docs.cline.bot/mcp/configuring-mcp-servers, checked 2026-10-02).
 *
 * No side effects, no I/O. The Settings UI calls these to populate the
 * "Copy" buttons; the test harness compares structural output.
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

/** Name of the environment variable the token-free Claude Code entry reads. */
export const CLAUDE_CODE_TOKEN_ENV_VAR = "OBSIDIAN_MCP_TOKEN";

/**
 * Claude Code entry for a project `.mcp.json` that is safe to commit: the
 * token is a `${VAR}` reference Claude Code expands from the environment, so
 * the secret never lands in a file in the repository. Needs
 * `OBSIDIAN_MCP_TOKEN` exported where Claude Code starts, and a project
 * `.mcp.json` asks for approval the first time Claude Code loads it.
 */
export function claudeCodeEnvConfig(input: { url: string }): ClaudeCodeEntry {
  return {
    type: "http",
    url: input.url,
    headers: { Authorization: `Bearer \${${CLAUDE_CODE_TOKEN_ENV_VAR}}` },
  };
}

/** Where `claude mcp add` stores the entry (code.claude.com/docs/en/mcp). */
export type ClaudeCodeScope = "user" | "project" | "local";

/**
 * The `claude mcp add` one-liner for this token. This is the documented
 * way to register a server: `user` and `local` scope live in
 * `~/.claude.json`, which the CLI owns, and `project` scope writes
 * `.mcp.json` at the repository root. Default `user`, so the vault is
 * reachable from every project.
 *
 * Double-quoted for both POSIX shells and PowerShell; the characters
 * that stay special inside double quotes are escaped.
 */
export function claudeCodeAddCommand(
  input: ClientConfigInput,
  scope: ClaudeCodeScope = "user",
): string {
  const id = input.pluginId ?? FORK_PLUGIN_ID;
  return [
    "claude mcp add --transport http --scope",
    scope,
    id,
    input.url,
    "--header",
    shellDoubleQuote(`Authorization: Bearer ${input.token}`),
  ].join(" ");
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
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
// Cline — same transport, camelCase type
// ---------------------------------------------------------------------------

export type ClineEntry = {
  type: "streamableHttp";
  url: string;
  headers: { Authorization: string };
};

/**
 * Cline's `cline_mcp_settings.json` entry. Cline reads `type:
 * "streamableHttp"`; given `"streamable-http"` or no type at all it falls
 * back to legacy SSE, which this server answers 405 on GET.
 */
export function clineConfig(input: ClientConfigInput): ClineEntry {
  return {
    type: "streamableHttp",
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
 * Short stable suffix for a vault name whose ASCII words do not identify it:
 * the name is empty of ASCII alphanumerics ("日記") or lost characters on the
 * way ("Società" and "Societ" both give `societ`). Null for a name the words
 * carry fully, so those ids keep their plain form.
 */
export function vaultNameDisambiguator(vaultName: string): string | null {
  const lossy = /[^\x00-\x7f]/.test(vaultName);
  if (!lossy) return null;
  // FNV-1a over UTF-16 code units: sync, dependency-free, stable across
  // platforms. A collision would need two lossy names to collide on 32 bits.
  let hash = 0x811c9dc5;
  for (let i = 0; i < vaultName.length; i++) {
    hash ^= vaultName.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(-6);
}

/**
 * The client-config key for this vault: `obsidian_<vault>`, words joined
 * by `_`, so "My Vault" is `obsidian_my_vault`. A fixed key made every vault
 * paste over every other one in a client that holds several. A name with
 * non-ASCII characters gets a short hash appended (`obsidian_societ_1a2b3c`,
 * `obsidian_1a2b3c` for "日記"), so two such vaults never share a key.
 *
 * Codex uses the same normalization and retains its saved name across renames.
 */
export function vaultServerId(vaultName: string): string {
  const parts = [...vaultNameWords(vaultName)];
  const tag = vaultNameDisambiguator(vaultName);
  if (tag) parts.push(tag);
  return parts.length > 0 ? `obsidian_${parts.join("_")}` : "obsidian";
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
