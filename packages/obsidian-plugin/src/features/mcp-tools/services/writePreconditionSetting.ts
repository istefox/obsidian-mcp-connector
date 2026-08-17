/**
 * Reads the vault's write-precondition policy for the two patch tools
 * (ADR-0019).
 *
 * Shared rather than duplicated per tool: `patch_vault_file` and
 * `patch_active_file` forward the same `PatchArgs` into the same `applyPatch`,
 * so a policy that differed between them would be a bug waiting to be found by
 * whichever one a client happened to use.
 *
 * Async on purpose, and read by the HANDLER rather than by `applyPatch`: the
 * comparison it enables happens inside `vault.process`, whose callback must
 * stay synchronous.
 */
import { SettingsStore } from "$/shared/settingsStore";
import type McpToolsPlugin from "$/main";
import { DEFAULT_REQUIRE_WRITE_PRECONDITIONS } from "../types";

/**
 * Whether `operation: "replace"` must carry `expectedContent`.
 *
 * Falls back to the default (off) when `plugin` is absent — partial test
 * fixtures pass no plugin, exactly as `get_vault_file`'s ceiling resolver
 * does, and off is the behaviour every existing client already relies on.
 */
export async function resolveRequireWritePreconditions(
  plugin?: McpToolsPlugin,
): Promise<boolean> {
  if (!plugin) return DEFAULT_REQUIRE_WRITE_PRECONDITIONS;
  const slice = (await new SettingsStore(plugin).readSlice("mcpTools")) as
    | { requireWritePreconditions?: boolean }
    | undefined;
  return (
    slice?.requireWritePreconditions ?? DEFAULT_REQUIRE_WRITE_PRECONDITIONS
  );
}
