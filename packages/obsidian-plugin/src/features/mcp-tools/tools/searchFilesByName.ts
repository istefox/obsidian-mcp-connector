import { type } from "arktype";
import {
  parseFrontMatterAliases,
  prepareFuzzySearch,
  sortSearchResults,
  type App,
  type SearchResult,
  type TFile,
} from "obsidian";
import { createExclusionFilter } from "$/shared/isUserIgnored";
import { buildObsidianUri } from "../services/buildObsidianUri";
import { NOTE_EXTENSIONS } from "../services/fileKind";
import { folderPrefix } from "../services/pathUtils";
import { errorJson, successJson } from "../services/responseBuilders";

export const searchFilesByNameSchema = type({
  name: '"search_files_by_name"',
  arguments: {
    query: type("string>0").describe(
      "What you would type in Obsidian's quick switcher: a fragment of a file name, path or alias. Fuzzy, case-insensitive, characters may be non-contiguous.",
    ),
    "folder?": type("string>0").describe(
      "Vault-relative folder. Only files under it (recursively) are candidates.",
    ),
    "includeAttachments?": type("boolean").describe(
      "When `true`, attachments (images, PDFs, ...) are candidates too. Default `false`: notes only (`.md`, `.canvas`, `.base`).",
    ),
    "limit?": type("1<=number.integer<=100").describe(
      "Maximum number of results (1-100, default 20).",
    ),
  },
}).describe(
  "Finds files by name like Obsidian's quick switcher: fuzzy match on file name, frontmatter `aliases` and full path, best first. Each hit has `path`, `basename`, `matchedOn`, `alias`, `score`, matched ranges and an `obsidian://` URI. Use it to resolve a half-remembered title to a path before `get_vault_file`; use `search_vault_simple` for content.",
);

export type SearchFilesByNameContext = {
  arguments: {
    query: string;
    folder?: string;
    includeAttachments?: boolean;
    limit?: number;
  };
  app: App;
};

type Hit = {
  match: SearchResult;
  file: TFile;
  matchedOn: "basename" | "alias" | "path";
  alias?: string;
};

export function fileAliases(
  frontmatter: Record<string, unknown> | undefined,
): string[] {
  return parseFrontMatterAliases(frontmatter ?? null) ?? [];
}

/** The best of the three candidate strings; basename and alias win ties over path. */
export function bestMatch(
  search: (text: string) => SearchResult | null,
  file: TFile,
  aliases: string[],
): Hit | null {
  let best: Hit | null = null;
  const consider = (
    text: string,
    matchedOn: Hit["matchedOn"],
    alias?: string,
  ): void => {
    const match = search(text);
    if (!match) return;
    if (best === null || match.score > best.match.score) {
      best = { match, file, matchedOn, ...(alias ? { alias } : {}) };
    }
  };
  consider(file.basename, "basename");
  for (const alias of aliases) consider(alias, "alias", alias);
  consider(file.path, "path");
  return best;
}

export async function searchFilesByNameHandler(
  ctx: SearchFilesByNameContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { query, folder, includeAttachments = false } = ctx.arguments;
  const limit = ctx.arguments.limit ?? 20;
  const search = prepareFuzzySearch(query.trim());
  const isUserIgnored = createExclusionFilter(ctx.app);
  const prefix = folderPrefix(folder);
  if (
    prefix !== null &&
    !ctx.app.vault.getAbstractFileByPath(prefix.slice(0, -1))
  ) {
    return errorJson(`Folder not found: ${folder}`, "folder_not_found", {
      path: folder,
    });
  }

  const hits: Hit[] = [];
  for (const file of ctx.app.vault.getFiles()) {
    if (
      !includeAttachments &&
      !NOTE_EXTENSIONS.has(file.extension.toLowerCase())
    )
      continue;
    if (prefix !== null && !file.path.startsWith(prefix)) continue;
    if (isUserIgnored(file.path)) continue;
    const frontmatter: Record<string, unknown> | undefined =
      file.extension === "md"
        ? ctx.app.metadataCache.getFileCache(file)?.frontmatter
        : undefined;
    const aliases = file.extension === "md" ? fileAliases(frontmatter) : [];
    const hit = bestMatch(search, file, aliases);
    if (hit) hits.push(hit);
  }

  // Obsidian's own ordering (score, then its tiebreakers), not a local
  // guess at what a higher or lower score means.
  sortSearchResults(hits);
  const total = hits.length;
  const page = hits.slice(0, limit);
  const vaultName = ctx.app.vault.getName();

  return successJson({
    query,
    total,
    ...(total > limit ? { truncated: true } : {}),
    results: page.map((h) => ({
      path: h.file.path,
      basename: h.file.basename,
      extension: h.file.extension,
      matchedOn: h.matchedOn,
      ...(h.alias ? { alias: h.alias } : {}),
      score: h.match.score,
      matches: h.match.matches,
      uri: buildObsidianUri(vaultName, h.file.path),
    })),
  });
}
