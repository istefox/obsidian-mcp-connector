import { type } from "arktype";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolLoadingManager } from "$/features/adaptive-tool-loading/toolLoadingManager";

export const activateToolSchema = type({
  name: '"activate_tool"',
  arguments: {
    name: type("string").describe("Exact name of the tool to activate."),
  },
}).describe(
  "Promotes an inactive tool to active status so it appears in the next MCP session. Run tool_catalog first to see available tool names and their current status.",
);

type RegistryLike = {
  listAll: () => { name: string; description: string; enabled: boolean }[];
};

type PluginLike = {
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
};

export async function activateToolHandler({
  arguments: args,
  registry,
  plugin,
  server,
  onActivated,
}: {
  arguments: { name: string };
  registry: RegistryLike;
  plugin: PluginLike;
  server: McpServer;
  onActivated?: (toolName: string) => void;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const allEntries = registry.listAll();
  const found = allEntries.find((e) => e.name === args.name);

  if (!found) {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: '${args.name}'. Run tool_catalog to see available tools.`,
        },
      ],
      isError: true,
    };
  }

  if (found.enabled) {
    return {
      content: [
        {
          type: "text",
          text: "Tool is already active in the current session.",
        },
      ],
    };
  }

  const allNames = allEntries.map((e) => e.name);
  const mgr = new ToolLoadingManager();
  await mgr.activateTool(args.name, allNames, plugin);
  onActivated?.(args.name);

  try {
    await server.server.notification({
      method: "notifications/tools/list_changed",
    });
  } catch {
    // Stateless JSON transport may not support server-initiated notifications.
    // The reconnect message in the response covers this case.
  }

  return {
    content: [
      {
        type: "text",
        text: "Tool activated. Reconnect the MCP server to use it in this session.",
      },
    ],
  };
}
