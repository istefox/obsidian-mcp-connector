import { type } from "arktype";
import {
  errorText,
  successJson,
  successText,
} from "../services/responseBuilders";
import type { App, TAbstractFile } from "obsidian";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";

/** How many descendant paths a dry run lists before truncating. */
const DRY_RUN_SAMPLE_LIMIT = 50;

export const deleteVaultDirectorySchema = type({
  name: '"delete_vault_directory"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative directory path to delete (e.g. 'Archive/old-project'). Cannot be empty or the vault root.",
    ),
    "recursive?": type("boolean").describe(
      "When `true`, deletes the directory together with every file and sub-directory it contains. When `false` (default), the call fails if the directory is non-empty. Use `true` deliberately.",
    ),
    "dry_run?": type("boolean").describe(
      "When `true`, nothing is deleted: returns the count of files and sub-directories the call would remove, with a sample of their paths. Default false. Preview a recursive delete with this first.",
    ),
    "trash?": type("boolean").describe(
      "When `true`, the directory goes through the vault's 'Deleted files' setting (system trash or .trash/) via fileManager.trashFile, so it can be recovered. Default false: permanent removal via adapter.rmdir, as before.",
    ),
  },
}).describe(
  "Deletes a directory from the vault. Defaults to non-recursive (fails if the directory is not empty). Use `recursive: true` to remove the directory and all its contents in one call, `dry_run: true` to preview what would be removed, and `trash: true` to route the delete through the vault's trash setting instead of a permanent `adapter.rmdir`.",
);

export type DeleteVaultDirectoryContext = {
  arguments: {
    path: string;
    recursive?: boolean;
    dry_run?: boolean;
    trash?: boolean;
  };
  app: App;
};

export async function deleteVaultDirectoryHandler(
  ctx: DeleteVaultDirectoryContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  const trimmed = ctx.arguments.path.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return errorText(
      "Path is empty after normalisation; refusing to delete the vault root.",
    );
  }

  const recursive = ctx.arguments.recursive ?? false;
  const dryRun = ctx.arguments.dry_run ?? false;
  const useTrash = ctx.arguments.trash ?? false;

  // Reject pointing at a file: this tool is for directories. The
  // sibling `delete_vault_file` covers files.
  const existing = ctx.app.vault.getAbstractFileByPath(trimmed);
  if (existing) {
    const isFolder =
      (existing as { children?: unknown }).children !== undefined;
    if (!isFolder) {
      return errorText(
        `Path ${trimmed} is a file, not a directory. Use delete_vault_file instead.`,
      );
    }
  }

  // Descendants as the vault index knows them. Both lists are what the
  // delete would remove; computed up front so the dry run and the
  // non-recursive refusal share one view of the directory.
  const prefix = `${trimmed}/`;
  const files = ctx.app.vault
    .getFiles()
    .map((f) => f.path)
    .filter((p) => p.startsWith(prefix))
    .sort();
  const folders = ctx.app.vault
    .getAllFolders()
    .map((f) => f.path)
    .filter((p) => p.startsWith(prefix))
    .sort();

  if (dryRun) {
    if (!existing) {
      return errorText(
        `Failed to delete directory ${trimmed}: directory does not exist`,
      );
    }
    const nonEmpty = files.length + folders.length > 0;
    return successJson({
      dryRun: true,
      path: trimmed,
      recursive,
      wouldDelete: recursive || !nonEmpty,
      reason:
        !recursive && nonEmpty
          ? "directory not empty (use recursive: true to delete it together with its contents)"
          : undefined,
      fileCount: files.length,
      folderCount: folders.length,
      files: files.slice(0, DRY_RUN_SAMPLE_LIMIT),
      truncated: files.length > DRY_RUN_SAMPLE_LIMIT,
    });
  }

  // The exists/non-empty checks and the delete are one logical operation
  // against concurrent MCP writers (a sibling could create a file inside the
  // directory between them), so the whole branch holds the write lock.
  return withVaultWriteLock(async () => {
    if (useTrash) {
      const folder = ctx.app.vault.getAbstractFileByPath(trimmed);
      if (!folder) {
        return errorText(
          `Failed to delete directory ${trimmed}: directory does not exist`,
        );
      }
      if (!recursive && files.length + folders.length > 0) {
        return errorText(
          `Failed to delete directory ${trimmed}: directory not empty (use recursive: true to delete it together with its contents)`,
        );
      }
      try {
        await ctx.app.fileManager.trashFile(folder as TAbstractFile);
      } catch (e) {
        return errorText(
          `Failed to delete directory ${trimmed}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return successText("OK");
    }

    try {
      await (
        ctx.app.vault.adapter as unknown as {
          rmdir: (path: string, recursive: boolean) => Promise<void>;
        }
      ).rmdir(trimmed, recursive);
    } catch (e: unknown) {
      // Map known Node fs errno codes to vault-relative messages so the
      // raw Node "rmdir '<absolute-host-path>'" trailer never reaches the
      // MCP client (it would expose $HOME / cloud-sync identifiers / vault
      // folder name). Unknown errors fall through to the original shape.
      const errno = (e as NodeJS.ErrnoException | undefined)?.code;
      const msg =
        errno === "ENOTEMPTY"
          ? "directory not empty (use recursive: true to delete it together with its contents)"
          : errno === "ENOENT"
            ? "directory does not exist"
            : errno === "EACCES" || errno === "EPERM"
              ? "permission denied"
              : e instanceof Error
                ? e.message
                : String(e);
      return {
        content: [
          {
            type: "text",
            text: `Failed to delete directory ${trimmed}: ${msg}`,
          },
        ],
        isError: true,
      };
    }

    return successText("OK");
  });
}
