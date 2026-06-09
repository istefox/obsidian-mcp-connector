import { type } from "arktype";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolLoadingManager } from "$/features/adaptive-tool-loading/toolLoadingManager";

export const activateToolSchema = type({
  name: '"activate_tool"',
  arguments: {
    name: type("string").describe("Exact name of the tool to activate."),
    "persist?": type("boolean").describe(
      "If true, write the promotion to data.json so it survives the session. Defaults to false (session-only, no reconnect needed).",
    ),
  },
}).describe(
  "Promotes an inactive tool to active status. With persist=false (default) the tool is available immediately in this session only. With persist=true the promotion is saved and survives reconnects. Run tool_catalog first to see available tool names.",
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

  onActivated?.(args.name);

  if (args.persist === true) {
    const allNames = allEntries.map((e) => e.name);
    const mgr = new ToolLoadingManager();
    await mgr.activateTool(args.name, allNames, plugin);

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
          text: "Tool activated and saved. Reconnect the MCP server to use it in this session.",
        },
      ],
    };
  }

  enableInRegistry?.(args.name);

  try {
    await server.server.notification({
      method: "notifications/tools/list_changed",
    });
  } catch {
    // Stateless JSON transport may not support server-initiated notifications.
  }

  return {
    content: [
      {
        type: "text",
        text: "Tool activated for this session. Available immediately — no reconnect needed.",
      },
    ],
  };
}
