import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { normalizeAppendBody } from "$/features/mcp-tools/services/patchHelpers";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";

export const appendToVaultFileSchema = type({
  name: '"append_to_vault_file"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path. Any missing parent directories are created automatically when the file does not exist.",
    ),
    content: type("string").describe("Markdown content to append."),
  },
}).describe(
  "Appends content to a vault file. Creates the file (and any missing parent directories) if it does not exist.",
);

export type AppendToVaultFileContext = {
  arguments: { path: string; content: string };
  app: App;
};

export async function appendToVaultFileHandler(
  ctx: AppendToVaultFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const normalized = normalizeAppendBody(ctx.arguments.content, "append");

  // Whole write path under the vault write lock: the exists-check and
  // the create are two steps (TOCTOU between concurrent MCP requests),
  // so resolution must happen INSIDE the critical section.
  return withVaultWriteLock(async () => {
    const resolved = resolveTFile(ctx.app.vault, ctx.arguments.path);

    if (resolved.ok) {
      // Atomic read-modify-write: a concurrent writer (another MCP
      // request slipping past the lock boundary in a future refactor,
      // the editor, sync) can no longer interleave between our read
      // and our write and get its update silently discarded.
      await ctx.app.vault.process(
        resolved.file,
        (current) => current + normalized,
      );
    } else if (resolved.reason === "not_a_file") {
      return errorText(`Path ${ctx.arguments.path} is a folder, not a file.`);
    } else {
      await ensureParentFolderExists(ctx.app, ctx.arguments.path);
      await ctx.app.vault.create(ctx.arguments.path, normalized);
    }
    return successText("OK");
  });
}
