/**
 * The eligibility anchor and countdown for migrating an existing token to
 * `adaptive` (ADR-0025 D3, D4).
 *
 * One vault-wide anchor (`toolLoading.everCalledSince`, written once by
 * {@link ensureEverCalledTracking}) plus each token's existing
 * `createdAt`; no per-token timestamp is stored. A token's effective
 * observation start is derived, never stored:
 *
 *   anchor(token) = max(everCalledSince, token.createdAt)
 */

import type { PluginDataLike } from "$/shared/types";
import { MIGRATION_OBSERVATION_DAYS } from "../constants";
import { updateToolLoading } from "../tokenPolicyStore";

const DAY_MS = 24 * 60 * 60 * 1000;

export type MigrationEligibility = {
  eligible: boolean;
  /** Rounded up, never negative — what the countdown renders. */
  daysRemaining: number;
};

/**
 * Pure eligibility check. `createdAt` of `0` (a malformed record) falls
 * back to `everCalledSince` via `max`, which is the correct fallback
 * (ADR-0025 D3).
 */
export function migrationEligibility(
  now: number,
  everCalledSince: number,
  createdAt: number,
): MigrationEligibility {
  const anchor = Math.max(everCalledSince, createdAt);
  const windowMs = MIGRATION_OBSERVATION_DAYS * DAY_MS;
  const elapsedMs = now - anchor;
  const eligible = elapsedMs >= windowMs;
  const daysRemaining = Math.max(0, Math.ceil((windowMs - elapsedMs) / DAY_MS));
  return { eligible, daysRemaining };
}

/**
 * Write the vault-wide `everCalledSince` anchor once, idempotently.
 * Called from `mcp-transport/services/setup.ts` immediately after
 * `ensureTokenStore` (ADR-0025 D3) — NOT from inside `ensureTokenStore`
 * itself, which has a different owner and whose own save-count tests
 * must stay green regardless of this feature.
 *
 * Present ⇒ NO_CHANGE. Toggling a token's profile never moves this
 * anchor: it is written once and never touched again by any other
 * recipe.
 */
export async function ensureEverCalledTracking(
  plugin: PluginDataLike,
): Promise<void> {
  await updateToolLoading(plugin, (state) => {
    if (typeof state.everCalledSince === "number") return state;
    state.everCalledSince = Date.now();
    return state;
  });
}
