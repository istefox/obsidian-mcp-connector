import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import type { App } from "obsidian";
import { ensureFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";

export const createVaultDirectorySchema = type({
  name: '"create_vault_directory"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative directory path (e.g. 'Projects/2026/Q2'). Any missing intermediate ancestors are created. The leading and trailing slashes are tolerated but ignored.",
    ),
  },
}).describe(
  "Creates a directory at the given vault-relative path, recursively creating any missing parent directories. Idempotent — succeeds silently if the directory already exists.",
);

export type CreateVaultDirectoryContext = {
  arguments: { path: string };
  app: App;
};

export async function createVaultDirectoryHandler(
  ctx: CreateVaultDirectoryContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const trimmed = ctx.arguments.path.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return errorText("Path is empty after normalisation; cannot create the vault root.");
  }

  // If a file already exists at this path the request is ambiguous —
  // surface that explicitly rather than silently no-op'ing.
  const existing = ctx.app.vault.getAbstractFileByPath(trimmed);
  if (existing) {
    const isFolder =
      (existing as { children?: unknown }).children !== undefined;
    if (!isFolder) {
      return errorText(`A file already exists at ${trimmed}; cannot create directory with the same path.`);
    }
    return successText("OK");
  }

  await ensureFolderExists(ctx.app, trimmed);
  return successText("OK");
}
