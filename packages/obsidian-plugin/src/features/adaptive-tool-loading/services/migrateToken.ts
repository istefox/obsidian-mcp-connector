/**
 * Migrating an existing token to `adaptive`, and reverting it (ADR-0025
 * D5–D7, R-03, R-04, R-05).
 *
 * Plain functions over `PluginDataLike`, no `obsidian` import (ADR-0025
 * D9): the Notice is the settings component's job, these are testable
 * against a fixture `data.json` with no Obsidian `App` in sight.
 *
 * Neither function contains mirror-specific code. `updateToolLoading`
 * already recomputes `toolLoading.profile`/`promoted` from
 * `profiles[ctx.mirrorId]` at the end of every recipe (ADR-0014 §7), so
 * a migration or revert that writes `profiles[tokenId]` is mirrored by
 * the same code that mirrors a profile radio click when `tokenId` is
 * the mirror token, and left alone by that same code otherwise. Adding
 * an `isMirror` branch here would not fix anything — it would just be a
 * second writer racing the one that already works (ADR-0025 D6).
 */

import type { PluginDataLike } from "$/shared/types";
import {
  defaultPolicy,
  newTokenPolicy,
  updateToolLoading,
} from "../tokenPolicyStore";
import { planMigration } from "./planMigration";

/**
 * Set `profiles[tokenId].profile = "adaptive"` and seed `promoted` from
 * the union of its existing promotions and everything it has ever
 * called (`planMigration`'s `promotedAfter`). `allowed` is untouched —
 * a ceiling is not a profile (ADR-0014 §4).
 *
 * A token with no existing entry is materialised from
 * {@link newTokenPolicy}, not `defaultPolicy()`, so creating the entry
 * cannot itself widen the surface the migration is meant to narrow
 * (ADR-0025 D5).
 *
 * Returns the `deactivated` list from the same `planMigration` call
 * that computed the seed — one computation for the preview and the
 * effect (ADR-0025 D8), so the settings component can announce exactly
 * what changed without a second pass.
 */
export async function migrateTokenToAdaptive(
  plugin: PluginDataLike,
  tokenId: string,
  allNames: string[],
): Promise<string[]> {
  let deactivated: string[] = [];
  await updateToolLoading(plugin, (state) => {
    const policy = state.profiles[tokenId] ?? newTokenPolicy();
    const everCalled = state.everCalled[tokenId] ?? [];
    const plan = planMigration(allNames, policy, everCalled);
    deactivated = plan.deactivated;
    state.profiles[tokenId] = {
      ...policy,
      profile: "adaptive",
      promoted: plan.promotedAfter,
    };
    return state;
  });
  return deactivated;
}

/**
 * Set `profiles[tokenId].profile = "all"` and stop. `promoted` is left
 * as seeded — inert under `profile: "all"` (`getActiveToolNames` never
 * reads it there) — and `everCalled` is untouched by construction: it
 * lives outside `profiles`, so no policy write can reach it (ADR-0025
 * D7).
 */
export async function revertTokenToAll(
  plugin: PluginDataLike,
  tokenId: string,
): Promise<void> {
  await updateToolLoading(plugin, (state) => {
    const policy = state.profiles[tokenId] ?? defaultPolicy();
    state.profiles[tokenId] = { ...policy, profile: "all" };
    return state;
  });
}
