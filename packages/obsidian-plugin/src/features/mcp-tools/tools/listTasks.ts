import { type } from "arktype";
import type { App, TFile } from "obsidian";
import { createExclusionFilter } from "$/shared/isUserIgnored";
import { comparePaths, folderPrefix } from "../services/pathUtils";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";
import { parseTaskLine, taskStatus } from "../services/taskLine";

export const listTasksSchema = type({
  name: '"list_tasks"',
  arguments: {
    "path?": type("string>0").describe(
      "Vault-relative path of one markdown file. Only its tasks are returned.",
    ),
    "folder?": type("string>0").describe(
      "Vault-relative folder. Only tasks in files under it (recursively) are returned. Ignored when `path` is set.",
    ),
    "status?": type('"open" | "done" | "all"').describe(
      "`open` = `[ ]` only; `done` = any other marker (`[x]`, `[/]`, `[-]`, ...); `all` (default) = both.",
    ),
    "offset?": type("number.integer>=0").describe(
      "Tasks to skip before the first returned one (default 0), for paging. Combine with `limit` and `totalTasks`.",
    ),
    "limit?": type("1<=number.integer<=1000").describe(
      "Maximum number of tasks to return (1-1000, default 200). `truncated: true` says more follow the returned page.",
    ),
  },
}).describe(
  "Lists markdown tasks (`- [ ]`, `- [x]`, `- [/]`, ...) across the vault, one file or one folder, from Obsidian's metadata cache. Each task carries `path`, 0-indexed `line`, `status`, the raw `marker` character, the task `text`, and `parentLine` for a nested task. Ordered by path then line. Read-only; use the `line` with `set_task_status` to tick or untick one.",
);

export type ListTasksContext = {
  arguments: {
    path?: string;
    folder?: string;
    status?: "open" | "done" | "all";
    offset?: number;
    limit?: number;
  };
  app: App;
};

export type TaskEntry = {
  path: string;
  line: number;
  status: "open" | "done";
  marker: string;
  text: string;
  /** 0-indexed line of the parent list item, absent for a top-level task. */
  parentLine?: number;
};

type ListItemLike = {
  task?: string;
  parent?: number;
  position: { start: { line: number } };
};

export async function listTasksHandler(ctx: ListTasksContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, folder } = ctx.arguments;
  const wanted = ctx.arguments.status ?? "all";
  const limit = ctx.arguments.limit ?? 200;
  const offset = ctx.arguments.offset ?? 0;

  let files: TFile[];
  if (path !== undefined) {
    const resolved = resolveTFile(ctx.app.vault, path);
    if (!resolved.ok) {
      return resolved.reason === "not_found"
        ? errorJson(`File not found: ${path}`, "file_not_found", { path })
        : errorJson(`Path is a folder: ${path}`, "not_a_file", { path });
    }
    if (resolved.file.extension !== "md") {
      return errorJson(
        `Not a markdown file: ${path}. Tasks are read from Obsidian's metadata cache, which only indexes markdown.`,
        "not_markdown",
        { path, targetType: "file" },
      );
    }
    files = [resolved.file];
  } else {
    // Obsidian's own `Files & Links -> Excluded files` is honoured here,
    // like `get_recent_files`; the hidden-folder policy (ADR-0020) is
    // enforced underneath, on the guarded `App` this already is.
    const isUserIgnored = createExclusionFilter(ctx.app);
    const prefix = folderPrefix(folder);
    files = ctx.app.vault
      .getMarkdownFiles()
      .filter((f) => !isUserIgnored(f.path))
      .filter((f) => prefix === null || f.path.startsWith(prefix))
      .sort((a, b) => comparePaths(a.path, b.path));
    if (prefix !== null && files.length === 0) {
      const dir = ctx.app.vault.getAbstractFileByPath(prefix.slice(0, -1));
      if (!dir) {
        return errorJson(`Folder not found: ${folder}`, "folder_not_found", {
          path: folder,
        });
      }
    }
  }

  // Select the page from the metadata cache alone: it already carries each
  // task's marker, so the total needs no file read. Only the files that own
  // a task on the requested page are then read for their text.
  const selected: Array<{ file: TFile; item: ListItemLike; line: number }> = [];
  for (const file of files) {
    const cache = ctx.app.metadataCache.getFileCache(file);
    const items = (cache as { listItems?: ListItemLike[] } | null)?.listItems;
    if (!items?.length) continue;
    for (const item of items) {
      if (item.task === undefined) continue;
      if (wanted !== "all" && taskStatus(item.task) !== wanted) continue;
      selected.push({ file, item, line: item.position.start.line });
    }
  }

  const total = selected.length;
  const page = selected.slice(offset, offset + limit);
  const linesByPath = new Map<string, string[]>();
  const tasks: TaskEntry[] = [];
  for (const { file, item, line } of page) {
    let lines = linesByPath.get(file.path);
    if (lines === undefined) {
      // `cachedRead` is the cheap path for a read-only tool.
      lines = (await ctx.app.vault.cachedRead(file)).split("\n");
      linesByPath.set(file.path, lines);
    }
    const parsed = parseTaskLine(lines[line] ?? "");
    // The cache is authoritative for "is a task"; the line is the source of
    // truth for text and marker. A line the parser cannot read (cache a beat
    // behind an edit) falls back to the cache's marker and the trimmed line.
    const marker = parsed?.marker ?? item.task ?? " ";
    tasks.push({
      path: file.path,
      line,
      status: taskStatus(marker),
      marker,
      text: parsed?.text.trimEnd() ?? (lines[line] ?? "").trim(),
      ...(item.parent !== undefined && item.parent >= 0
        ? { parentLine: item.parent }
        : {}),
    });
  }

  return successJson({
    status: wanted,
    ...(path !== undefined ? { path } : {}),
    ...(folder !== undefined && path === undefined ? { folder } : {}),
    totalTasks: total,
    offset,
    ...(offset + tasks.length < total ? { truncated: true } : {}),
    tasks,
  });
}
