import { logger } from "$/shared/logger";
import type { PluginReadLike } from "$/shared/types";

/**
 * Apply the user-controlled `toolToggle.disabled` list to a freshly-
 * registered ToolRegistry.
 *
 * The `ToolRegistry` already separates registration from enablement
 * via its internal disable-state sets + `setUserDisabled(name, bool)`
 * API. This helper reads the user's preference from `data.json` and
 * flips each named tool to disabled. Once disabled, the tool no longer
 * appears in `tools/list` and any `tools/call` against it returns
 * MethodNotFound.
 *
 * Failure modes (non-fatal):
 *  - `data.json` missing → no slice → no-op
 *  - `toolToggle.disabled` not an array → log warning, no-op
 *  - List entry references an unknown tool name → recorded in
 *    `result.unknown`, surfaced to the caller for diagnostics. The
 *    server keeps running; the typo just doesn't filter anything.
 */

type RegistryLike = {
  setUserDisabled: (name: string, disabled: boolean) => boolean;
};

type PluginLike = PluginReadLike;

export type ApplyDisabledToolsFilterResult = {
  /** Tool names that were disabled. */
  disabled: string[];
  /** Names from the user list that did not match any registered tool. */
  unknown: string[];
};

export async function applyDisabledToolsFilter(
  registry: RegistryLike,
  plugin: PluginLike,
): Promise<ApplyDisabledToolsFilterResult> {
  let raw: unknown;
  try {
    raw = await plugin.loadData();
  } catch (err) {
    logger.warn("tool-toggle: loadData failed; skipping filter", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { disabled: [], unknown: [] };
  }

  if (!raw || typeof raw !== "object") {
    return { disabled: [], unknown: [] };
  }
  const slice = (raw as Record<string, unknown>).toolToggle as
    | { disabled?: unknown }
    | undefined;
  if (!slice || typeof slice !== "object") {
    return { disabled: [], unknown: [] };
  }
  const list = slice.disabled;
  if (!Array.isArray(list)) {
    if (list !== undefined) {
      logger.warn("tool-toggle: `disabled` is not an array; ignoring", {
        actual: typeof list,
      });
    }
    return { disabled: [], unknown: [] };
  }

  const disabled: string[] = [];
  const unknown: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name.length === 0) continue;
    if (registry.setUserDisabled(name, true)) {
      disabled.push(name);
    } else {
      unknown.push(name);
    }
  }

  if (disabled.length > 0) {
    logger.info("tool-toggle: filtered tools", { disabled });
  }
  if (unknown.length > 0) {
    logger.warn("tool-toggle: unknown tool names in disabled list", {
      unknown,
    });
  }

  return { disabled, unknown };
}
