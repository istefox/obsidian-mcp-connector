import fsp from "fs/promises";
import os from "os";
import path from "path";
import { type } from "arktype";
import { logger } from "$/shared/logger";

/**
 * Claude Desktop config writer for the 0.4.0 HTTP-embedded plugin.
 *
 * In 0.3.x the plugin shipped a binary and wrote a `mcpServers` entry
 * whose `command` was the absolute path to that binary, with the
 * Local REST API key in `env`. In 0.4.0 the plugin is the server,
 * so the entry pivots to `npx mcp-remote` against the in-process
 * HTTP endpoint with a Bearer token.
 *
 * Why `mcp-remote`? Claude Desktop does not yet support direct HTTP
 * MCP transports (anthropics/claude-code#30327). `mcp-remote` is a
 * tiny stdio-shim from the official MCP team that translates the
 * stdio flow Claude Desktop expects into HTTP requests against an
 * MCP endpoint. It runs on demand via `npx`, no install step.
 *
 * Key compatibility: 0.3.x wrote the entry under the legacy key
 * `"obsidian-mcp-tools"`. 0.4.0 writes under `"mcp-tools-istefox"`
 * and, when migrating, removes the legacy key.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Plugin id used in 0.4.0 `mcpServers` map (matches manifest.json). */
export const FORK_PLUGIN_ID = "mcp-tools-istefox";

/** Plugin id used by 0.3.x (the legacy config key, kept for migration). */
export const LEGACY_PLUGIN_ID = "obsidian-mcp-tools";

const CLAUDE_CONFIG_PATH_TEMPLATES = {
  macos: "~/Library/Application Support/Claude/claude_desktop_config.json",
  windows: "%APPDATA%\\Claude\\claude_desktop_config.json",
  linux: "~/.config/Claude/claude_desktop_config.json",
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const updateClaudeDesktopConfigInputSchema = type({
  /** Bearer token written into the Authorization header literal. */
  token: "string > 0",
  /** Local port of the in-process MCP HTTP server (e.g. 27200). */
  port: "number.integer > 0",
  /** Override pluginId. Defaults to FORK_PLUGIN_ID. */
  "pluginId?": "string",
  /** Override config path. Defaults to platform default. */
  "configPath?": "string",
  /** When true, also delete the LEGACY_PLUGIN_ID entry. Default true. */
  "removeLegacyKey?": "boolean",
  /**
   * When true, write `<configPath>.backup` with the pre-rewrite content
   * before mutating. Default true. Skipped if the config did not exist
   * (nothing to back up).
   */
  "backupBeforeWrite?": "boolean",
}).describe("Inputs for updateClaudeDesktopConfig");

export type UpdateClaudeDesktopConfigInput =
  typeof updateClaudeDesktopConfigInputSchema.infer;

/**
 * Rewrite the plugin's entry in `claude_desktop_config.json` to the
 * 0.4.0 HTTP shape. Idempotent: rerunning with the same inputs
 * produces a stable file. Other `mcpServers` entries are preserved
 * byte-for-byte (except for whitespace re-formatting from the JSON
 * stringify).
 *
 * Throws on:
 *  - Malformed JSON in the existing config (refuse to overwrite a
 *    file we cannot confidently parse — preserves user data).
 *  - Filesystem write errors (EACCES, ENOSPC, …).
 *
 * Does NOT throw on:
 *  - Missing config file: a new file is created with just our entry.
 */
export async function updateClaudeDesktopConfig(
  input: UpdateClaudeDesktopConfigInput,
): Promise<void> {
  const pluginId = input.pluginId ?? FORK_PLUGIN_ID;
  const configPath = input.configPath ?? defaultClaudeDesktopConfigPath();
  if (!configPath) {
    throw new Error(
      "Cannot resolve Claude Desktop config path on this platform.",
    );
  }
  const removeLegacyKey = input.removeLegacyKey ?? true;
  const backupBeforeWrite = input.backupBeforeWrite ?? true;

  await fsp.mkdir(path.dirname(configPath), { recursive: true });

  // Load the existing file if present.
  let raw: string | null = null;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const servers = obj.mcpServers;
        config = {
          ...obj,
          mcpServers:
            servers && typeof servers === "object"
              ? { ...(servers as Record<string, unknown>) }
              : {},
        } as typeof config;
      }
    } catch (err) {
      throw new Error(
        `Refusing to overwrite malformed JSON at ${configPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (backupBeforeWrite) {
      try {
        await fsp.writeFile(`${configPath}.backup`, raw, "utf8");
      } catch (backupErr) {
        // Backup failure is logged but not fatal — the user's primary
        // file is still readable. We surface the warning so a future
        // diagnostic can correlate.
        logger.warn("Claude Desktop config backup failed", {
          configPath: `${configPath}.backup`,
          error:
            backupErr instanceof Error ? backupErr.message : String(backupErr),
        });
      }
    }
  }

  // Optionally drop the legacy entry. Skipped if the legacy key equals
  // the new pluginId (e.g. tests using the legacy id directly).
  if (removeLegacyKey && pluginId !== LEGACY_PLUGIN_ID) {
    delete (config.mcpServers as Record<string, unknown>)[LEGACY_PLUGIN_ID];
  }

  // Write the new entry.
  config.mcpServers[pluginId] = buildHttpEntry(input.port, input.token);

  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  logger.info("Claude Desktop config updated", {
    configPath,
    pluginId,
    legacyKeyRemoved: removeLegacyKey && pluginId !== LEGACY_PLUGIN_ID,
  });
}

/**
 * Remove BOTH the new and legacy plugin entries from the Claude
 * Desktop config. Used by the uninstall flow and by the migration
 * "skip" path if the user wants to disable Claude Desktop integration.
 *
 * Other `mcpServers` entries are preserved.
 */
export async function removeFromClaudeDesktopConfig(opts?: {
  configPath?: string;
}): Promise<void> {
  const configPath = opts?.configPath ?? defaultClaudeDesktopConfigPath();
  if (!configPath) return;

  let raw: string;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Don't touch malformed configs.
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;
  const servers = obj.mcpServers;
  if (!servers || typeof servers !== "object") return;
  const map = servers as Record<string, unknown>;

  let changed = false;
  if (FORK_PLUGIN_ID in map) {
    delete map[FORK_PLUGIN_ID];
    changed = true;
  }
  if (LEGACY_PLUGIN_ID in map) {
    delete map[LEGACY_PLUGIN_ID];
    changed = true;
  }

  if (changed) {
    await fsp.writeFile(configPath, JSON.stringify(obj, null, 2), "utf8");
    logger.info("Claude Desktop config: removed plugin entries", {
      configPath,
    });
  }
}

export function defaultClaudeDesktopConfigPath(): string | undefined {
  const platform = currentPlatform();
  if (!platform) return undefined;
  return expandHomePath(CLAUDE_CONFIG_PATH_TEMPLATES[platform]);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildHttpEntry(
  port: number,
  token: string,
): {
  command: string;
  args: string[];
} {
  return {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      `http://127.0.0.1:${port}/mcp`,
      "--header",
      `Authorization: Bearer ${token}`,
    ],
  };
}

type Platform = "macos" | "windows" | "linux";

function currentPlatform(): Platform | null {
  switch (os.platform()) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return null;
  }
}

function expandHomePath(template: string): string {
  let expanded = template;
  if (expanded.startsWith("~")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  expanded = expanded.replace(
    /%([^%]+)%/g,
    (_, name) => process.env[name] || "",
  );
  return expanded;
}
