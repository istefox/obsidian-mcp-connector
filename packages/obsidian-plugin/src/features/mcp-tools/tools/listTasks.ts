import { type } from "arktype";
import type { App, TFile } from "obsidian";
import { createExclusionFilter } from "$/shared/isUserIgnored";
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
    "limit?": type("1<=number.integer<=1000").describe(
      "Maximum number of tasks to return (1-1000, default 200). `truncated: true` says the vault has more.",
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

const comparePath = (a: string, b: string): number =>
  a.localeCompare(b, "en", { sensitivity: "variant" });

export async function listTasksHandler(ctx: ListTasksContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, folder } = ctx.arguments;
  const wanted = ctx.arguments.status ?? "all";
  const limit = ctx.arguments.limit ?? 200;

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
    const prefix =
      folder === undefined ? null : `${folder.replace(/^\/+|\/+$/g, "")}/`;
    files = ctx.app.vault
      .getMarkdownFiles()
      .filter((f) => !isUserIgnored(f.path))
      .filter((f) => prefix === null || f.path.startsWith(prefix))
      .sort((a, b) => comparePath(a.path, b.path));
    if (prefix !== null && files.length === 0) {
      const dir = ctx.app.vault.getAbstractFileByPath(prefix.slice(0, -1));
      if (!dir) {
        return errorJson(`Folder not found: ${folder}`, "folder_not_found", {
          path: folder,
        });
      }
    }
  }

  const tasks: TaskEntry[] = [];
  let total = 0;
  for (const file of files) {
    const cache = ctx.app.metadataCache.getFileCache(file);
    const items = (cache as { listItems?: ListItemLike[] } | null)?.listItems;
    if (!items?.length) continue;
    const taskItems = items.filter((i) => i.task !== undefined);
    if (taskItems.length === 0) continue;

    // One read per file that has tasks: the cache knows the line, not
    // the text. `cachedRead` is the cheap path for a read-only tool.
    const lines = (await ctx.app.vault.cachedRead(file)).split("\n");
    for (const item of taskItems) {
      const line = item.position.start.line;
      const parsed = parseTaskLine(lines[line] ?? "");
      // The cache is authoritative for "is a task"; the line is the
      // source of truth for text and marker. A line the parser cannot
      // read (cache a beat behind an edit) falls back to the cache's
      // marker and the trimmed line.
      const marker = parsed?.marker ?? item.task ?? " ";
      const status = taskStatus(marker);
      if (wanted !== "all" && status !== wanted) continue;
      total++;
      if (tasks.length >= limit) continue;
      tasks.push({
        path: file.path,
        line,
        status,
        marker,
        text: parsed?.text.trimEnd() ?? (lines[line] ?? "").trim(),
        ...(item.parent !== undefined && item.parent >= 0
          ? { parentLine: item.parent }
          : {}),
      });
    }
  }

  return successJson({
    status: wanted,
    ...(path !== undefined ? { path } : {}),
    ...(folder !== undefined && path === undefined ? { folder } : {}),
    totalTasks: total,
    ...(total > tasks.length ? { truncated: true } : {}),
    tasks,
  });
}
