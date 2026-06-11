import { type } from "arktype";
import { errorText } from "../services/responseBuilders";
import type { App, TAbstractFile } from "obsidian";

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
  "Renames or moves a vault file via app.fileManager.renameFile, preserving link integrity (wikilinks, markdown links, embeds, and frontmatter aliases referencing the file are rewritten across the vault). Source must exist, destination must not exist, destination parent directory must already exist.",
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
    return {
      content: [
        { type: "text", text: `Source and destination are identical: ${from}` },
      ],
      isError: true,
    };
  }

  const source = ctx.app.vault.getAbstractFileByPath(from);
  if (!source) {
    return errorText(`Source file not found: ${from}`);
  }

  if (ctx.app.vault.getAbstractFileByPath(to)) {
    return errorText(`Destination already exists: ${to}`);
  }

  // Fail-loud on missing destination parent. Mirrors the bias established
  // for unresolved targets in patch_*_file (#6, #58) — auto-creating the
  // parent here would silently mask caller mistakes (typos in the
  // destination path) and leave orphan directories behind.
  const slash = to.lastIndexOf("/");
  if (slash > 0) {
    const parent = to.slice(0, slash);
    if (!ctx.app.vault.getAbstractFileByPath(parent)) {
      return errorText(`Destination parent directory does not exist: ${parent}`);
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
    return errorText(`Failed to rename: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    content: [
      { type: "text", text: JSON.stringify({ ok: true, path: to }, null, 2) },
    ],
  };
}
