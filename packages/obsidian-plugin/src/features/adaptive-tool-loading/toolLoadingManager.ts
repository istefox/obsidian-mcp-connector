import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";
import {
  ALWAYS_ACTIVE_TOOLS,
  CORE_SET,
  META_TOOLS,
  PROMOTION_THRESHOLD,
} from "./constants";
import {
  defaultPolicy,
  mergeState,
  updateToolLoading,
  type MirrorContext,
  type ToolLoadingState,
} from "./tokenPolicyStore";

export type { ToolLoadingState };

const SLICE = "toolLoading";

/**
 * Which token's policy a mutation targets: the caller's token if it
 * named one, else the mirror token. `null` means the vault has no token
 * list at all — data from before the ADR-0014 migration — where the
 * legacy global `profile`/`promoted` fields ARE the only policy, so the
 * mutation applies to them directly.
 */
function targetOf(
  tokenId: string | undefined,
  ctx: MirrorContext,
): string | null {
  return tokenId ?? ctx.mirrorId;
}

function promotedFor(state: ToolLoadingState, target: string | null): string[] {
  return target === null
    ? state.promoted
    : (state.profiles[target] ?? defaultPolicy()).promoted;
}

function setPromoted(
  state: ToolLoadingState,
  target: string | null,
  promoted: string[],
): void {
  if (target === null) {
    state.promoted = promoted;
    return;
  }
  state.profiles[target] = {
    ...(state.profiles[target] ?? defaultPolicy()),
    promoted,
  };
}

/** Append `name` unless it is already there, without mutating `promoted`. */
function union(promoted: string[], name: string): string[] {
  return promoted.includes(name) ? promoted : [...promoted, name];
}

/**
 * Trailing debounce for persisting call counters. recordCall fires on
 * EVERY non-meta tool call; a full loadData/saveData round trip through
 * the global settings mutex per call was the single largest fixed cost
 * on the request path (and queued permission-check writes behind it).
 * Counters are heuristic data — losing a window of them on a crash is
 * acceptable, delaying auto-promotion by up to this window is invisible.
 */
const RECORD_FLUSH_DELAY_MS = 2_000;

/**
 * Pending counter batches, keyed by plugin instance (module-level, NOT
 * per manager): the transport service and the settings UI construct
 * separate ToolLoadingManager instances against the same plugin, and
 * resetAll must clear the batch the transport accumulated — a
 * per-instance map would leave those counts to resurface at the next
 * flush. WeakMap keeps test plugins isolated and lets instances be GCed.
 */
type PendingState = {
  counts: Map<string, number>;
  timer: number | null;
};
const pendingByPlugin = new WeakMap<PluginDataLike, PendingState>();

function pendingFor(plugin: PluginDataLike): PendingState {
  let state = pendingByPlugin.get(plugin);
  if (!state) {
    state = { counts: new Map(), timer: null };
    pendingByPlugin.set(plugin, state);
  }
  return state;
}

export class ToolLoadingManager {
  constructor(private opts: { flushDelayMs?: number } = {}) {}
  async loadState(plugin: PluginDataLike): Promise<ToolLoadingState> {
    return mergeState(await new SettingsStore(plugin).readSlice(SLICE));
  }

  getActiveToolNames(
    allNames: string[],
    // Only the two fields it actually reads, so `resolveToolScope` can
    // pass a token's policy without inventing counters for it.
    state: Pick<ToolLoadingState, "profile" | "promoted">,
  ): Set<string> {
    if (state.profile === "all") {
      return new Set<string>([...META_TOOLS, ...allNames]);
    }
    const base = new Set<string>(ALWAYS_ACTIVE_TOOLS);
    for (const n of CORE_SET) base.add(n);
    // Explicit promotions are honored in BOTH core and adaptive: a tool the
    // user (or `activate_tool`/`activate_tools`) promoted with persist must
    // survive a reconnect regardless of profile. The only core/adaptive
    // difference is auto-promotion by frequency, which lives in recordCall
    // and stays adaptive-only.
    for (const n of state.promoted) base.add(n);
    return base;
  }

  // All mutating methods go through tokenPolicyStore.updateToolLoading,
  // never SettingsStore directly: it is the choke point that keeps the
  // legacy mirror in step with the per-token policies, and it still
  // serializes the load→modify→save cycle through the process-wide
  // settings mutex — data.json is shared with every other feature, so an
  // unserialized read-modify-write here can clobber another feature's
  // slice (or lose a concurrent counter increment). See settingsStore.ts.
  //
  // `tokenId` is optional on every mutator: omitted, it targets the
  // mirror token, so the settings UI and any single-token vault behave
  // exactly as they did in 0.28.2.

  /**
   * Record a tool call for frequency-based promotion. Increments an
   * in-memory counter and schedules a trailing debounced flush instead
   * of persisting per call (see RECORD_FLUSH_DELAY_MS). With
   * `flushDelayMs: 0` the flush is immediate — used by tests that
   * assert on persisted state.
   */
  async recordCall(toolName: string, plugin: PluginDataLike): Promise<void> {
    const pending = pendingFor(plugin);
    pending.counts.set(toolName, (pending.counts.get(toolName) ?? 0) + 1);
    const delay = this.opts.flushDelayMs ?? RECORD_FLUSH_DELAY_MS;
    if (delay <= 0) {
      await this.flushPendingCalls(plugin);
      return;
    }
    if (pending.timer === null) {
      // window.setTimeout (not the bare global): Obsidian popout-window
      // compatibility, and the plugin runs in the renderer where window
      // is always present.
      pending.timer = window.setTimeout(() => {
        pending.timer = null;
        // Fire-and-forget: a failed flush restores the batch in memory
        // (see flushPendingCalls) and the next call retries.
        void this.flushPendingCalls(plugin).catch(() => {});
      }, delay);
    }
  }

