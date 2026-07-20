import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import { TFile, type App } from "obsidian";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";

export const createVaultFileSchema = type({
  name: '"create_vault_file"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path including extension (e.g. 'Notes/new.md'). Any missing parent directories are created automatically.",
    ),
    content: type("string").describe(
      "Full content of the file. If the path already exists, the content is overwritten.",
    ),
  },
}).describe(
  "Creates a new file at the given vault-relative path. Overwrites the file if it already exists. Missing parent directories along the path are created automatically.",
);

export type CreateVaultFileContext = {
  arguments: { path: string; content: string };
  app: App;
};

export async function createVaultFileHandler(
  ctx: CreateVaultFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  // Exists-check → create is a two-step TOCTOU against concurrent MCP
  // writes, so the whole branch runs under the vault write lock (see
  // vaultWriteLock.ts). The overwrite branch stays a plain modify: this
  // tool's contract is a blind full-content overwrite, so there is no
  // read-modify-write to make atomic.
  return withVaultWriteLock(async () => {
    const existing = ctx.app.vault.getAbstractFileByPath(ctx.arguments.path);
    if (existing) {
      if (!(existing instanceof TFile)) {
        return errorText(`Path ${ctx.arguments.path} is a folder, not a file.`);
      }
      await ctx.app.vault.modify(existing, ctx.arguments.content);
    } else {
      await ensureParentFolderExists(ctx.app, ctx.arguments.path);
      await ctx.app.vault.create(ctx.arguments.path, ctx.arguments.content);
    }
    return successText("OK");
  });
}
