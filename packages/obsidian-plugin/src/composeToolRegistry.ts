/**
 * Composition root for the tool registry.
 *
 * Building the populated registries orchestrates five features (mcp-tools,
 * tool-toggle, adaptive-tool-loading, mcp-apps, plus the prompt registry),
 * which is policy, not transport. Keeping it here rather than inside
 * mcp-transport leaves the HTTP layer free of feature wiring: it just
 * consumes the tool, prompt and resource registries this returns.
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
import {
  ResourceRegistryClass,
  type ResourceRegistry,
} from "$/features/mcp-transport/services/resourceRegistry";
import { wireSearchResultsApp } from "$/features/mcp-apps";
import { createGuardedApp, isGuardedApp } from "$/shared/guardedApp";
import { pathPolicyFor } from "$/shared/policyProvider";
import { registerTools } from "$/features/mcp-tools";
import { applyDisabledToolsFilter } from "$/features/tool-toggle";
import type { SessionPromotions } from "$/features/adaptive-tool-loading/sessionPromotions";
import {
  toolCatalogSchema,
  toolCatalogHandler,
} from "$/features/mcp-tools/tools/toolCatalog";
import {
  activateToolSchema,
  activateToolHandler,
} from "$/features/mcp-tools/tools/activateTool";
import {
  activateToolsSchema,
  activateToolsHandler,
} from "$/features/mcp-tools/tools/activateTools";

export type ToolRegistryConfig = {
  app: App;
  plugin: McpToolsPlugin;
  pluginVersion: string;
  /**
   * Where `activate_tool`'s in-session (persist: false) promotions go,
   * keyed by the calling token. Owned by the transport service so it
   * outlives the request; wired here because the meta-tools are wired
   * here (ADR-0014 §5).
   */
  session: SessionPromotions;
};

/**
 * Build the populated tool, prompt and resource registries: register
 * every vault tool, add the always-active adaptive meta-tools, apply the
 * user's disabled-tools filter, then wire the MCP Apps `ui://` resource
 * and its tool pointers (ADR-0018).
 *
 * There is no profile filter at this level any more: the profile is per
 * token and the registry is shared, so the surface is narrowed per
 * request from the caller's `ToolScope` instead of being baked into the
 * registry's adaptive flags (ADR-0014 §3). The disable list still wins,
 * because the registry re-applies `userDisabled` under every scope.
 */
export async function composeToolRegistry(config: ToolRegistryConfig): Promise<{
  toolRegistry: ToolRegistry;
  promptRegistry: PromptRegistry;
  resourceRegistry: ResourceRegistry;
}> {
  const toolRegistry = new ToolRegistryClass();
  const promptRegistry = new PromptRegistryClass();
  const resourceRegistry = new ResourceRegistryClass();

  // ADR-0020 D1: every tool handler receives its App from the single
  // `ctx.app` below, so guarding it here covers the whole tool surface —
  // including a tool written later, whose author need not know this
  // exists. D7's bootstrap read happens first, so the server never
  // serves a request under the pre-read deny-all posture.
  const policy = pathPolicyFor(config.plugin);
  await policy.refresh();
  const app = createGuardedApp(config.app, () => policy.current());

  // Tripwire, not a formality: if a refactor ever routes the raw App
  // through here again, this fails at startup instead of silently
  // serving every excluded folder.
  if (!isGuardedApp(app)) {
    throw new Error(
      "composeToolRegistry: refusing to register tools against an unguarded App (ADR-0020 D1).",
    );
  }

  await registerTools(toolRegistry, {
    app,
    plugin: config.plugin,
    pluginVersion: config.pluginVersion,
  });

  // Adaptive-loading meta-tools need the registry itself (for
  // listing/status) and are always active regardless of profile, so
  // they are registered here rather than in registerTools.
  toolRegistry.register(toolCatalogSchema, (_request, { scope }) =>
    toolCatalogHandler({
      registry: toolRegistry,
      plugin: config.plugin,
      scope,
    }),
  );
  // `enableInRegistry` and `promoteInSession` are both wired: the handler
  // picks the session map when the call carries a scope (a real MCP
  // client) and the registry's global adaptive flag when it does not (the
  // settings UI and unit tests), so one client's promotion can no longer
  // widen another's surface.
  toolRegistry.register(
    activateToolSchema,
    async (request, { server, sendNotification, scope }) =>
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
        promoteInSession: (tokenId, name) =>
          config.session.promote(tokenId, name),
        scope,
        sendNotification,
      }),
  );
  toolRegistry.register(
    activateToolsSchema,
    async (request, { server, sendNotification, scope }) =>
      activateToolsHandler({
        arguments: (
          request as { arguments: { names: string[]; persist?: boolean } }
        ).arguments,
        registry: toolRegistry,
        plugin: config.plugin,
        server,
        onActivated: (name) =>
          new Notice(`MCP Connector: "${name}" promoted to active`),
        enableInRegistry: (name) => toolRegistry.enableByName(name),
        promoteInSession: (tokenId, name) =>
          config.session.promote(tokenId, name),
        scope,
        sendNotification,
      }),
  );

  // Disabled tools stay registered but are flipped off the enabled set,
  // so they no longer appear in tools/list and tools/call returns
  // MethodNotFound. Idempotent.
  await applyDisabledToolsFilter(toolRegistry, config.plugin);

  wireSearchResultsApp(toolRegistry, resourceRegistry);

  return { toolRegistry, promptRegistry, resourceRegistry };
}
