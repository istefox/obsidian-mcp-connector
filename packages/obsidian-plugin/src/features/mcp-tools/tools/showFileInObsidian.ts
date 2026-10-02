import { type } from "arktype";
import { errorJson, successText } from "../services/responseBuilders";
import type { App } from "obsidian";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";

export const showFileInObsidianSchema = type({
  name: '"show_file_in_obsidian"',
  arguments: {
    filename: type("string>0").describe(
      "Vault-relative path (e.g. 'Notes/foo.md') of an existing file.",
    ),
    "newLeaf?": type("boolean").describe(
      "Open in a new leaf (split) instead of the active one. Default false.",
    ),
    "createIfMissing?": type("boolean").describe(
      "When true, an empty file is created at the path if none exists, then opened. Default false: a missing file is a file_not_found error, nothing is written.",
    ),
  },
}).describe(
  "Opens the given file in the Obsidian UI. Read-only by default: a missing file is an error unless createIfMissing is true. Optionally opens in a new leaf (split).",
);

export type ShowFileInObsidianContext = {
  arguments: { filename: string; newLeaf?: boolean; createIfMissing?: boolean };
  app: App;
};

export async function showFileInObsidianHandler(
  ctx: ShowFileInObsidianContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { filename, newLeaf, createIfMissing } = ctx.arguments;
  // `openLinkText` creates a missing target as a side effect, which is why
  // the tool used to write to the vault while annotated read-only. Resolve
  // existence first so the default path never writes.
  if (!ctx.app.vault.getAbstractFileByPath(filename)) {
    if (!createIfMissing) {
      return errorJson(
        `File not found: ${filename}. Pass createIfMissing: true to create an empty file at this path and open it.`,
        "file_not_found",
        { path: filename },
      );
    }
    await withVaultWriteLock(async () => {
      if (ctx.app.vault.getAbstractFileByPath(filename)) return;
      await ensureParentFolderExists(ctx.app, filename);
      await ctx.app.vault.create(filename, "");
    });
  }
  await ctx.app.workspace.openLinkText(filename, "", newLeaf ?? false);
  return successText("File opened successfully");
}
