import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { App } from "obsidian";

export const listVaultFilesSchema = type({
  name: '"list_vault_files"',
  arguments: {
    "directory?": type("string").describe(
      "Optional vault-relative directory prefix. Empty/omitted = vault root (all files).",
    ),
    "limit?": type("number>0").describe("Max results returned (default 200)."),
  },
}).describe(
  "Lists vault files, optionally filtered by directory prefix. Returns an array of vault-relative paths.",
);

export type ListVaultFilesContext = {
  arguments: { directory?: string; limit?: number };
  app: App;
};

export async function listVaultFilesHandler(
  ctx: ListVaultFilesContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const all = ctx.app.vault.getFiles();
  let prefix = ctx.arguments.directory ?? "";
  // Normalize trailing slash so "Notes" and "Notes/" behave identically
  if (prefix && !prefix.endsWith("/")) prefix = prefix + "/";

  const files = prefix
    ? all.filter((f) => f.path.startsWith(prefix)).map((f) => f.path)
    : all.map((f) => f.path);

  const limit = Math.min(
    1000,
    Math.max(1, Math.floor(ctx.arguments.limit ?? 200)),
  );
  const truncated = files.length > limit;

  return successText(
    JSON.stringify({
      files: truncated ? files.slice(0, limit) : files,
      ...(truncated ? { truncated: true, total: files.length } : {}),
    }),
  );
}
