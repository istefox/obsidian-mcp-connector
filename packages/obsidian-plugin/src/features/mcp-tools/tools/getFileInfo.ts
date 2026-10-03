import { type } from "arktype";
import type { App } from "obsidian";
import { buildObsidianUri } from "../services/buildObsidianUri";
import {
  countBacklinksFor,
  describeFileKind,
  readResolvedLinks,
  readUnresolvedLinks,
} from "../services/fileKind";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";

export const getFileInfoSchema = type({
  name: '"get_file_info"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the file."),
  },
}).describe(
  "Describes a file without reading its body: name, extension, `kind` (markdown, canvas, image, audio, video, pdf, text, binary, ...), MIME type, size, `ctime`/`mtime`, an `obsidian://` URI, how many files link to it (`backlinks.files` / `backlinks.references`) and how many links it holds (`outgoingLinks.resolved` / `unresolved`). For markdown notes `markdown` adds counts from the metadata cache: frontmatter keys, headings, inline tags, links, embeds, list items and tasks (open/done). Read-only, metadata cache only; use `get_vault_file` for the content.",
);

export type GetFileInfoContext = {
  arguments: { path: string };
  app: App;
};

type FrontmatterCache = Record<string, unknown> & {
  position?: unknown;
};

function countFrontmatterTags(
  frontmatter: FrontmatterCache | undefined,
): number {
  if (!frontmatter) return 0;
  let n = 0;
  for (const key of ["tags", "tag"]) {
    const value = frontmatter[key];
    if (Array.isArray(value)) n += value.filter((v) => v != null).length;
    else if (typeof value === "string") {
      n += value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0).length;
    }
  }
  return n;
}

export async function getFileInfoHandler(ctx: GetFileInfoContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path } = ctx.arguments;
  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(`File not found: ${path}`, "file_not_found", { path })
      : errorJson(`Path is a folder, not a file: ${path}`, "not_a_file", {
          path,
        });
  }
  const file = resolved.file;
  const { kind, mime } = describeFileKind(file.extension);

  const resolvedLinks = readResolvedLinks(ctx.app.metadataCache);
  const unresolvedLinks = readUnresolvedLinks(ctx.app.metadataCache);
  const backlinks = countBacklinksFor(resolvedLinks, file.path);
  const sum = (record: Record<string, number> | undefined): number =>
    Object.values(record ?? {}).reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const outgoingLinks = {
    resolved: sum(resolvedLinks[file.path]),
    unresolved: sum(unresolvedLinks[file.path]),
  };

  let markdown: Record<string, unknown> | null = null;
  if (kind === "markdown") {
    const cache = ctx.app.metadataCache.getFileCache(file);
    const raw: FrontmatterCache | undefined = cache?.frontmatter;
    const { position: _position, ...frontmatter } = raw ?? {};
    const listItems = cache?.listItems ?? [];
    const tasks = listItems.filter((i) => typeof i.task === "string");
    markdown = {
      hasFrontmatter: raw !== undefined,
      frontmatterKeys: Object.keys(frontmatter).length,
      headings: cache?.headings?.length ?? 0,
      tags: (cache?.tags?.length ?? 0) + countFrontmatterTags(raw),
      links: cache?.links?.length ?? 0,
      embeds: cache?.embeds?.length ?? 0,
      listItems: listItems.length,
      tasks: {
        total: tasks.length,
        open: tasks.filter((i) => i.task === " ").length,
        done: tasks.filter((i) => i.task !== " ").length,
      },
    };
  }

  return successJson({
    path: file.path,
    name: file.name,
    basename: file.basename,
    extension: file.extension,
    kind,
    mime,
    size: file.stat.size,
    ctime: file.stat.ctime,
    mtime: file.stat.mtime,
    uri: buildObsidianUri(ctx.app.vault.getName(), file.path),
    backlinks,
    outgoingLinks,
    markdown,
  });
}
