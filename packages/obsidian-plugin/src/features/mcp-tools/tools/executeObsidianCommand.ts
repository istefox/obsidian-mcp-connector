/**
 * MCP tool: `execute_obsidian_command`
 *
 * Executes a registered Obsidian command by id. The call is gated by
 * two sequential checks before any command is dispatched:
 *
 * 1. **Rate limit** — 100 executions per minute (tumbling window).
 *    Enforced in-process by `services/rateLimit.ts`. A rate-limited
 *    call returns an error immediately without touching the permission
 *    layer.
 *
 * 2. **Permission check** — delegates to
 *    `plugin.checkCommandPermission(commandId)`, which in turn uses
 *    the existing command-permissions policy: master toggle +
 *    per-command allowlist + optional modal confirmation (Fase 2).
 *    Deny-by-default: if the user has not explicitly enabled command
 *    execution and/or pre-authorized the command, the call is denied.
 *
 * Only if both checks pass does the tool call
 * `app.commands.executeCommandById(commandId)`. A boolean `false`
 * return value from Obsidian means the command id is not registered in
 * the current vault, which surfaces as a "not found" error (not a
 * permission error).
 *
 * Error taxonomy:
 *  - `{ isError: true, content[0].text ~ /rate limit/ }` → window full
 *  - `{ isError: true, content[0].text ~ /denied|not allowed/ }` → permission denied
 *  - `{ isError: true, content[0].text ~ /not found/ }` → unknown command id
 *  - `{ content: [{ type: "text", text: "OK" }] }` → success
 */

import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import type { App } from "obsidian";
import type McpToolsPlugin from "$/main";
import { rateLimitTake } from "$/features/mcp-tools/services/rateLimit";

export const executeObsidianCommandSchema = type({
  name: '"execute_obsidian_command"',
  arguments: {
    commandId: type("string>0").describe(
      "Obsidian command id to execute, e.g. 'editor:toggle-bold'. Use list_obsidian_commands to discover available commands. The user must have authorized this command in plugin settings.",
    ),
  },
}).describe(
  "Execute a registered Obsidian command by id. Gated by the command-permissions policy (deny-by-default + per-command allowlist, with optional modal confirmation) and rate-limited at 100/min. Always call list_obsidian_commands first to discover what commands exist in the current vault.",
);

export type ExecuteObsidianCommandContext = {
  arguments: { commandId: string };
  app: App;
  plugin: McpToolsPlugin;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

/**
 * Handler for `execute_obsidian_command`.
 *
 * The permission check is delegated to `plugin.checkCommandPermission`,
 * which must be implemented on `McpToolsPlugin` and wired to the
 * existing command-permissions module. This indirection keeps the tool
 * handler decoupled from the Express/HTTP layer while preserving the
 * full two-phase mutex policy.
 */
export async function executeObsidianCommandHandler(
  ctx: ExecuteObsidianCommandContext,
): Promise<ToolResult> {
  // --- 1. Rate limit check ---
  const rl = rateLimitTake();
  if (!rl.ok) {
    const waitSec = Math.ceil((rl.retryAfterMs ?? 0) / 1000);
    return errorText(
      `Rate limit exceeded: too many command executions in the last minute. Retry in ${waitSec}s.`,
    );
  }

  // --- 2. Permission check ---
  // The plugin exposes checkCommandPermission() which runs the full
  // command-permissions policy: master toggle → allowlist fast-path →
  // modal slow-path. We access it via a cast because the method is
  // added to McpToolsPlugin in main.ts alongside this tool's
  // registration.
  const pluginWithPermCheck = ctx.plugin as unknown as {
    checkCommandPermission?: (
      commandId: string,
    ) => Promise<{ outcome: "allow" | "deny"; reason?: string }>;
  };

  if (typeof pluginWithPermCheck.checkCommandPermission !== "function") {
    return errorText(
      "Internal error: permission check not available on plugin.",
    );
  }

  const decision = await pluginWithPermCheck.checkCommandPermission(
    ctx.arguments.commandId,
  );

  if (decision.outcome !== "allow") {
    const reason = decision.reason
      ? `: ${decision.reason}`
      : ". Command is denied or not allowed by plugin settings.";
    return errorText(`Command denied${reason}`);
  }

  // --- 3. Execute ---
  // Obsidian's commands API is not in the public type surface — cast
  // through unknown to keep the rest of the file type-safe.
  const commandsApi = (
    ctx.app as unknown as {
      commands: { executeCommandById: (id: string) => boolean };
    }
  ).commands;

  const success = commandsApi.executeCommandById(ctx.arguments.commandId);

  if (!success) {
    return errorText(
      `Command not found: '${ctx.arguments.commandId}'. Use list_obsidian_commands to discover available commands.`,
    );
  }

  return successText(`Executed Obsidian command '${ctx.arguments.commandId}'.`);
}
