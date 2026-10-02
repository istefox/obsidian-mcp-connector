import { type } from "arktype";
import { errorJson, successText } from "../services/responseBuilders";
import type { App } from "obsidian";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";
import { checkWholeFilePrecondition } from "$/features/mcp-tools/services/wholeFilePrecondition";
import { resolveRequireWritePreconditions } from "$/features/mcp-tools/services/writePreconditionSetting";
import type McpToolsPlugin from "$/main";

export const deleteActiveFileSchema = type({
  name: '"delete_active_file"',
  arguments: {
    "expectedContent?": type("string").describe(
      "The whole current content of the active note, as read via get_active_file. When it no longer matches, the delete is refused instead of removing a change you have not seen. Whitespace-insensitive. Mandatory if this vault requires write preconditions.",
    ),
  },
}).describe(
  "Deletes the currently active note from the vault, through the vault's 'Deleted files' setting. Optionally guarded by expectedContent.",
);

export type DeleteActiveFileContext = {
  arguments: { expectedContent?: string };
  app: App;
  /** Absent in partial test fixtures; the precondition setting then resolves to its default (off). */
  plugin?: McpToolsPlugin;
};

export async function deleteActiveFileHandler(
  ctx: DeleteActiveFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const requirePrecondition = await resolveRequireWritePreconditions(
    ctx.plugin,
  );
  return withVaultWriteLock(async () => {
    const file = ctx.app.workspace.getActiveFile();
    if (!file) {
      return errorJson("No active file.", "no_active_file");
    }
    if (ctx.arguments.expectedContent !== undefined || requirePrecondition) {
      const current =
        ctx.arguments.expectedContent !== undefined
          ? await ctx.app.vault.read(file)
          : "";
      const refusal = checkWholeFilePrecondition({
        action: "delete",
        currentContent: current,
        expectedContent: ctx.arguments.expectedContent,
        require: requirePrecondition,
        readTool: "get_active_file",
      });
      if (refusal) {
        return errorJson(refusal, "stale_precondition", { path: file.path });
      }
    }
    await ctx.app.fileManager.trashFile(file);
    return successText("OK");
  });
}
