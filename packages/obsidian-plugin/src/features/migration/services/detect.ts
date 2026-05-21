import fsp from "fs/promises";
import os from "os";
import path from "path";
import { type } from "arktype";
import {
  BINARY_NAME,
  INSTALL_PATH,
  type Platform,
} from "$/features/migration/constants";
import {
  FORK_PLUGIN_ID,
  LEGACY_PLUGIN_ID,
} from "$/features/mcp-client-config/services/claudeDesktop";

/**
 * Detection of leftover 0.3.x state in a fresh-load 0.4.0 vault.
 *
 * The 0.3.x plugin shipped a native `mcp-server` binary, recorded
 * `installLocation` / `platformOverride` keys in `data.json`, and wrote
 * a `mcpServers` entry into `claude_desktop_config.json` whose
 * `command` was the absolute path to that binary. The 0.4.0 plugin
 * runs the MCP server in-process and rewrites the same Claude entry
 * to use `npx mcp-remote` against `http://127.0.0.1:<port>/mcp`.
 *
 * Three independent signals tell us a legacy install is still around.
 * Any one of them is enough for the migration modal to appear:
 *
 *  1. **Legacy settings keys** — `installLocation` or `platformOverride`
 *     in `data.json`. These keys are no-ops in 0.4.0 (the install
 *     feature only consumes them through the legacy code path), so
 *     leaving them does not break the plugin, but their presence is
 *     a strong signal the user upgraded from 0.3.x.
 *  2. **Legacy binary on disk** — `mcp-server`(`.exe` on Windows) at
 *     `INSTALL_PATH[platform]`. Orphan after the upgrade. Worth
 *     ~25-50 MB. Cleanup is opt-in in the modal.
 *  3. **Legacy `claude_desktop_config.json` entry** — the
 *     `mcp-tools-istefox` entry's `command` is anything other than
 *     `npx`, OR `args` does not contain `mcp-remote`. Either means
 *     Claude Desktop is still pointing at the now-missing binary and
 *     will fail at next launch unless rewritten.
 *
 * The detection is read-only: no file is modified, no process is
 * spawned. Safe to call on every plugin load.
 */

export const legacyInstallStateSchema = type({
  hasLegacySettingsKeys: "boolean",
  hasLegacyBinary: "boolean",
  "legacyBinaryPath?": "string",
  hasLegacyClaudeConfigEntry: "boolean",
  "legacyClaudeConfigPath?": "string",
  "legacyClaudeConfigEntryCommand?": "string",
}).describe("Result of detectLegacyInstall — drives the migration modal");

export type LegacyInstallState = typeof legacyInstallStateSchema.infer;

/**
 * Inputs for `detectLegacyInstall`. Kept narrow on purpose so the
 * function stays a pure(ish) probe of the local filesystem and the
 * already-loaded plugin data — no Obsidian app reference, no transport
 * state.
 */
export type DetectLegacyInstallInput = {
  /** Result of `plugin.loadData()`. Pass-through, no mutation. */
  pluginData: unknown;
  /**
   * Override the new (fork-aligned) plugin id used in
   * `claude_desktop_config.json`'s `mcpServers` map. Defaults to
   * `mcp-tools-istefox`. Override only for tests against fixture
   * configs.
   */
  pluginId?: string;
  /**
   * Override the legacy plugin id checked alongside the new id.
   * Defaults to `obsidian-mcp-tools` (the legacy key 0.3.x wrote into
   * `claude_desktop_config.json`). Override only in tests where the
   * legacy id differs.
   */
  legacyPluginId?: string;
  /**
   * Absolute path to `claude_desktop_config.json`. If undefined the
   * detector resolves it from the platform default.
   */
  claudeConfigPath?: string;
  /**
   * Override for the platform-specific binary install directory.
   * Tests pass a tmpdir here; production lets the function resolve
   * `INSTALL_PATH[platform]`.
   */
  binaryInstallDirOverride?: string;
};

export async function detectLegacyInstall(
  input: DetectLegacyInstallInput,
): Promise<LegacyInstallState> {
  const newPluginId = input.pluginId ?? FORK_PLUGIN_ID;
  const legacyPluginId = input.legacyPluginId ?? LEGACY_PLUGIN_ID;

  const hasLegacySettingsKeys = detectLegacySettingsKeys(input.pluginData);
  const binaryProbe = await probeLegacyBinary(input.binaryInstallDirOverride);
  const claudeProbe = await probeLegacyClaudeConfigEntry(
    newPluginId,
    legacyPluginId,
    input.claudeConfigPath,
  );

  return {
    hasLegacySettingsKeys,
    hasLegacyBinary: binaryProbe.exists,
    ...(binaryProbe.exists && binaryProbe.fullPath
      ? { legacyBinaryPath: binaryProbe.fullPath }
      : {}),
    hasLegacyClaudeConfigEntry: claudeProbe.isLegacy,
    ...(claudeProbe.configPath
      ? { legacyClaudeConfigPath: claudeProbe.configPath }
      : {}),
    ...(claudeProbe.entryCommand !== undefined
      ? { legacyClaudeConfigEntryCommand: claudeProbe.entryCommand }
      : {}),
  };
}

