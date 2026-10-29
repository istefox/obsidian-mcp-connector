import type { App } from "obsidian";
import { createExclusionFilter } from "$/shared/isUserIgnored";
import { comparePaths, parentPath, pathName } from "./pathUtils";

export type FolderIndex = {
  folders: string[];
  folderSet: Set<string>;
  empty: Set<string>;
  files: string[];
  filesByFolder: Map<string, string[]>;
};

type ExclusionFilter = (path: string) => boolean;

function appendTo(
  map: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const current = map.get(key);
  if (current) current.push(value);
  else map.set(key, [value]);
}

function addAncestors(path: string, target: Set<string>): void {
  let parent = parentPath(path);
  while (parent !== "") {
    target.add(parent);
    parent = parentPath(parent);
  }
}

function addSelfAndAncestors(path: string, target: Set<string>): void {
  target.add(path);
  addAncestors(path, target);
}

function isExcludedEntry(
  path: string,
  isExcluded: ExclusionFilter,
  isFolder: boolean,
): boolean {
  return isExcluded(path) || (isFolder && isExcluded(`${path}/`));
}

function isExcludedWithAncestors(
  path: string,
  isExcluded: ExclusionFilter,
  isFolder: boolean,
): boolean {
  if (isExcludedEntry(path, isExcluded, isFolder)) return true;

  let parent = parentPath(path);
  while (parent !== "") {
    if (isExcludedEntry(parent, isExcluded, true)) return true;
    parent = parentPath(parent);
  }
  return false;
}

function collectVisibleFiles(app: App, isExcluded: ExclusionFilter): string[] {
  return app.vault
    .getFiles()
    .map((file) => file.path)
    .filter((path) => !isExcludedWithAncestors(path, isExcluded, false));
}

function collectVisibleFolders(
  app: App,
  isExcluded: ExclusionFilter,
): string[] {
  return app.vault
    .getAllFolders()
    .map((folder) => folder.path)
    .filter(
      (path) => path !== "" && !isExcludedWithAncestors(path, isExcluded, true),
    )
    .sort(comparePaths);
}

function groupFileNamesByFolder(files: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const file of files) {
    const folder = parentPath(file);
    appendTo(grouped, folder, pathName(file));
  }
  for (const names of grouped.values()) names.sort(comparePaths);
  return grouped;
}

function collectNonEmptyFolders(
  files: string[],
  folders: string[],
): Set<string> {
  const nonEmpty = new Set<string>();

  for (const file of files) {
    const folder = parentPath(file);
    if (folder !== "") addSelfAndAncestors(folder, nonEmpty);
  }
  for (const folder of folders) addAncestors(folder, nonEmpty);

  return nonEmpty;
}

function collectEmptyFolders(
  folders: string[],
  nonEmpty: Set<string>,
): Set<string> {
  const empty = new Set<string>();
  for (const folder of folders) {
    if (!nonEmpty.has(folder)) empty.add(folder);
  }
  return empty;
}

export function buildFolderIndex(app: App): FolderIndex {
  const isExcluded = createExclusionFilter(app);
  const files = collectVisibleFiles(app, isExcluded);
  const folders = collectVisibleFolders(app, isExcluded);
  const nonEmpty = collectNonEmptyFolders(files, folders);

  return {
    folders,
    folderSet: new Set(folders),
    empty: collectEmptyFolders(folders, nonEmpty),
    files,
    filesByFolder: groupFileNamesByFolder(files),
  };
}
