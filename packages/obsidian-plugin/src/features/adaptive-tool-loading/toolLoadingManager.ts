import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";
import {
  ALWAYS_ACTIVE_TOOLS,
  CORE_SET,
  META_TOOLS,
  PROMOTION_THRESHOLD,
} from "./constants";

export type ToolLoadingState = {
  profile: "all" | "core" | "adaptive";
  counters: Record<string, number>;
  promoted: string[];
};

const DEFAULTS: ToolLoadingState = {
  profile: "all",
  counters: {},
  promoted: [],
};

/** Normalize a raw `toolLoading` slice value into a well-formed state. */
function mergeState(slice: unknown): ToolLoadingState {
  const s =
    slice && typeof slice === "object"
      ? (slice as Partial<ToolLoadingState>)
      : undefined;
  return {
    ...DEFAULTS,
    ...(s ?? {}),
    counters: s?.counters && typeof s.counters === "object" ? s.counters : {},
    promoted: Array.isArray(s?.promoted) ? s.promoted : [],
  };
}

const SLICE = "toolLoading";

/**
 * Trailing debounce for persisting call counters. recordCall fires on
 * EVERY non-meta tool call; a full loadData/saveData round trip through
 * the global settings mutex per call was the single largest fixed cost
 * on the request path (and queued permission-check writes behind it).
 * Counters are heuristic data — losing a window of them on a crash is
 * acceptable, delaying auto-promotion by up to this window is invisible.
 */
const RECORD_FLUSH_DELAY_MS = 2_000;

export class ToolLoadingManager {
  /** In-memory counter increments not yet persisted to data.json. */
  private pendingCalls = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: { flushDelayMs?: number } = {}) {}
  async loadState(plugin: PluginDataLike): Promise<ToolLoadingState> {
    return mergeState(await new SettingsStore(plugin).readSlice(SLICE));
  }

  getActiveToolNames(allNames: string[], state: ToolLoadingState): Set<string> {
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

  // All mutating methods go through SettingsStore.updateSlice, which
  // serializes the load→modify→save cycle through the process-wide
  // settings mutex: data.json is shared with every other feature, so an
  // unserialized read-modify-write here can clobber another feature's
  // slice (or lose a concurrent counter increment). See settingsStore.ts.

  /**
   * Record a tool call for frequency-based promotion. Increments an
   * in-memory counter and schedules a trailing debounced flush instead
   * of persisting per call (see RECORD_FLUSH_DELAY_MS). With
   * `flushDelayMs: 0` the flush is immediate — used by tests that
   * assert on persisted state.
   */
  async recordCall(toolName: string, plugin: PluginDataLike): Promise<void> {
    this.pendingCalls.set(toolName, (this.pendingCalls.get(toolName) ?? 0) + 1);
    const delay = this.opts.flushDelayMs ?? RECORD_FLUSH_DELAY_MS;
    if (delay <= 0) {
      await this.flushPendingCalls(plugin);
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
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
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingCalls.size === 0) return;
    const batch = this.pendingCalls;
    this.pendingCalls = new Map();
    try {
      await new SettingsStore(plugin).updateSlice(SLICE, (current) => {
        const state = mergeState(current);
        for (const [toolName, count] of batch) {
          state.counters[toolName] = (state.counters[toolName] ?? 0) + count;
          if (
            state.profile === "adaptive" &&
            state.counters[toolName] >= PROMOTION_THRESHOLD &&
            !state.promoted.includes(toolName) &&
            !(META_TOOLS as string[]).includes(toolName)
          ) {
            state.promoted = [...state.promoted, toolName];
          }
        }
        return state;
      });
    } catch (error) {
      // Put the batch back so a transient write failure does not drop
      // the counts; merge with anything recorded meanwhile.
      for (const [toolName, count] of batch) {
        this.pendingCalls.set(
          toolName,
          (this.pendingCalls.get(toolName) ?? 0) + count,
        );
      }
      throw error;
    }
  }

  async activateTool(
    name: string,
    allNames: string[],
    plugin: PluginDataLike,
  ): Promise<"activated" | "already_active" | "not_found"> {
    if (!allNames.includes(name)) return "not_found";
    let outcome: "activated" | "already_active" = "activated";
    await new SettingsStore(plugin).updateSlice(SLICE, (current) => {
      const state = mergeState(current);
      if (state.promoted.includes(name)) {
        outcome = "already_active";
        return current; // NO_CHANGE: no write
      }
      state.promoted = [...state.promoted, name];
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
  ): Promise<Record<string, "activated" | "already_active" | "not_found">> {
    const known = new Set(allNames);
    const outcomes: Record<
      string,
      "activated" | "already_active" | "not_found"
    > = {};
    // Dedupe input while preserving first-seen order.
    const requested = [...new Set(names)];

    await new SettingsStore(plugin).updateSlice(SLICE, (current) => {
      const state = mergeState(current);
      const promotedSet = new Set(state.promoted);
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
      if (toAdd.length === 0) return current; // NO_CHANGE: no write
      state.promoted = [...state.promoted, ...toAdd];
      return state;
    });

    return outcomes;
  }

  async deactivateTool(name: string, plugin: PluginDataLike): Promise<void> {
    await new SettingsStore(plugin).updateSlice(SLICE, (current) => {
      const state = mergeState(current);
      state.promoted = state.promoted.filter((n) => n !== name);
      return state;
    });
  }

  async resetAll(plugin: PluginDataLike): Promise<void> {
    await new SettingsStore(plugin).updateSlice(SLICE, (current) => {
      const state = mergeState(current);
      state.counters = {};
      state.promoted = [];
      return state;
    });
  }
}
