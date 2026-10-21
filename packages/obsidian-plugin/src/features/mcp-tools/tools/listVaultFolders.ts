import { type } from "arktype";
import type { App } from "obsidian";
import { buildFolderIndex } from "../services/folderIndex";
import {
  validateFolderPath,
  validateVisibleFolder,
} from "../services/folderValidation";
import {
  normalizeLimit,
  normalizeOffset,
  paginate,
} from "../services/pagination";
import { trimSlashes } from "../services/pathUtils";
import { successText } from "../services/responseBuilders";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export const listVaultFoldersSchema = type({
  name: '"list_vault_folders"',
  arguments: {
    "directory?": type("string").describe(
      "Optional vault-relative directory. Empty/omitted = vault root.",
    ),
    "recursive?": type("boolean").describe(
      "When `true`, return every descendant folder. When `false` (default), return only direct children.",
    ),
    "offset?": type("number.integer>=0").describe(
      "Folders to skip before the returned page (default 0).",
    ),
    "limit?": type("number>0").describe(
      "Max folders returned (default 200, clamped to 1000).",
    ),
  },
}).describe(
  "Lists vault folders, including empty ones. `directory` scopes to a subtree; `recursive` (default false) returns every descendant, otherwise only direct children. Each entry has `path` and `empty`. Supports `offset`/`limit`; `truncated` and `total` describe the page. Read-only.",
);

export type ListVaultFoldersContext = {
  arguments: {
    directory?: string;
    recursive?: boolean;
    offset?: number;
    limit?: number;
  };
  app: App;
};

type FolderEntry = {
  path: string;
  empty: boolean;
};

function isInsideDirectory(path: string, directory: string): boolean {
  return directory === "" || path.startsWith(`${directory}/`);
}

function isDirectChildOf(path: string, directory: string): boolean {
  if (directory === "") return !path.includes("/");

  const prefix = `${directory}/`;
  return path.startsWith(prefix) && !path.includes("/", prefix.length);
}

function selectFolders(
  folders: string[],
  directory: string,
  recursive: boolean,
): string[] {
  const belongs = recursive ? isInsideDirectory : isDirectChildOf;
  return folders.filter((path) => belongs(path, directory));
}

function toFolderEntries(paths: string[], empty: Set<string>): FolderEntry[] {
  return paths.map((path) => ({ path, empty: empty.has(path) }));
}

export async function listVaultFoldersHandler(
  ctx: ListVaultFoldersContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const directory = trimSlashes(ctx.arguments.directory ?? "");
  const recursive = ctx.arguments.recursive ?? false;

  const existenceError = validateFolderPath(ctx.app, directory);
  if (existenceError) return existenceError;

  const index = buildFolderIndex(ctx.app);

  const visibilityError = validateVisibleFolder(index, directory);
  if (visibilityError) return visibilityError;

  const scoped = selectFolders(index.folders, directory, recursive);
  const result = paginate(
    scoped,
    normalizeOffset(ctx.arguments.offset),
    normalizeLimit(ctx.arguments.limit, DEFAULT_LIMIT, MAX_LIMIT),
  );

  return successText(
    JSON.stringify({
      folders: toFolderEntries(result.page, index.empty),
      total: result.total,
      offset: result.offset,
      ...(result.truncated ? { truncated: true } : {}),
    }),
  );
}
