import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";
import {
  ADAPTIVE_META_TOOLS,
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

export class ToolLoadingManager {
  async loadState(plugin: PluginDataLike): Promise<ToolLoadingState> {
    return mergeState(await new SettingsStore(plugin).readSlice(SLICE));
  }

  getActiveToolNames(allNames: string[], state: ToolLoadingState): Set<string> {
    if (state.profile === "all") {
      return new Set<string>([...META_TOOLS, ...allNames]);
    }
    const base = new Set<string>(ALWAYS_ACTIVE_TOOLS);
    for (const n of CORE_SET) base.add(n);
    if (state.profile === "adaptive") {
      for (const n of ADAPTIVE_META_TOOLS) base.add(n);
      for (const n of state.promoted) base.add(n);
    }
    return base;
  }

  // All mutating methods go through SettingsStore.updateSlice, which
  // serializes the load→modify→save cycle through the process-wide
  // settings mutex: data.json is shared with every other feature, so an
  // unserialized read-modify-write here can clobber another feature's
  // slice (or lose a concurrent counter increment). See settingsStore.ts.

  async recordCall(toolName: string, plugin: PluginDataLike): Promise<void> {
    await new SettingsStore(plugin).updateSlice(SLICE, (current) => {
      const state = mergeState(current);
      state.counters[toolName] = (state.counters[toolName] ?? 0) + 1;
      if (
        state.profile === "adaptive" &&
        state.counters[toolName] >= PROMOTION_THRESHOLD &&
        !state.promoted.includes(toolName) &&
        !(META_TOOLS as string[]).includes(toolName)
      ) {
        state.promoted = [...state.promoted, toolName];
      }
      return state;
    });
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
