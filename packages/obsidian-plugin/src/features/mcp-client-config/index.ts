/**
 * MCP client config feature — generates and writes config snippets
 * for the supported MCP client families: Claude Desktop (`.mcpb`
 * export, legacy `mcp-remote`), Claude Code CLI (`claude mcp add`),
 * Cursor / Continue / Windsurf / VS Code (streamable-http), Cline
 * (`streamableHttp`) and Codex (copied TOML). Also owns the shared
 * discovery broker every client config points at (ADR-0027).
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
  claudeCodeEnvConfig,
  claudeCodeProjectAddCommand,
  CLAUDE_CODE_TOKEN_ENV_VAR,
  claudeDesktopConfig,
  clientConfigInputSchema,
  clineConfig,
  parseClaudeCodeProjectPath,
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
  getClaudeCodeProjectPath,
  setClaudeCodeProjectPath,
} from "./services/claudeCodeProject";

export {
  codexConfigSnippet,
  type CodexConnection,
} from "./services/codexConfig";

export {
  acceptDiscoveryMove,
  createBrokerHost,
  resetDiscoveryIdentity,
  getCodexConnection,
  isLocationUnresolved,
  startDiscovery,
  type BrokerHost,
  type DiscoveryRuntime,
  type DiscoveryStatus,
} from "./services/discoveryBroker";

export {
  createRouteQueue,
  replaceRoute,
  restartTransport,
  RouteQueueClosed,
  type RouteQueue,
} from "./services/routeLifecycle";

export {
  brokerRouteUrl,
  clientEndpointUrl,
  directVaultUrl,
  resolveClientEndpoint,
  resolveClientEndpointDetails,
  type ClientEndpoint,
} from "./services/endpoint";

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
