import { logger } from "$/shared/logger";
import type { PluginDataLike } from "$/shared/types";
import { SettingsStore } from "$/shared/settingsStore";
import { updateClaudeDesktopConfig } from "./claudeDesktop";

/**
 * Auto-write Claude Desktop config glue.
 *
 * The Settings UI exposes an opt-in toggle (default OFF)
 * that, when ON, automatically rewrites `claude_desktop_config.json`
 * whenever the bearer token rotates or the HTTP server's port changes.
 * This module owns the read/write of that flag and the one-shot sync
 * action invoked by callers.
 *
 * The flag lives at `mcpClientConfig.autoWriteClaudeDesktopConfig` in
 * `data.json`. Default is `false` — a "config rewrite" is a touch on
 * a user-managed file outside the vault, so we do not perform it
 * without explicit consent.
 *
 * Why this is a separate module rather than inline in
 * `AccessControlSection.svelte`: it lets the regenerate flow in
 * `mcp-transport` and the migration executor in `migration` share a
 * single sync entry point, and it keeps the persistence shape testable
 * without a Svelte runtime.
 */

const DATA_KEY = "mcpClientConfig";
const FLAG_KEY = "autoWriteClaudeDesktopConfig";

type PluginLike = PluginDataLike & {
  mcpTransportState?:
    | {
        bearerToken: string;
        server: { port: number };
      }
    | undefined;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Read the flag from `data.json`. Returns false on any of:
 *  - Missing `data.json` content (fresh install).
 *  - Missing `mcpClientConfig` slice.
 *  - Flag explicitly set to false.
 *  - Flag missing or non-boolean.
 *
 * Coerces unexpected shapes to false. The auto-write feature is
 * fail-safe: a corrupt or unexpected setting state should NOT
 * surprise-write to user files.
 */
export async function getAutoWriteEnabled(
  plugin: PluginLike,
): Promise<boolean> {
  try {
    const slice = await new SettingsStore(plugin).readSlice(DATA_KEY);
    if (!slice || typeof slice !== "object") return false;
    const flag = (slice as Record<string, unknown>)[FLAG_KEY];
    return flag === true;
  } catch (err) {
    logger.warn("autoWrite: getAutoWriteEnabled failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Persist the flag. `SettingsStore.updateSlice` mutates only the
 * `mcpClientConfig.autoWriteClaudeDesktopConfig` field under the shared
 * settings mutex, preserving every other key, so this write cannot
 * clobber a concurrent settings write from another feature (data.json
 * is not atomic).
 */
export async function setAutoWriteEnabled(
  plugin: PluginLike,
  enabled: boolean,
): Promise<void> {
  await new SettingsStore(plugin).updateSlice(DATA_KEY, (current) => {
    const slice = (current as Record<string, unknown> | undefined) ?? {};
    return { ...slice, [FLAG_KEY]: enabled };
  });
}

// ---------------------------------------------------------------------------
// One-shot sync
// ---------------------------------------------------------------------------

export type ApplyAutoWriteResult =
  | { applied: true }
  | { applied: false; reason: "disabled" | "transport-offline" }
  | { applied: false; reason: "error"; error: string };

/**
 * If the auto-write flag is ON AND the HTTP transport is up, rewrite
 * the Claude Desktop config to match the live port and token. No-op
 * (with a structured reason) otherwise.
 *
 * Caller responsibilities:
 *  - The bearer-token rotation flow must call this AFTER the new
 *    transport state is in place, so the live `port` + `token` reflect
 *    the just-saved values.
 *  - The migration flow does NOT use this — it calls
 *    `updateClaudeDesktopConfig` directly through the executor (T2).
 *
 * Returns a structured result so the UI can decide whether to show a
 * toast (e.g. "Config rewritten." vs. "Auto-write is OFF.").
 */
export async function applyAutoWrite(
  plugin: PluginLike,
): Promise<ApplyAutoWriteResult> {
  const enabled = await getAutoWriteEnabled(plugin);
  if (!enabled) return { applied: false, reason: "disabled" };

  const state = plugin.mcpTransportState;
  if (!state) return { applied: false, reason: "transport-offline" };

  try {
    await updateClaudeDesktopConfig({
      port: state.server.port,
      token: state.bearerToken,
    });
    return { applied: true };
  } catch (err) {
    return {
      applied: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
