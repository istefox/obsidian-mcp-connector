import type { PluginDataLike } from "$/shared/types";
import { SettingsStore } from "$/shared/settingsStore";
import { parseClaudeCodeProjectPath } from "./generators";

/**
 * The optional "Project path" setting, shared by Claude Code and Codex.
 * Set, the Claude Code copy button registers the vault at `local` scope
 * for that project instead of at `user` scope (see
 * `claudeCodeProjectAddCommand`), and the Codex menu can install into the
 * project's `.codex/config.toml` (see `locateCodexProject`, ADR-0028 D6).
 * The key and function names keep "claudeCode" for stored data.
 *
 * Persistence: `data.json` slice
 * `mcpClientConfig.claudeCodeProjectPath`, a trimmed absolute path or
 * `""`. A missing key is the same as `""`, so older data needs no
 * migration.
 */

const DATA_KEY = "mcpClientConfig";
const PATH_KEY = "claudeCodeProjectPath";

/**
 * The saved project path, or `""` for none. A value that is not a string
 * or fails validation (a hand-edited `data.json`) also reads as `""`, so
 * the button falls back to the user-scope command rather than copying a
 * command that could run part of the path.
 */
export async function getClaudeCodeProjectPath(
  plugin: PluginDataLike,
): Promise<string> {
  const slice = await new SettingsStore(plugin).readSlice(DATA_KEY);
  if (!slice || typeof slice !== "object") return "";
  const stored = (slice as Record<string, unknown>)[PATH_KEY];
  if (typeof stored !== "string") return "";
  const parsed = parseClaudeCodeProjectPath(stored);
  return parsed.ok ? parsed.path : "";
}

/**
 * Validate and save the project path. An invalid value changes nothing
 * and returns the error for the settings UI to show.
 */
export async function setClaudeCodeProjectPath(
  plugin: PluginDataLike,
  input: string,
): Promise<ReturnType<typeof parseClaudeCodeProjectPath>> {
  const parsed = parseClaudeCodeProjectPath(input);
  if (!parsed.ok) return parsed;
  await new SettingsStore(plugin).updateSlice(DATA_KEY, (current) => {
    const slice = (current as Record<string, unknown> | undefined) ?? {};
    return { ...slice, [PATH_KEY]: parsed.path };
  });
  return parsed;
}
