import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ToolLoadingManager,
  type PluginLike,
} from "$/features/adaptive-tool-loading/toolLoadingManager";
import type { RegistryLike } from "$/features/adaptive-tool-loading/types";

export const activateToolSchema = type({
  name: '"activate_tool"',
  arguments: {
    name: type("string").describe("Exact name of the tool to activate."),
    "persist?": type("boolean").describe(
      "If true, write the promotion to data.json so it survives plugin reloads. Defaults to false (in-memory until the plugin reloads, available immediately).",
    ),
  },
}).describe(
  "Promotes an inactive tool to active status. With persist=false (default) the tool is available immediately and stays active until the Obsidian plugin reloads. With persist=true the promotion is saved and survives plugin reloads. Run tool_catalog first to see available tool names.",
);

export async function activateToolHandler({
  arguments: args,
  registry,
  plugin,
  server,
  onActivated,
  enableInRegistry,
}: {
  arguments: { name: string; persist?: boolean };
  registry: RegistryLike;
  plugin: PluginLike;
  server: McpServer;
  onActivated?: (toolName: string) => void;
  enableInRegistry?: (name: string) => boolean;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const allEntries = registry.listAll();
  const found = allEntries.find((e) => e.name === args.name);

  if (!found) {
    return errorText(
      `Unknown tool: '${args.name}'. Run tool_catalog to see available tools.`,
    );
  }

  if (found.enabled) {
    return successText("Tool is already active in the current session.");
  }

  onActivated?.(args.name);

  // The registry lives for the whole plugin session, so flipping the tool
  // on here makes it available immediately on either path. `persist` only
  // controls whether the promotion is ALSO written to data.json so it
  // survives plugin reloads.
  enableInRegistry?.(args.name);

  if (args.persist === true) {
    const allNames = allEntries.map((e) => e.name);
    const mgr = new ToolLoadingManager();
    await mgr.activateTool(args.name, allNames, plugin);
  }

  try {
    await server.server.notification({
      method: "notifications/tools/list_changed",
    });
  } catch {
    // Stateless JSON transport may not support server-initiated notifications.
    // Clients pick up the change on their next tools/list request.
  }

  return {
    content: [
      {
        type: "text",
        text:
          args.persist === true
            ? "Tool activated and saved. Available immediately; survives plugin reloads."
            : "Tool activated. Available immediately; stays active until the plugin reloads.",
      },
    ],
  };
}
