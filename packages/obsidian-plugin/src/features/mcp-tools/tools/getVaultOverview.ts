import { type } from "arktype";
import { type App } from "obsidian";
import { successText } from "../services/responseBuilders";
import { getTagCounts } from "./listTags";
import { getSortedVisibleMarkdownFiles } from "./getRecentFiles";

const DEFAULT_TOP_TAGS_LIMIT = 20;
const DEFAULT_RECENT_FILES_LIMIT = 10;
const TOP_FOLDERS_CAP = 20;

export const getVaultOverviewSchema = type({
  name: '"get_vault_overview"',
  arguments: {
    "topTagsLimit?": type("1<=number.integer<=100").describe(
      "Max tags in topTags (default 20).",
    ),
    "recentFilesLimit?": type("1<=number.integer<=50").describe(
      "Max files in recentFiles (default 10).",
    ),
  },
}).describe(
  "One-call snapshot of the vault: active file, total note count, top-level folder distribution, top tags, and most recently modified notes. Cheaper than calling get_active_file, list_tags, and get_recent_files separately for situational awareness at the start of a task. A bounded snapshot, not a paginated listing — call list_tags/get_recent_files directly for more than the snapshot ceiling. Always read-only.",
);

export type GetVaultOverviewContext = {
  arguments: { topTagsLimit?: number; recentFilesLimit?: number };
  app: App;
};

/** Groups by top-level path segment; root-level files get "(root)". */
function topLevelFolder(path: string): string {
  const idx = path.indexOf("/");
  return idx === -1 ? "(root)" : path.slice(0, idx);
}

export async function getVaultOverviewHandler(
  ctx: GetVaultOverviewContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const topTagsLimit = ctx.arguments.topTagsLimit ?? DEFAULT_TOP_TAGS_LIMIT;
  const recentFilesLimit =
    ctx.arguments.recentFilesLimit ?? DEFAULT_RECENT_FILES_LIMIT;

  const compareName = (a: string, b: string): number =>
    a.localeCompare(b, "en", { sensitivity: "variant" });

  const activeFile = ctx.app.workspace.getActiveFile()?.path ?? null;

  const markdownFiles = ctx.app.vault.getMarkdownFiles();
  const totalNotes = markdownFiles.length;

  const folderCounts = new Map<string, number>();
  for (const f of markdownFiles) {
    const folder = topLevelFolder(f.path);
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
  }
  const topFolders = Array.from(folderCounts, ([folder, count]) => ({
    folder,
    count,
  }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return compareName(a.folder, b.folder);
    })
    .slice(0, TOP_FOLDERS_CAP);

  const topTags = getTagCounts(ctx.app)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return compareName(a.tag, b.tag);
    })
    .slice(0, topTagsLimit);

  const recentFiles = getSortedVisibleMarkdownFiles(ctx.app)
    .slice(0, recentFilesLimit)
    .map((f) => ({
      path: f.path,
      mtime: f.stat.mtime,
      ctime: f.stat.ctime,
      size: f.stat.size,
    }));

  const output = {
    activeFile,
    totalNotes,
    topFolders,
    topTags,
    recentFiles,
  };

  return successText(JSON.stringify(output));
}
