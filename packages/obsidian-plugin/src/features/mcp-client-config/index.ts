/**
 * MCP client config feature — generates and writes config snippets
 * for the supported MCP client families: Claude Desktop (`.mcpb`
 * export, legacy `mcp-remote`), Claude Code CLI (`claude mcp add`),
 * Cursor / Continue / Windsurf / VS Code (streamable-http), Cline
 * (`streamableHttp`) and Codex (TOML installer + discovery broker).
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
  claudeCodeAddCommand,
  claudeCodeConfig,
  claudeDesktopConfig,
  clientConfigInputSchema,
  clineConfig,
  streamableHttpConfig,
  vaultNameWords,
  vaultServerId,
  wrapInMcpServers,
  type ClaudeCodeEntry,
  type ClaudeCodeScope,
  type ClaudeDesktopEntry,
  type ClientConfigInput,
  type ClineEntry,
  type StreamableHttpEntry,
} from "./services/generators";

export {
  applyAutoWrite,
  getAutoWriteEnabled,
  releaseAutoWriteOwner,
  resolveAutoWriteOwner,
  setAutoWriteOwner,
  type ApplyAutoWriteResult,
} from "./services/autoWrite";

export {
  codexConfigSnippet,
  codexServerId,
  inspectCodexInstall,
  installCodexConfig,
  locateCodexConfig,
  type CodexConfigLocation,
  type CodexConnection,
  type CodexInstallPreview,
  type CodexInstallResult,
} from "./services/codexConfig";

export {
  DISCOVERY_BROKER_PORT,
  DISCOVERY_PROTOCOL_VERSION,
  acceptDiscoveryMove,
  resetDiscoveryIdentity,
  disableCodexDiscovery,
  enableCodexDiscovery,
  getCodexConnection,
  releaseCodexDiscoveryOwner,
  resolveCodexDiscoveryOwner,
  startCodexDiscovery,
  type DiscoveryRuntime,
  type DiscoveryStatus,
} from "./services/discoveryBroker";

export {
  clearNodeDetectCache,
  detectBrew,
  detectNode,
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

export { downloadMcpb } from "./services/mcpbDownload";

export { default as ClaudeDesktopIntegrationSection } from "./components/ClaudeDesktopIntegrationSection.svelte";
export { default as CopyConfigMenu } from "./components/CopyConfigMenu.svelte";
