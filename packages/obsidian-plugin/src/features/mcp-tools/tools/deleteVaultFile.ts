import { type } from "arktype";
import type { App } from "obsidian";
import { errorText, successText } from "../services/responseBuilders";

export const deleteVaultFileSchema = type({
  name: '"delete_vault_file"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path of the file to delete.",
    ),
  },
}).describe("Deletes a file from the vault.");

export type DeleteVaultFileContext = {
  arguments: { path: string };
  app: App;
};

export async function deleteVaultFileHandler(
  ctx: DeleteVaultFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const file = ctx.app.vault.getAbstractFileByPath(ctx.arguments.path);
  if (!file) {
    return errorText(`File not found: ${ctx.arguments.path}`);
  }
  await ctx.app.fileManager.trashFile(file);
  return successText("OK");
}
