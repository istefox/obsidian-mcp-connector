import { type } from "arktype";
import type { App } from "obsidian";
import { buildFolderIndex, type FolderIndex } from "../services/folderIndex";
import {
  validateFolderPath,
  validateVisibleFolder,
} from "../services/folderValidation";
import { normalizeLimit } from "../services/pagination";
import { parentPath, trimSlashes } from "../services/pathUtils";
import { successText } from "../services/responseBuilders";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_FILE_NAMES = 2000;

export const getVaultTreeSchema = type({
  name: '"get_vault_tree"',
  arguments: {
    "path?": type("string").describe(
      "Optional vault-relative folder to use as the tree root. Empty/omitted = vault root.",
    ),
    "depth?": type("number.integer>=0").describe(
      "Maximum folder levels below the root. Omitted = the whole tree; 0 = root only. `totalFolders` still counts every descendant in scope when depth cuts the returned tree short.",
    ),
    "includeFiles?": type("boolean").describe(
      "When `true`, each folder node gets a `files` array of its direct child file names. At most 2000 names are returned across the tree; `filesTruncated` marks the cap.",
    ),
    "limit?": type("number>0").describe(
      "Maximum folder nodes returned, including the root (default 200, clamped to 1000).",
    ),
  },
}).describe(
  "Returns the folder hierarchy as a nested tree, including empty folders. `path` scopes to a subtree, `depth` limits levels, `includeFiles` adds direct file names (at most 2000; `filesTruncated` marks the cap). `limit` caps folder nodes; `truncated` reports it, and `totalFolders` counts every descendant even when `depth` cuts the tree. Read-only.",
);

export type GetVaultTreeContext = {
  arguments: {
    path?: string;
    depth?: number;
    includeFiles?: boolean;
    limit?: number;
  };
  app: App;
};

// No `name`: it is the last segment of `path`, and the full path is what
// the next tool call needs, so a nested name would only add tokens.
type TreeNode = {
  path: string;
  empty: boolean;
  children: TreeNode[];
  files?: string[];
};

type TreeOptions = {
  depth?: number;
  includeFiles: boolean;
  limit: number;
};

type TreeBudget = {
  remaining: number;
  truncated: boolean;
};

type FileNameBudget = {
  remaining: number;
  truncated: boolean;
};

type BuildContext = {
  index: FolderIndex;
  childrenByParent: Map<string, string[]>;
  depth?: number;
  includeFiles: boolean;
  budget: TreeBudget;
  fileNames: FileNameBudget;
};

type BuiltTree = {
  root: TreeNode;
  totalFolders: number;
  truncated: boolean;
  filesTruncated: boolean;
};

function normalizeDepth(depth?: number): number | undefined {
  return depth === undefined ? undefined : Math.max(0, Math.floor(depth));
}

function descendantsOf(folders: string[], root: string): string[] {
  if (root === "") return folders;

  const prefix = `${root}/`;
  return folders.filter((path) => path.startsWith(prefix));
}

function addChild(
  childrenByParent: Map<string, string[]>,
  parent: string,
  child: string,
): void {
  const children = childrenByParent.get(parent);
  if (children) children.push(child);
  else childrenByParent.set(parent, [child]);
}

function groupChildrenByParent(paths: string[]): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>();
  for (const path of paths) {
    addChild(childrenByParent, parentPath(path), path);
  }
  return childrenByParent;
}

function isEmptyFolder(index: FolderIndex, path: string): boolean {
  if (path === "")
    return index.folders.length === 0 && index.files.length === 0;
  return index.empty.has(path);
}

function createNode(path: string, ctx: BuildContext): TreeNode {
  const node: TreeNode = {
    path,
    empty: isEmptyFolder(ctx.index, path),
    children: [],
  };
  if (ctx.includeFiles) {
    const names = ctx.index.filesByFolder.get(path) ?? [];
    const take = Math.min(names.length, ctx.fileNames.remaining);
    if (take < names.length) ctx.fileNames.truncated = true;
    ctx.fileNames.remaining -= take;
    node.files = names.slice(0, take);
  }
  return node;
}

function consumeBudget(budget: TreeBudget): void {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return;
  }
  budget.remaining -= 1;
}

function buildNode(path: string, level: number, ctx: BuildContext): TreeNode {
  const node = createNode(path, ctx);
  consumeBudget(ctx.budget);

  if (ctx.depth !== undefined && level >= ctx.depth) return node;

  for (const childPath of ctx.childrenByParent.get(path) ?? []) {
    if (ctx.budget.remaining <= 0) {
      ctx.budget.truncated = true;
      break;
    }
    node.children.push(buildNode(childPath, level + 1, ctx));
  }

  return node;
}

function buildTree(
  index: FolderIndex,
  root: string,
  options: TreeOptions,
): BuiltTree {
  const descendants = descendantsOf(index.folders, root);
  const budget: TreeBudget = { remaining: options.limit, truncated: false };
  const fileNames: FileNameBudget = {
    remaining: MAX_FILE_NAMES,
    truncated: false,
  };
  const rootNode = buildNode(root, 0, {
    index,
    childrenByParent: groupChildrenByParent(descendants),
    depth: options.depth,
    includeFiles: options.includeFiles,
    budget,
    fileNames,
  });

  return {
    root: rootNode,
    totalFolders: descendants.length + 1,
    truncated: budget.truncated,
    filesTruncated: fileNames.truncated,
  };
}

export async function getVaultTreeHandler(ctx: GetVaultTreeContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const root = trimSlashes(ctx.arguments.path ?? "");

  const existenceError = validateFolderPath(ctx.app, root);
  if (existenceError) return existenceError;

  const index = buildFolderIndex(ctx.app);

  const visibilityError = validateVisibleFolder(index, root);
  if (visibilityError) return visibilityError;

  const tree = buildTree(index, root, {
    depth: normalizeDepth(ctx.arguments.depth),
    includeFiles: ctx.arguments.includeFiles ?? false,
    limit: normalizeLimit(ctx.arguments.limit, DEFAULT_LIMIT, MAX_LIMIT),
  });

  return successText(
    JSON.stringify({
      root: tree.root,
      totalFolders: tree.totalFolders,
      ...(tree.truncated ? { truncated: true } : {}),
      ...(tree.filesTruncated ? { filesTruncated: true } : {}),
    }),
  );
}
