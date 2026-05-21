import { type } from "arktype";
import type { App } from "obsidian";

export const deleteVaultDirectorySchema = type({
  name: '"delete_vault_directory"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative directory path to delete (e.g. 'Archive/old-project'). Cannot be empty or the vault root.",
    ),
    "recursive?": type('"true" | "false"').describe(
      'When `"true"`, deletes the directory together with every file and sub-directory it contains. When `"false"` (default), the call fails if the directory is non-empty. Use `"true"` deliberately — this operation is irreversible from MCP and bypasses the trash setting.',
    ),
  },
}).describe(
  'Deletes a directory from the vault. Defaults to non-recursive (fails if the directory is not empty). Use `recursive: "true"` to remove the directory and all its contents in one call. Bottoms out in `app.vault.adapter.rmdir`, so deleted content does NOT go through the Obsidian trash.',
);

export type DeleteVaultDirectoryContext = {
  arguments: { path: string; recursive?: "true" | "false" };
  app: App;
};

export async function deleteVaultDirectoryHandler(
  ctx: DeleteVaultDirectoryContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const trimmed = ctx.arguments.path.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return {
      content: [
        {
          type: "text",
          text: "Path is empty after normalisation; refusing to delete the vault root.",
        },
      ],
      isError: true,
    };
  }

  const recursive = (ctx.arguments.recursive ?? "false") === "true";

  // Reject pointing at a file: this tool is for directories. The
  // sibling `delete_vault_file` covers files.
  const existing = ctx.app.vault.getAbstractFileByPath(trimmed);
  if (existing) {
    const isFolder =
      (existing as { children?: unknown }).children !== undefined;
    if (!isFolder) {
      return {
        content: [
          {
            type: "text",
            text: `Path ${trimmed} is a file, not a directory. Use delete_vault_file instead.`,
          },
        ],
        isError: true,
      };
    }
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
        ? 'directory not empty (use recursive: "true" to delete it together with its contents)'
        : errno === "ENOENT"
          ? "directory does not exist"
          : errno === "EACCES" || errno === "EPERM"
            ? "permission denied"
            : e instanceof Error
              ? e.message
              : String(e);
    return {
      content: [
        { type: "text", text: `Failed to delete directory ${trimmed}: ${msg}` },
      ],
      isError: true,
    };
  }

  return { content: [{ type: "text", text: "OK" }] };
}
