import type { ToolScope } from "$/shared/types";
import { ALWAYS_ACTIVE_TOOLS } from "./constants";
import { ToolLoadingManager } from "./toolLoadingManager";
import type { TokenPolicy } from "./tokenPolicyStore";

/**
 * Profile expansion is the already-tested `getActiveToolNames`; this
 * manager instance exists only to reach it. It holds no per-call state
 * (its constructor options only affect the counter debounce), so one
 * module-level instance is safe.
 */
const profileExpander = new ToolLoadingManager();

/**
 * Resolve one caller's tool surface: pure in (policy, registered names,
 * session promotions), with no settings read and no registry mutation.
 *
 * `userDisabled` is deliberately NOT consulted. The registry re-applies
 * it in `list()` and `dispatch()`, so a user-disabled tool is
 * structurally invisible to every scope without this layer having to
 * remember to check — the ADR-0010 kill switch stays the outermost
 * layer by construction.
 *
 * Args:
 *   tokenId: The caller's opaque policy key, carried through to `ToolScope.id`.
 *   policy: That token's stored policy.
 *   allNames: Every registered tool name.
 *   session: Names promoted in-session for this token (`persist: false`).
 *
 * Returns:
 *   The caller's ToolScope.
 */
export function resolveToolScope(
  tokenId: string,
  policy: TokenPolicy,
  allNames: readonly string[],
  session: ReadonlySet<string> = new Set(),
): ToolScope {
  const active = profileExpander.getActiveToolNames([...allNames], {
    profile: policy.profile,
    promoted: [...policy.promoted, ...session],
  });

  const allowed = policy.allowed === null ? null : new Set(policy.allowed);
  if (allowed) {
    for (const name of [...active]) {
      // Meta-tools bypass the ceiling by construction: a token locked
      // out of `activate_tool` could never widen its own surface, which
      // is the circular dead end ALWAYS_ACTIVE_TOOLS exists to prevent,
      // one layer up. An `allowed` entry naming a tool that no longer
      // exists is simply never matched — the same tolerance `promoted`
      // already has.
      if (!allowed.has(name) && !ALWAYS_ACTIVE_TOOLS.includes(name)) {
        active.delete(name);
      }
    }
  }

  return { id: tokenId, active, allowed };
}

/**
 * Whether `name` actually runs for this caller: served by the registry
 * AND inside the caller's active set. This is `dispatch`'s branch (a),
 * expressed once. `tool_catalog`, `activate_tool` and `activate_tools`
 * all have to answer the same question, and a copy that drifts reports a
 * tool as active that the very next call refuses — which is exactly what
 * happened to `toolCatalog.ts` before this predicate existed.
 *
 * `served` is the registry's own view (`entry.enabled` from `listAll()`,
 * `isServed(schema)` inside the registry). Both off switches are already
 * false there, so this predicate never has to know the precedence
 * between `userDisabled` and the adaptive flag.
 *
 * No scope means no per-client policy: the pre-ADR-0014 global answer,
 * which is `served` alone.
 */
export function isActiveFor(
  served: boolean,
  name: string,
  scope?: ToolScope,
): boolean {
  return served && (!scope || scope.active.has(name));
}

/**
 * Whether the token's allowlist ceiling permits `name` at all — as
 * opposed to it merely being inactive right now. The distinction is the
 * whole point of the ceiling: an inactive tool is one `activate_tool`
 * call away, a tool outside `allowed` can never be reached, so the
 * meta-tools must refuse it instead of inviting a retry loop
 * (ADR-0014 §9).
 *
 * Meta-tools bypass it here for the same reason `resolveToolScope` keeps
 * them in `active`: a token that cannot call `activate_tool` can never
 * widen its own surface.
 */
export function isAllowedInScope(scope: ToolScope, name: string): boolean {
  return (
    scope.allowed === null ||
    scope.allowed.has(name) ||
    ALWAYS_ACTIVE_TOOLS.includes(name)
  );
}
