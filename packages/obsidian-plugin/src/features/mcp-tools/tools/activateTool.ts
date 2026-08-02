import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import type { McpServer } from "@modelcontextprotocol/server";
import { ToolLoadingManager } from "$/features/adaptive-tool-loading/toolLoadingManager";
import {
  isActiveFor,
  isAllowedInScope,
} from "$/features/adaptive-tool-loading/resolveToolScope";
import type { PluginDataLike, ToolScope } from "$/shared/types";
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
  promoteInSession,
  scope,
  sendNotification,
}: {
  arguments: { name: string; persist?: boolean };
  registry: RegistryLike;
  plugin: PluginDataLike;
  server: McpServer;
  onActivated?: (toolName: string) => void;
  enableInRegistry?: (name: string) => boolean;
  /**
   * Session promotion for ONE token (ADR-0014 §5), used instead of
   * `enableInRegistry` whenever the call carries a scope: the registry's
   * adaptive flag is global, so clearing it would hand every other
   * client the same tool.
   */
  promoteInSession?: (tokenId: string, name: string) => void;
  /**
   * The calling client's resolved surface. Absent means "no per-client
   * policy" — the settings-UI and unit-test path, which keeps the exact
   * 0.28.2 behaviour.
   */
  scope?: ToolScope;
  /**
   * Request-scoped notification sender (from the SDK handler's `extra`).
   * When present it tags the notification with the current request's
   * `relatedRequestId`, so `tools/list_changed` rides back on this call's
   * POST response stream and the client re-lists without a reconnect.
   */
  sendNotification?: (notification: {
    method: string;
    params?: Record<string, unknown>;
  }) => Promise<void>;
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

  if (found.userDisabled) {
    return errorText(
      `Tool '${args.name}' was disabled by the user and cannot be activated via MCP. Ask the user to re-enable it in the plugin's tool-toggle settings.`,
    );
  }

  // The token's allowlist is a ceiling activation cannot lift, so this
  // outranks the "activate it" branch below and reuses the `not_allowed`
  // shape ADR-0010 introduced for user-disabled tools — with wording that
  // points at the vault owner rather than inviting a retry.
  if (scope && !isAllowedInScope(scope, args.name)) {
    return errorText(
      `Tool '${args.name}' is not available to this client. The token's allowed-tools list does not include it. Ask the vault owner to change it in the plugin's token settings.`,
    );
  }

  // "Already active" is per caller: a tool served globally can still be
  // outside this token's set, and saying "already active" for it would
  // strand the client on a tool it cannot call.
  if (isActiveFor(found.enabled, args.name, scope)) {
    return successText("Tool is already active in the current session.");
  }

  onActivated?.(args.name);

  // Available immediately on either path; `persist` only controls whether
  // the promotion is ALSO written to data.json so it survives plugin
  // reloads. Where it lands differs: a scoped call promotes for its own
  // token only, an unscoped one keeps clearing the registry's global
  // adaptive flag.
  if (scope) {
    promoteInSession?.(scope.id, args.name);
  } else {
    enableInRegistry?.(args.name);
  }

  if (args.persist === true) {
    const allNames = allEntries.map((e) => e.name);
    const mgr = new ToolLoadingManager();
    await mgr.activateTool(args.name, allNames, plugin, scope?.id);
  }

  try {
    // Prefer the request-scoped sender: it tags relatedRequestId so the
    // notification is delivered on THIS call's POST response stream (the
    // transport switches that response to SSE for activate_tool). The raw
    // server.notification fallback goes to the standalone GET stream, which
    // is blocked here, so it is a no-op — kept only so callers that don't
    // thread sendNotification keep the prior behavior.
    if (sendNotification) {
      await sendNotification({ method: "notifications/tools/list_changed" });
    } else {
      await server.server.notification({
        method: "notifications/tools/list_changed",
      });
    }
  } catch {
    // Transport may not support server-initiated notifications on this path.
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
