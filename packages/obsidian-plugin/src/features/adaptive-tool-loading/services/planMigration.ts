/**
 * The single computation shared by the migration preview and the
 * migration itself (ADR-0025 D8, R-03, R-08).
 *
 * `deactivated` is derived by calling {@link resolveToolScope} twice —
 * once with the token's current policy, once with the policy it would
 * have after migrating — and taking the set difference. No second
 * implementation of "what a profile contains": that copy is exactly
 * what made `tool_catalog` drift from `dispatch` before ADR-0014 §9
 * exported `isActiveFor`.
 */

import { resolveToolScope } from "../resolveToolScope";
import type { TokenPolicy } from "../tokenPolicyStore";

export type MigrationPlan = {
  /** First-seen union of the token's existing `promoted` and `everCalled`. */
  promotedAfter: string[];
  /** Tools active under `policy` and inactive after migrating to `adaptive`. */
  deactivated: string[];
};

const PREVIEW_TOKEN_ID = "migration-preview";

/**
 * Pure: no settings read, no write. `allNames` MUST be the registry's
 * served names only (`listAll()` filtered on `enabled`), so a
 * user-disabled tool is never advertised as something the migration
 * will deactivate (ADR-0010) — that filtering is the caller's job, not
 * this function's.
 */
export function planMigration(
  allNames: string[],
  policy: TokenPolicy,
  everCalled: string[],
): MigrationPlan {
  const promotedAfter = [...new Set([...policy.promoted, ...everCalled])];

  const current = resolveToolScope(
    PREVIEW_TOKEN_ID,
    policy,
    allNames,
    new Set(),
  ).active;
  const migrated = resolveToolScope(
    PREVIEW_TOKEN_ID,
    { ...policy, profile: "adaptive", promoted: promotedAfter },
    allNames,
    new Set(),
  ).active;

  const deactivated = allNames.filter(
    (name) => current.has(name) && !migrated.has(name),
  );

  return { promotedAfter, deactivated };
}
