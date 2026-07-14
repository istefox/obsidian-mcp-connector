import { logger } from "$/shared/logger";
import type { PluginDataLike } from "$/shared/types";
import { ToolLoadingManager } from "./toolLoadingManager";

type RegistryLike = {
  setAdaptiveDisabled: (name: string, disabled: boolean) => boolean;
  listAll: () => { name: string; description: string; enabled: boolean }[];
};

export async function applyAdaptiveFilter(
  registry: RegistryLike,
  plugin: PluginDataLike,
): Promise<void> {
  const mgr = new ToolLoadingManager();
  const state = await mgr.loadState(plugin);

  if (state.profile === "all") return;

  const allEntries = registry.listAll();
  const allNames = allEntries.map((e) => e.name);
  const active = mgr.getActiveToolNames(allNames, state);

  const disabled: string[] = [];
  for (const name of allNames) {
    if (!active.has(name)) {
      registry.setAdaptiveDisabled(name, true);
      disabled.push(name);
    }
  }

  logger.info("adaptive-tool-loading: filter applied", {
    profile: state.profile,
    active: active.size,
    disabled: disabled.length,
  });
}
