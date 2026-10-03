import { type } from "arktype";
import { TFile, type App } from "obsidian";
import { createExclusionFilter } from "$/shared/isUserIgnored";
import {
  countBacklinks,
  describeFileKind,
  NOTE_EXTENSIONS,
  readResolvedLinks,
} from "../services/fileKind";
import { comparePaths, folderPrefix } from "../services/pathUtils";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";

export const listAttachmentsSchema = type({
  name: '"list_attachments"',
  arguments: {
    "path?": type("string>0").describe(
      "Vault-relative path of one note. Only the attachments that note links to or embeds are returned, with the number of references from that note. Takes precedence over `folder`.",
    ),
    "folder?": type("string>0").describe(
      "Vault-relative folder. Only attachments stored under it (recursively) are returned.",
    ),
    "extensions?": type("string[]").describe(
      'Keep only these file extensions, case-insensitive, with or without the dot (e.g. ["png", ".pdf"]).',
    ),
    "unreferencedOnly?": type("boolean").describe(
      "When `true`, return only attachments no file in the vault links to or embeds: the candidates for cleanup. Ignored when `path` is set.",
    ),
    "sortBy?": type('"path"|"size"|"mtime"').describe(
      "Sort order: `path` ascending (default), `size` descending or `mtime` descending (most recent first). Ties fall back to path.",
    ),
    "offset?": type("number.integer>=0").describe(
      "Entries to skip before the first returned one (default 0), for paging.",
    ),
    "limit?": type("number>0").describe("Max results returned (default 200)."),
  },
}).describe(
  "Lists attachments (every file that is not a `.md`, `.canvas` or `.base` note: images, PDFs, audio, video, office documents, ...) across the vault, under one folder, or linked from one note. Each entry carries `path`, `extension`, `kind`, `mime`, `size`, `mtime`, and how many files reference it (`referencedBy`) with the total `references`. `unreferencedOnly` finds orphaned attachments; `totalBytes` sums the listed set. Files excluded in Obsidian's `Files & Links → Excluded files` are omitted. Read-only.",
);

export type ListAttachmentsContext = {
  arguments: {
    path?: string;
    folder?: string;
    extensions?: string[];
    unreferencedOnly?: boolean;
    sortBy?: "path" | "size" | "mtime";
    offset?: number;
    limit?: number;
  };
  app: App;
};

type Attachment = {
  path: string;
  extension: string;
  kind: string;
  mime: string;
  size: number;
  mtime: number;
  referencedBy: number;
  references: number;
};

export function isAttachment(file: TFile): boolean {
  return !NOTE_EXTENSIONS.has(file.extension.toLowerCase());
}

export async function listAttachmentsHandler(
  ctx: ListAttachmentsContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, folder, sortBy = "path" } = ctx.arguments;
  const limit = Math.min(
    1000,
    Math.max(1, Math.floor(ctx.arguments.limit ?? 200)),
  );
  const offset = Math.max(0, Math.floor(ctx.arguments.offset ?? 0));
  const extensions =
    ctx.arguments.extensions === undefined
      ? null
      : new Set(
          ctx.arguments.extensions
            .map((e) => e.trim().replace(/^\./, "").toLowerCase())
            .filter((e) => e.length > 0),
        );

  const isUserIgnored = createExclusionFilter(ctx.app);
  const resolvedLinks = readResolvedLinks(ctx.app.metadataCache);

  const describe = (
    file: TFile,
    refs: { files: number; references: number },
  ): Attachment => {
    const { kind, mime } = describeFileKind(file.extension);
    return {
      path: file.path,
      extension: file.extension,
      kind,
      mime,
      size: file.stat.size,
      mtime: file.stat.mtime,
      referencedBy: refs.files,
      references: refs.references,
    };
  };

  let attachments: Attachment[];
  let scope: Record<string, unknown>;

  if (path !== undefined) {
    const resolved = resolveTFile(ctx.app.vault, path);
    if (!resolved.ok) {
      return resolved.reason === "not_found"
        ? errorJson(`File not found: ${path}`, "file_not_found", { path })
        : errorJson(`Path is a folder, not a file: ${path}`, "not_a_file", {
            path,
          });
    }
    scope = { path: resolved.file.path };
    attachments = [];
    for (const [target, count] of Object.entries(
      resolvedLinks[resolved.file.path] ?? {},
    )) {
      if (count <= 0) continue;
      const hit = resolveTFile(ctx.app.vault, target);
      if (!hit.ok || !isAttachment(hit.file)) continue;
      if (isUserIgnored(hit.file.path)) continue;
      attachments.push(describe(hit.file, { files: 1, references: count }));
    }
  } else {
    const prefix = folderPrefix(folder);
    if (prefix !== null) {
      const dir = ctx.app.vault.getAbstractFileByPath(prefix.slice(0, -1));
      if (!dir) {
        return errorJson(`Folder not found: ${folder}`, "folder_not_found", {
          path: folder,
        });
      }
      if (dir instanceof TFile) {
        return errorJson(
          `Path is a file, not a folder: ${folder}`,
          "not_a_directory",
          {
            path: folder,
          },
        );
      }
    }
    scope = folder === undefined ? {} : { folder };
    // Only the vault-wide listing needs every file's backlink count.
    const backlinks = countBacklinks(resolvedLinks);
    attachments = ctx.app.vault
      .getFiles()
      .filter(isAttachment)
      .filter((f) => !isUserIgnored(f.path))
      .filter((f) => prefix === null || f.path.startsWith(prefix))
      .map((f) =>
        describe(f, backlinks.get(f.path) ?? { files: 0, references: 0 }),
      );
    if (ctx.arguments.unreferencedOnly) {
      attachments = attachments.filter((a) => a.referencedBy === 0);
    }
  }

  if (extensions !== null) {
    attachments = attachments.filter((a) =>
      extensions.has(a.extension.toLowerCase()),
    );
  }

  attachments.sort((a, b) => {
    if (sortBy === "size" && b.size !== a.size) return b.size - a.size;
    if (sortBy === "mtime" && b.mtime !== a.mtime) return b.mtime - a.mtime;
    return comparePaths(a.path, b.path);
  });

  const total = attachments.length;
  const totalBytes = attachments.reduce((sum, a) => sum + a.size, 0);
  const page = attachments.slice(offset, offset + limit);
  const truncated = offset + page.length < total;

  return successJson({
    ...scope,
    total,
    totalBytes,
    offset,
    ...(truncated ? { truncated: true } : {}),
    attachments: page,
  });
}
