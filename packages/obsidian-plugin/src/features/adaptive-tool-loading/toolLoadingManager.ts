import { CORE_SET, META_TOOLS, PROMOTION_THRESHOLD } from "./constants";

export type ToolLoadingState = {
  profile: "all" | "core" | "adaptive";
  counters: Record<string, number>;
  promoted: string[];
};

export type PluginLike = {
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
};

const DEFAULTS: ToolLoadingState = {
  profile: "all",
  counters: {},
  promoted: [],
};

function mergeState(raw: unknown): ToolLoadingState {
  const slice =
    raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).toolLoading as
          | Partial<ToolLoadingState>
          | undefined)
      : undefined;
  return {
    ...DEFAULTS,
    ...(slice ?? {}),
    counters:
      slice?.counters && typeof slice.counters === "object"
        ? (slice.counters as Record<string, number>)
        : {},
    promoted: Array.isArray(slice?.promoted) ? slice.promoted : [],
  };
}

export class ToolLoadingManager {
  async loadState(plugin: PluginLike): Promise<ToolLoadingState> {
    const raw = await plugin.loadData();
    return mergeState(raw);
  }

  getActiveToolNames(
    allNames: string[],
    state: ToolLoadingState,
  ): Set<string> {
    const base = new Set<string>(META_TOOLS);
    if (state.profile === "all") {
      for (const n of allNames) base.add(n);
      return base;
    }
    for (const n of CORE_SET) base.add(n);
    if (state.profile === "adaptive") {
      for (const n of state.promoted) base.add(n);
    }
    return base;
  }

  async recordCall(toolName: string, plugin: PluginLike): Promise<void> {
    const raw = (await plugin.loadData()) as Record<string, unknown> | null;
    const state = mergeState(raw);
    state.counters[toolName] = (state.counters[toolName] ?? 0) + 1;
    if (
      state.profile === "adaptive" &&
      state.counters[toolName] >= PROMOTION_THRESHOLD &&
      !state.promoted.includes(toolName) &&
      !(META_TOOLS as string[]).includes(toolName)
    ) {
      state.promoted = [...state.promoted, toolName];
    }
    await plugin.saveData({ ...(raw ?? {}), toolLoading: state });
  }

  async activateTool(
    name: string,
    allNames: string[],
    plugin: PluginLike,
  ): Promise<"activated" | "already_active" | "not_found"> {
    if (!allNames.includes(name)) return "not_found";
    const raw = (await plugin.loadData()) as Record<string, unknown> | null;
    const state = mergeState(raw);
    if (state.promoted.includes(name)) return "already_active";
    state.promoted = [...state.promoted, name];
    await plugin.saveData({ ...(raw ?? {}), toolLoading: state });
    return "activated";
  }

  async deactivateTool(name: string, plugin: PluginLike): Promise<void> {
    const raw = (await plugin.loadData()) as Record<string, unknown> | null;
    const state = mergeState(raw);
    state.promoted = state.promoted.filter((n) => n !== name);
    await plugin.saveData({ ...(raw ?? {}), toolLoading: state });
  }

  async resetAll(plugin: PluginLike): Promise<void> {
    const raw = (await plugin.loadData()) as Record<string, unknown> | null;
    const state = mergeState(raw);
    state.counters = {};
    state.promoted = [];
    await plugin.saveData({ ...(raw ?? {}), toolLoading: state });
  }
}