/**
 * Convenience helper: returns true if any of the three signals fired.
 * Drives the show/hide of the migration modal.
 */
export function hasAnyLegacySignal(state: LegacyInstallState): boolean {
  return (
    state.hasLegacySettingsKeys ||
    state.hasLegacyBinary ||
    state.hasLegacyClaudeConfigEntry
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function detectLegacySettingsKeys(pluginData: unknown): boolean {
  if (!pluginData || typeof pluginData !== "object") return false;
  const d = pluginData as Record<string, unknown>;
  return "installLocation" in d || "platformOverride" in d;
}

async function probeLegacyBinary(
  installDirOverride?: string,
): Promise<{ exists: boolean; fullPath?: string }> {
  const platform = currentPlatform();
  if (!platform) return { exists: false };

  const dir = installDirOverride ?? expandHomePath(INSTALL_PATH[platform]);
  const fullPath = path.join(dir, BINARY_NAME[platform]);

  try {
    const stat = await fsp.stat(fullPath);
    if (stat.isFile()) return { exists: true, fullPath };
    return { exists: false };
  } catch (err) {
    // ENOENT is the common case; any other error (EACCES, EIO …) we
    // treat as "no detectable legacy binary" — the migration modal is
    // an optional UX surface, not a security boundary.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    return { exists: false };
  }
}

type ClaudeProbeResult = {
  isLegacy: boolean;
  configPath?: string;
  entryCommand?: string;
};

async function probeLegacyClaudeConfigEntry(
  newPluginId: string,
  legacyPluginId: string,
  configPathOverride?: string,
): Promise<ClaudeProbeResult> {
  const configPath = configPathOverride ?? defaultClaudeConfigPath();
  if (!configPath) return { isLegacy: false };

  let raw: string;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch {
    // Missing config file → user has never configured Claude Desktop
    // OR they only use HTTP-native clients (Claude Code, Cursor …).
    // No legacy entry to migrate.
    return { isLegacy: false, configPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed config — leave it alone. Migration requires a
    // confidently-parsed file; a corrupt one needs human attention.
    return { isLegacy: false, configPath };
  }

  if (!parsed || typeof parsed !== "object") {
    return { isLegacy: false, configPath };
  }
  const cfg = parsed as Record<string, unknown>;
  const servers = cfg.mcpServers;
  if (!servers || typeof servers !== "object") {
    return { isLegacy: false, configPath };
  }
  const map = servers as Record<string, unknown>;

  // Two cases of "legacy" we care about:
  //   (a) Entry under `legacyPluginId` (`obsidian-mcp-tools` legacy
  //       key) exists at all. Even with a 0.4.0-shaped `npx mcp-remote`
  //       payload, the key needs to migrate to `newPluginId` so the
  //       fork's plugin id matches the manifest.
  //   (b) Entry under `newPluginId` exists with a non-0.4.0 shape
  //       (i.e. command !== "npx" OR args missing "mcp-remote").
  //       Means the plugin id was right but the payload is stale.

  const legacyEntry =
    legacyPluginId !== newPluginId
      ? (map[legacyPluginId] as Record<string, unknown> | undefined)
      : undefined;
  if (legacyEntry && typeof legacyEntry === "object") {
    const command =
      typeof legacyEntry.command === "string" ? legacyEntry.command : "";
    return { isLegacy: true, configPath, entryCommand: command || undefined };
  }

  const newEntry = map[newPluginId] as Record<string, unknown> | undefined;
  if (!newEntry || typeof newEntry !== "object") {
    return { isLegacy: false, configPath };
  }

  const command = typeof newEntry.command === "string" ? newEntry.command : "";
  const args = Array.isArray(newEntry.args) ? (newEntry.args as unknown[]) : [];

  // 0.4.0 shape: command="npx", args contains the literal "mcp-remote".
  const usesNpx = command === "npx";
  const usesMcpRemote = args.some(
    (a) => typeof a === "string" && a === "mcp-remote",
  );
  const isLegacy = !(usesNpx && usesMcpRemote);

  return {
    isLegacy,
    configPath,
    entryCommand: command || undefined,
  };
}

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

/**
 * Expands `~` and `%VAR%` placeholders in a path template.
 * Defined locally so this detection module stays light.
 */
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

function defaultClaudeConfigPath(): string | undefined {
  const platform = currentPlatform();
  if (!platform) return undefined;
  const map = {
    macos: "~/Library/Application Support/Claude/claude_desktop_config.json",
    windows: "%APPDATA%\\Claude\\claude_desktop_config.json",
    linux: "~/.config/Claude/claude_desktop_config.json",
  } as const;
  return expandHomePath(map[platform]);
}
