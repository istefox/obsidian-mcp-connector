import { type } from "arktype";
import { errorJson } from "../services/responseBuilders";
import type { App, TAbstractFile } from "obsidian";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";

export const renameVaultFileSchema = type({
  name: '"rename_vault_file"',
  arguments: {
    from: type("string>0").describe(
      "Vault-relative path of the source file, including extension (e.g. 'Notes/old.md').",
    ),
    to: type("string>0").describe(
      "Vault-relative destination path, including extension (e.g. 'Notes/new.md'). Parent directory must already exist — missing ancestors are NOT auto-created.",
    ),
  },
}).describe(
  "Renames or moves a vault file or folder via app.fileManager.renameFile, preserving link integrity (wikilinks, markdown links, embeds, and frontmatter aliases referencing the file are rewritten across the vault). Source must exist, destination must not exist, destination parent directory must already exist.",
);

export type RenameVaultFileContext = {
  arguments: { from: string; to: string };
  app: App;
};

export async function renameVaultFileHandler(
  ctx: RenameVaultFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { from, to } = ctx.arguments;

  if (from === to) {
    return errorJson(
      `Source and destination are identical: ${from}`,
      "same_path",
      { from, to },
    );
  }

  // Three existence checks followed by the rename are one logical operation
  // against concurrent MCP writers (TOCTOU on the destination), so the whole
  // path holds the vault write lock like every other writer.
  return withVaultWriteLock(async () => {
    const source = ctx.app.vault.getAbstractFileByPath(from);
    if (!source) {
      return errorJson(`Source file not found: ${from}`, "file_not_found", {
        path: from,
      });
    }

    if (ctx.app.vault.getAbstractFileByPath(to)) {
      return errorJson(`Destination already exists: ${to}`, "already_exists", {
        path: to,
      });
    }

    // Fail-loud on missing destination parent. Mirrors the bias established
    // for unresolved targets in patch_*_file (#6, #58) — auto-creating the
    // parent here would silently mask caller mistakes (typos in the
    // destination path) and leave orphan directories behind.
    const slash = to.lastIndexOf("/");
    if (slash > 0) {
      const parent = to.slice(0, slash);
      if (!ctx.app.vault.getAbstractFileByPath(parent)) {
        return errorJson(
          `Destination parent directory does not exist: ${parent}`,
          "folder_not_found",
          { path: parent },
        );
      }
    }

    // Delegate to fileManager so wikilinks, markdown links, embeds, and
    // frontmatter aliases pointing at the source file are rewritten
    // atomically across the vault. `fileManager` is on `App` at runtime
    // but absent from the published type signature, hence the cast.
    try {
      await (
        ctx.app.fileManager as unknown as {
          renameFile: (file: TAbstractFile, newPath: string) => Promise<void>;
        }
      ).renameFile(source, to);
    } catch (e) {
      return errorJson(
        `Failed to rename: ${e instanceof Error ? e.message : String(e)}`,
        "rename_failed",
        { from, to },
      );
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, path: to }) }],
    };
  });
}
