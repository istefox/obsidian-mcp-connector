// Side-effect import — applies the McpToolsPluginSettings module
// augmentation so `plugin.loadData()` is typed with `toolToggle`.
import "./types";

export { default as FeatureSettings } from "./components/ToolToggleSettings.svelte";
export {
  DESTRUCTIVE_TOOL_NAMES,
  KNOWN_MCP_TOOL_NAMES,
  parseDisabledToolsCsv,
} from "./utils";
export {
  applyDisabledToolsFilter,
  type ApplyDisabledToolsFilterResult,
} from "./services/applyFilter";