  /**
   * Persist all pending counter increments in ONE settings write and
   * apply adaptive auto-promotion against the merged totals. Callers:
   * the recordCall debounce timer, and service teardown (so a window of
   * counts is not lost on unload). Safe to call with nothing pending.
   */
  async flushPendingCalls(plugin: PluginDataLike): Promise<void> {
    const pending = pendingFor(plugin);
    if (pending.timer !== null) {
      window.clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (pending.counts.size === 0) return;
    const batch = pending.counts;
    pending.counts = new Map();
    try {
      await updateToolLoading(plugin, (state, ctx) => {
        for (const [toolName, count] of batch) {
          const total = (state.counters[toolName] ?? 0) + count;
          state.counters[toolName] = total;
          if (
            total < PROMOTION_THRESHOLD ||
            (META_TOOLS as string[]).includes(toolName)
          ) {
            continue;
          }
          // Counters are global but promotion is per token: every
          // adaptive token crosses the same shared threshold and gets
          // the tool in ITS list, in this one write. A token with no
          // policy entry resolves to `all` and is never promoted into.
          if (ctx.tokenIds.length === 0) {
            if (state.profile === "adaptive") {
              setPromoted(state, null, union(state.promoted, toolName));
            }
            continue;
          }
          for (const [id, policy] of Object.entries(state.profiles)) {
            if (policy.profile !== "adaptive") continue;
            setPromoted(state, id, union(policy.promoted, toolName));
          }
        }
        return state;
      });
    } catch (error) {
      // Put the batch back so a transient write failure does not drop
      // the counts; merge with anything recorded meanwhile.
      for (const [toolName, count] of batch) {
        pending.counts.set(
          toolName,
          (pending.counts.get(toolName) ?? 0) + count,
        );
      }
      throw error;
    }
  }

  /**
   * Promote a tool for one token. `tokenId` defaults to the mirror
   * token, which keeps the settings UI and the single-token vault
   * behaving exactly as in 0.28.2.
   */
  async activateTool(
    name: string,
    allNames: string[],
    plugin: PluginDataLike,
    tokenId?: string,
  ): Promise<"activated" | "already_active" | "not_found"> {
    if (!allNames.includes(name)) return "not_found";
    let outcome: "activated" | "already_active" = "activated";
    await updateToolLoading(plugin, (state, ctx) => {
      const target = targetOf(tokenId, ctx);
      const promoted = promotedFor(state, target);
      if (promoted.includes(name)) {
        outcome = "already_active";
        return state; // unchanged ⇒ NO_CHANGE, no write
      }
      setPromoted(state, target, [...promoted, name]);
      return state;
    });
    return outcome;
  }

  /**
   * Batch variant of {@link activateTool}: promote several tools in ONE
   * settings write instead of N. Unknown names (not in `allNames`) are
   * reported back and not persisted. Returns the per-name outcome so the
   * caller can build a summary.
   */
  async activateTools(
    names: string[],
    allNames: string[],
    plugin: PluginDataLike,
    tokenId?: string,
  ): Promise<Record<string, "activated" | "already_active" | "not_found">> {
    const known = new Set(allNames);
    const outcomes: Record<
      string,
      "activated" | "already_active" | "not_found"
    > = {};
    // Dedupe input while preserving first-seen order.
    const requested = [...new Set(names)];

    await updateToolLoading(plugin, (state, ctx) => {
      const target = targetOf(tokenId, ctx);
      const promoted = promotedFor(state, target);
      const promotedSet = new Set(promoted);
      const toAdd: string[] = [];
      for (const name of requested) {
        if (!known.has(name)) {
          outcomes[name] = "not_found";
        } else if (promotedSet.has(name)) {
          outcomes[name] = "already_active";
        } else {
          outcomes[name] = "activated";
          promotedSet.add(name);
          toAdd.push(name);
        }
      }
      if (toAdd.length > 0) setPromoted(state, target, [...promoted, ...toAdd]);
      return state;
    });

    return outcomes;
  }

  async deactivateTool(
    name: string,
    plugin: PluginDataLike,
    tokenId?: string,
  ): Promise<void> {
    await updateToolLoading(plugin, (state, ctx) => {
      const target = targetOf(tokenId, ctx);
      setPromoted(
        state,
        target,
        promotedFor(state, target).filter((n) => n !== name),
      );
      return state;
    });
  }

  /**
   * Counters are global, so they reset globally; `promoted` is per
   * token, so it resets only for the selected one and every other
   * client's surface is untouched.
   */
  async resetAll(plugin: PluginDataLike, tokenId?: string): Promise<void> {
    // Drop the unpersisted batch FIRST (module-level, shared with the
    // transport's manager instance) so a debounced flush scheduled
    // before the reset cannot re-add pre-reset counts afterwards.
    const pending = pendingFor(plugin);
    if (pending.timer !== null) {
      window.clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.counts.clear();
    await updateToolLoading(plugin, (state, ctx) => {
      state.counters = {};
      setPromoted(state, targetOf(tokenId, ctx), []);
      return state;
    });
  }
}
