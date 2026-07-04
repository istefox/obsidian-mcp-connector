import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolLoadingManager } from "$/features/adaptive-tool-loading/toolLoadingManager";
import type { PluginDataLike } from "$/shared/types";
import type { RegistryLike } from "$/features/adaptive-tool-loading/types";

export const activateToolsSchema = type({
  name: '"activate_tools"',
  arguments: {
    names: type("string[]").describe(
      "Exact names of the tools to activate, in one batch.",
    ),
    "persist?": type("boolean").describe(
      "If true, write the promotions to data.json so they survive plugin reloads. Defaults to false (in-memory until the plugin reloads, available immediately).",
    ),
  },
}).describe(
  "Promotes several inactive tools to active status in ONE call. Prefer this over multiple `activate_tool` calls when a task needs more than one inactive tool: it activates them all and refreshes the client's tool list only once, instead of once per tool. Run `tool_catalog` first to see available tool names. With persist=true the promotions survive plugin reloads.",
);

type Outcome = "activated" | "already_active" | "not_found";

export async function activateToolsHandler({
  arguments: args,
  registry,
  plugin,
  server,
  onActivated,
  enableInRegistry,
  sendNotification,
}: {
  arguments: { names: string[]; persist?: boolean };
  registry: RegistryLike;
  plugin: PluginDataLike;
  server: McpServer;
  onActivated?: (toolName: string) => void;
  enableInRegistry?: (name: string) => boolean;
  sendNotification?: (notification: {
    method: string;
    params?: Record<string, unknown>;
  }) => Promise<void>;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const allEntries = registry.listAll();
  const byName = new Map(allEntries.map((e) => [e.name, e]));
  // Dedupe while preserving first-seen order.
  const requested = [...new Set(args.names)];

  const outcomes: Record<string, Outcome> = {};
  const activated: string[] = [];

  for (const name of requested) {
    const entry = byName.get(name);
    if (!entry) {
      outcomes[name] = "not_found";
    } else if (entry.enabled) {
      outcomes[name] = "already_active";
    } else {
      outcomes[name] = "activated";
      activated.push(name);
      onActivated?.(name);
      enableInRegistry?.(name);
    }
  }

  // Persist only the newly-activated tools, in a single write.
  if (args.persist === true && activated.length > 0) {
    const allNames = allEntries.map((e) => e.name);
    await new ToolLoadingManager().activateTools(activated, allNames, plugin);
  }

  // One notification for the whole batch — the whole point of this tool.
  // Only fire when something actually changed, so a no-op batch does not
  // trigger a needless client re-list. Prefer the request-scoped sender so
  // the notification rides the POST response stream (see activateTool.ts).
  if (activated.length > 0) {
    try {
      if (sendNotification) {
        await sendNotification({ method: "notifications/tools/list_changed" });
      } else {
        await server.server.notification({
          method: "notifications/tools/list_changed",
        });
      }
    } catch {
      // Transport may not support server-initiated notifications on this
      // path. Clients pick up the change on their next tools/list request.
    }
  }

  const summary = {
    requested: requested.length,
    activated: activated.length,
    outcomes,
    ...(args.persist === true ? { persisted: activated.length > 0 } : {}),
    note:
      activated.length > 0
        ? "Activated tools are available immediately."
        : "No changes: all requested tools were already active or unknown.",
  };

  return successText(JSON.stringify(summary));
}
