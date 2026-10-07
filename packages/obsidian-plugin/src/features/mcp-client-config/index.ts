/**
 * MCP client config feature — generates and writes config snippets
 * for the supported MCP client families: Claude Desktop (`.mcpb`
 * export, legacy `mcp-remote`), Claude Code CLI (`claude mcp add`),
 * Cursor / Continue / Windsurf / VS Code (streamable-http), Cline
 * (`streamableHttp`) and Codex (copied TOML, `codex mcp add`, and a
 * previewed, confirmed installer for the user and project `config.toml`,
 * ADR-0028). Also owns the shared discovery broker every client config
 * points at (ADR-0027).
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
  CODEX_STARTUP_TIMEOUT_SEC,
  CODEX_TOKEN_ENV_VAR,
  CodexInstallError,
  codexConfigSnippet,
  codexEntryFor,
  codexMcpAddCommand,
  inspectCodexInstall,
  installCodexConfig,
  locateCodexHome,
  locateCodexProject,
  type CodexConnection,
  type CodexHomeLocation,
  type CodexInstallAction,
  type CodexInstallInput,
  type CodexInstallPreview,
  type CodexInstallResult,
  type CodexInstallScope,
  type CodexInstallTarget,
  type CodexProjectLocation,
  type CodexTokenForm,
} from "./services/codexConfig";

export {
  CODEX_OFFERED_PROFILE,
  codexInstallNotice,
  codexProfileOffer,
  commitCodexInstall,
  prepareCodexInstall,
  type CodexInstallDecision,
  type CodexInstallOutcome,
  type CodexProfileOffer,
  type PreparedCodexInstall,
} from "./services/codexInstallFlow";

export { CodexInstallModal } from "./services/codexInstallModal";

export {
  codexMenuItems,
  type CodexMenuAction,
  type CodexMenuItem,
} from "./services/codexMenu";

export {
  acceptDiscoveryMove,
  createBrokerHost,
  resetDiscoveryIdentity,
  getCodexConnection,
  isLocationUnresolved,
  savedRouteId,
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
export { default as CodexMenu } from "./components/CodexMenu.svelte";
