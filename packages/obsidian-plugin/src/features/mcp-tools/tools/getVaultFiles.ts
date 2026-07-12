import { type } from "arktype";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";
import { TEXT_EXTENSIONS, readVaultFileAsJson } from "./getVaultFile";

const MAX_PATHS = 20;

export const getVaultFilesSchema = type({
  name: '"get_vault_files"',
  arguments: {
    paths: type("string[]").describe(
      `Vault-relative paths to read, 1-${MAX_PATHS} per call. More than ${MAX_PATHS} is rejected.`,
    ),
    "format?": type('"text"|"json"').describe(
      'Applied uniformly to every path. "text" returns raw content; "json" returns content + frontmatter + tags + stat per file (same shape as get_vault_file). Default: text.',
    ),
  },
}).describe(
  "Reads up to 20 vault text/markdown files in one call, returning one result per input path in the same order. A bad path never fails the whole call: missing files, folders, and binary files each produce a per-entry error instead. Binary files (images, audio, PDFs, etc.) are not supported here regardless of `format` — use get_vault_file to read one individually.",
);

export type GetVaultFilesContext = {
  arguments: { paths: string[]; format?: "text" | "json" };
  app: App;
};

type FileResult =
  | { path: string; content: string }
  | (Awaited<ReturnType<typeof readVaultFileAsJson>> & { path: string })
  | {
      path: string;
      error: string;
      reason: "not_found" | "not_a_file" | "binary_unsupported";
    };

export async function getVaultFilesHandler(ctx: GetVaultFilesContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}> {
  const { paths, format } = ctx.arguments;

  if (paths.length === 0) {
    return errorJson(
      "paths must contain at least 1 entry.",
      "invalid_arguments",
      {
        received: 0,
      },
    );
  }
  if (paths.length > MAX_PATHS) {
    return errorJson(
      `paths must contain at most ${MAX_PATHS} entries (got ${paths.length}).`,
      "too_many_paths",
      { max: MAX_PATHS, received: paths.length },
    );
  }

  const results: FileResult[] = [];

  for (const path of paths) {
    const resolved = resolveTFile(ctx.app.vault, path);
    if (!resolved.ok) {
      results.push({
        path,
        error:
          resolved.reason === "not_found"
            ? `File not found: ${path}`
            : `Path is a folder: ${path}`,
        reason: resolved.reason,
      });
      continue;
    }

    const file = resolved.file;
    const ext = file.extension.toLowerCase();
    const isText = TEXT_EXTENSIONS.has(ext) || !ext;
    if (!isText) {
      results.push({
        path: file.path,
        error: `File is binary and not supported by get_vault_files: ${file.path}. Use get_vault_file to read it individually.`,
        reason: "binary_unsupported",
      });
      continue;
    }

    if (format === "json") {
      const json = await readVaultFileAsJson(ctx.app, file);
      results.push(json);
    } else {
      const content = await ctx.app.vault.read(file);
      results.push({ path: file.path, content });
    }
  }

  return successJson({ results });
}
