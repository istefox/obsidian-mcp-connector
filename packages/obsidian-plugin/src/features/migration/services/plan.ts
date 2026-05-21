import fsp from "fs/promises";
import { logger } from "$/shared/logger";
import { updateClaudeDesktopConfig } from "$/features/mcp-client-config";
import type { LegacyInstallState } from "./detect";

/**
 * Migration plan + executor.
 *
 * `planMigration(ctx)` inspects the detected legacy state (T1) and
 * returns the list of opt-in `MigrationStep`s that the modal should
 * present. Each step is independent: a failure in one does not abort
 * the others. The user picks which steps to run; the modal calls
 * `executeSteps()` with the selected ids.
 *
 * The three concrete steps:
 *
 *  1. **rewriteClaudeConfig** — invokes the new
 *     `updateClaudeDesktopConfig` (T3) so Claude Desktop points at
 *     the in-process HTTP endpoint via `npx mcp-remote`. Backs up
 *     the prior file to `.backup`. Removes the legacy plugin
 *     config key.
 *  2. **deleteLegacyBinary** — `fs.rm` on the orphan
 *     `mcp-server`(`.exe`). Idempotent (force).
 *  3. **pruneLegacySettings** — atomically loads `data.json`,
 *     deletes `installLocation` and `platformOverride`, saves.
 *     Caller passes a `mutatePluginData` function so this module
 *     does not need to know about Obsidian's `Plugin` type.
 *
 * The "suggest Local REST API uninstall" item from the design lives
 * in the modal copy, not here — there is nothing for code to do
 * beyond surfacing the recommendation in the UI.
 */

export type MigrationStepId =
  | "rewriteClaudeConfig"
  | "deleteLegacyBinary"
  | "pruneLegacySettings";

export type MigrationStepResult = { ok: true } | { ok: false; error: string };

export type MigrationStep = {
  id: MigrationStepId;
  title: string;
  description: string;
  /** Whether the modal should pre-check this option. */
  defaultEnabled: boolean;
  /** Idempotent. Safe to invoke even if the underlying state changed. */
  apply: () => Promise<MigrationStepResult>;
};

export type MutatePluginData = (
  mutator: (data: Record<string, unknown>) => void,
) => Promise<void>;

export type MigrationContext = {
  state: LegacyInstallState;
  /** Live MCP transport port (drives the new Claude config payload). */
  port: number;
  /** Live MCP bearer token (drives the new Claude config payload). */
  token: string;
  /**
   * Optional plugin id override forwarded to
   * `updateClaudeDesktopConfig`. Defaults to
   * `mcp-tools-istefox`. Tests pass a fixture id.
   */
  pluginId?: string;
  /**
   * Atomic load → mutate → save against `plugin.loadData()`. The
   * caller supplies the function so this module stays free of any
   * direct Obsidian Plugin reference. In production it wraps the
   * existing `settingsLock` mutex used elsewhere in the plugin.
   */
  mutatePluginData: MutatePluginData;
};

/**
 * Build the list of applicable steps for the detected state. Returns
 * an empty array when nothing needs migrating — the modal should not
 * be shown.
 */
export function planMigration(ctx: MigrationContext): MigrationStep[] {
  const steps: MigrationStep[] = [];

  if (ctx.state.hasLegacyClaudeConfigEntry) {
    steps.push({
      id: "rewriteClaudeConfig",
      title: "Update Claude Desktop config",
      description:
        "Rewrite the MCP entry to use the new HTTP endpoint via npx mcp-remote. " +
        "A backup of the current config is saved alongside it (.backup).",
      defaultEnabled: true,
      apply: () => applyRewriteClaudeConfig(ctx),
    });
  }

  if (ctx.state.hasLegacyBinary && ctx.state.legacyBinaryPath) {
    steps.push({
      id: "deleteLegacyBinary",
      title: "Delete the old MCP server binary",
      description: `Remove ${ctx.state.legacyBinaryPath}. The 0.4.0 plugin runs the MCP server in-process; the binary is no longer needed.`,
      defaultEnabled: true,
      apply: () => applyDeleteLegacyBinary(ctx.state.legacyBinaryPath ?? ""),
    });
  }

  if (ctx.state.hasLegacySettingsKeys) {
    steps.push({
      id: "pruneLegacySettings",
      title: "Clean up legacy plugin settings",
      description:
        "Remove the `installLocation` and `platformOverride` keys from the plugin data. " +
        "These were used by the 0.3.x installer and are no-ops in 0.4.0.",
      defaultEnabled: true,
      apply: () => applyPruneLegacySettings(ctx.mutatePluginData),
    });
  }

  return steps;
}

/**
 * Execute the steps the user selected (by id). Each step runs even if
 * a previous one failed — failures are accumulated and returned. The
 * caller's UI decides how to present them (typically: a per-step
 * success/error indicator next to the checkbox).
 */
export async function executeSteps(
  steps: MigrationStep[],
  selectedIds: MigrationStepId[],
): Promise<Array<{ id: MigrationStepId } & MigrationStepResult>> {
  const results: Array<{ id: MigrationStepId } & MigrationStepResult> = [];
  for (const step of steps) {
    if (!selectedIds.includes(step.id)) continue;
    try {
      const r = await step.apply();
      results.push({ id: step.id, ...r });
      if (r.ok) {
        logger.info("Migration step applied", { id: step.id });
      } else {
        logger.warn("Migration step failed", { id: step.id, error: r.error });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ id: step.id, ok: false, error });
      logger.error("Migration step threw", { id: step.id, error });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

async function applyRewriteClaudeConfig(
  ctx: MigrationContext,
): Promise<MigrationStepResult> {
  try {
    await updateClaudeDesktopConfig({
      port: ctx.port,
      token: ctx.token,
      ...(ctx.pluginId !== undefined ? { pluginId: ctx.pluginId } : {}),
      ...(ctx.state.legacyClaudeConfigPath !== undefined
        ? { configPath: ctx.state.legacyClaudeConfigPath }
        : {}),
      removeLegacyKey: true,
      backupBeforeWrite: true,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function applyDeleteLegacyBinary(
  binaryPath: string,
): Promise<MigrationStepResult> {
  if (!binaryPath) {
    return { ok: false, error: "No legacy binary path recorded." };
  }
  try {
    await fsp.rm(binaryPath, { force: true });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function applyPruneLegacySettings(
  mutate: MutatePluginData,
): Promise<MigrationStepResult> {
  try {
    await mutate((data) => {
      delete data.installLocation;
      delete data.platformOverride;
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
