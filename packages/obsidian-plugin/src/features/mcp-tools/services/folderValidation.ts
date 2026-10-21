import type { App } from "obsidian";
import type { FolderIndex } from "./folderIndex";
import { errorJson, type ToolResponse } from "./responseBuilders";

function isFolder(file: unknown): boolean {
  return (file as { children?: unknown } | null)?.children !== undefined;
}

export function folderNotFound(path: string): ToolResponse {
  return errorJson(`Folder not found: ${path}`, "folder_not_found", { path });
}

export function notADirectory(path: string): ToolResponse {
  return errorJson(
    `Path ${path} is a file, not a directory.`,
    "not_a_directory",
    {
      path,
    },
  );
}

export function validateFolderPath(
  app: App,
  path: string,
): ToolResponse | null {
  if (path === "") return null;

  const existing = app.vault.getAbstractFileByPath(path);
  if (!existing) return folderNotFound(path);
  if (!isFolder(existing)) return notADirectory(path);
  return null;
}

export function validateVisibleFolder(
  index: FolderIndex,
  path: string,
): ToolResponse | null {
  return path === "" || index.folderSet.has(path) ? null : folderNotFound(path);
}
