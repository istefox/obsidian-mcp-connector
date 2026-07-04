/**
 * Composition root for the tool registry.
 *
 * Building the populated registry orchestrates four features (mcp-tools,
 * tool-toggle, adaptive-tool-loading, plus the prompt registry), which
 * is policy, not transport. Keeping it here rather than inside
 * mcp-transport leaves the HTTP layer free of feature wiring: it just
 * consumes the registries this returns.
 */

import { Notice, type App } from "obsidian";
import type McpToolsPlugin from "$/main";
import {
  ToolRegistryClass,
  type ToolRegistry,
} from "$/features/mcp-transport/services/toolRegistry";
import {
  PromptRegistryClass,
  type PromptRegistry,
} from "$/features/mcp-transport/services/promptRegistry";
import { registerTools } from "$/features/mcp-tools";
import { applyDisabledToolsFilter } from "$/features/tool-toggle";
import { applyAdaptiveFilter } from "$/features/adaptive-tool-loading";
import {
  toolCatalogSchema,
  toolCatalogHandler,
} from "$/features/mcp-tools/tools/toolCatalog";
import {
  activateToolSchema,
  activateToolHandler,
} from "$/features/mcp-tools/tools/activateTool";

export type ToolRegistryConfig = {
  app: App;
  plugin: McpToolsPlugin;
  pluginVersion: string;
};

/**
 * Build the populated tool + prompt registries: register every vault
 * tool, add the always-active adaptive meta-tools, then apply the
 * adaptive-profile filter and the user's disabled-tools filter (in that
 * order, so the disable list wins).
 */
export async function composeToolRegistry(
  config: ToolRegistryConfig,
): Promise<{ toolRegistry: ToolRegistry; promptRegistry: PromptRegistry }> {
  const toolRegistry = new ToolRegistryClass();
  const promptRegistry = new PromptRegistryClass();

  await registerTools(toolRegistry, {
    app: config.app,
    plugin: config.plugin,
    pluginVersion: config.pluginVersion,
  });

  // Adaptive-loading meta-tools need the registry itself (for
  // listing/status) and are always active regardless of profile, so
  // they are registered here rather than in registerTools.
  toolRegistry.register(toolCatalogSchema, () =>
    toolCatalogHandler({ registry: toolRegistry, plugin: config.plugin }),
  );
  toolRegistry.register(
    activateToolSchema,
    async (request, { server, sendNotification }) =>
      activateToolHandler({
        arguments: (
          request as { arguments: { name: string; persist?: boolean } }
        ).arguments,
        registry: toolRegistry,
        plugin: config.plugin,
        server,
        onActivated: (name) =>
          new Notice(`MCP Connector: "${name}" promoted to active`),
        enableInRegistry: (name) => toolRegistry.enableByName(name),
        sendNotification,
      }),
  );

  // Adaptive profile filter (All/Core/Adaptive) runs before toolToggle
  // so the user-controlled disable list still wins.
  await applyAdaptiveFilter(toolRegistry, config.plugin);
  // Disabled tools stay registered but are flipped off the enabled set,
  // so they no longer appear in tools/list and tools/call returns
  // MethodNotFound. Idempotent.
  await applyDisabledToolsFilter(toolRegistry, config.plugin);

  return { toolRegistry, promptRegistry };
}
