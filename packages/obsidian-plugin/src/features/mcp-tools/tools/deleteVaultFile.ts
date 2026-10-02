import { type } from "arktype";
import { TFile, type App } from "obsidian";
import {
  errorJson,
  errorText,
  successText,
} from "../services/responseBuilders";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";
import { checkWholeFilePrecondition } from "$/features/mcp-tools/services/wholeFilePrecondition";
import { resolveRequireWritePreconditions } from "$/features/mcp-tools/services/writePreconditionSetting";
import type McpToolsPlugin from "$/main";

export const deleteVaultFileSchema = type({
  name: '"delete_vault_file"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path of the file to delete. Must be a file: a folder path is refused, use delete_vault_directory for folders.",
    ),
    "expectedContent?": type("string").describe(
      "The whole current content of the file, as read via get_vault_file. When it no longer matches, the delete is refused instead of removing a change you have not seen. Whitespace-insensitive. Mandatory if this vault requires write preconditions.",
    ),
  },
}).describe(
  "Deletes a file from the vault, through the vault's 'Deleted files' setting (trash or permanent). Refuses folders. Optionally guarded by expectedContent.",
);

export type DeleteVaultFileContext = {
  arguments: { path: string; expectedContent?: string };
  app: App;
  /** Absent in partial test fixtures; the precondition setting then resolves to its default (off). */
  plugin?: McpToolsPlugin;
};

export async function deleteVaultFileHandler(
  ctx: DeleteVaultFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const requirePrecondition = await resolveRequireWritePreconditions(
    ctx.plugin,
  );

  // Resolve → compare → trash is a multi-step operation against concurrent
  // MCP writers, so it runs under the vault write lock like every other
  // writer (vaultWriteLock.ts).
  return withVaultWriteLock(async () => {
    const file = ctx.app.vault.getAbstractFileByPath(ctx.arguments.path);
    if (!file) {
      return errorText(`File not found: ${ctx.arguments.path}`);
    }
    // `getAbstractFileByPath` resolves folders too, and `trashFile` accepts
    // any TAbstractFile — so without this guard a folder path would trash a
    // whole directory, bypassing delete_vault_directory's `recursive` guard.
    if (!(file instanceof TFile)) {
      return errorJson(
        `Path ${ctx.arguments.path} is a folder, not a file. Use delete_vault_directory to delete a folder.`,
        "not_a_file",
        { path: ctx.arguments.path },
      );
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
        readTool: "get_vault_file",
      });
      if (refusal) {
        return errorJson(refusal, "stale_precondition", {
          path: ctx.arguments.path,
        });
      }
    }
    await ctx.app.fileManager.trashFile(file);
    return successText("OK");
  });
}
