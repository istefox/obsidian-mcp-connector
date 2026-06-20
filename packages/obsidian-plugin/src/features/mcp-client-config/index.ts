/**
 * MCP client config feature — generates and writes config snippets
 * for the supported MCP client families (Claude Desktop via
 * `mcp-remote`, Claude Code CLI, Cursor / Cline / Continue / VS Code
 * via streamable-http).
 *
 * Public API surface today is the Claude Desktop writer (T3).
 * Pure-function generators for the three client families (T4) and
 * the Settings UI (T5) ride in subsequent commits.
 */

export {
  FORK_PLUGIN_ID,
  LEGACY_PLUGIN_ID,
  defaultClaudeDesktopConfigPath,
  removeFromClaudeDesktopConfig,
  updateClaudeDesktopConfig,
  updateClaudeDesktopConfigInputSchema,
  type UpdateClaudeDesktopConfigInput,
} from "./services/claudeDesktop";

export {
  claudeCodeConfig,
  claudeDesktopConfig,
  clientConfigInputSchema,
  streamableHttpConfig,
  wrapInMcpServers,
  type ClaudeCodeEntry,
  type ClaudeDesktopEntry,
  type ClientConfigInput,
  type StreamableHttpEntry,
} from "./services/generators";

export {
  applyAutoWrite,
  getAutoWriteEnabled,
  setAutoWriteEnabled,
  type ApplyAutoWriteResult,
} from "./services/autoWrite";

export {
  clearNodeDetectCache,
  detectBrew,
  detectNode,
  getDetectedBrewPath,
  getDetectedNodeBinDir,
  getDetectedNodePath,
  getDetectedNpxPath,
  installNodeViaBrew,
  type BrewDetectResult,
  type BrewInstallNodeResult,
  type BrewInstallRunner,
  type ExecRunner,
  type NodeDetectResult,
} from "./services/nodeDetect";

export {
  getPreWarmCache,
  preWarm,
  type PreWarmCacheEntry,
  type PreWarmResult,
} from "./services/preWarm";

export {
  generateMcpb,
  type McpbGeneratorInput,
} from "./services/mcpbGenerator";

export { default as ClientConfigSection } from "./components/ClientConfigSection.svelte";
