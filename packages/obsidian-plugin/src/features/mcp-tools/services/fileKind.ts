import { MIME_BY_EXT, TEXT_EXTENSIONS } from "../tools/getVaultFile";

/**
 * Coarse file classification shared by `get_file_info` and
 * `list_attachments`. `MIME_BY_EXT` already owns the image/audio table
 * `get_vault_file` reads binaries with; this adds the text, document and
 * video kinds that only need naming, never decoding.
 */
export type FileKind =
  | "markdown"
  | "canvas"
  | "base"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "document"
  | "archive"
  | "binary";

const TEXT_MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  xml: "application/xml",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  canvas: "application/json",
  base: "application/yaml",
};

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
};

const DOCUMENT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
};

const ARCHIVE_MIME: Record<string, string> = {
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
};

/** File extensions Obsidian treats as notes rather than attachments. */
export const NOTE_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "canvas",
  "base",
]);

export function describeFileKind(extension: string): {
  kind: FileKind;
  mime: string;
} {
  const ext = extension.toLowerCase();
  if (ext === "md") return { kind: "markdown", mime: TEXT_MIME.md };
  if (ext === "canvas") return { kind: "canvas", mime: TEXT_MIME.canvas };
  if (ext === "base") return { kind: "base", mime: TEXT_MIME.base };
  const media = MIME_BY_EXT.get(ext);
  if (media) return { kind: media.kind, mime: media.mime };
  if (TEXT_EXTENSIONS.has(ext)) {
    return { kind: "text", mime: TEXT_MIME[ext] ?? "text/plain" };
  }
  if (ext in VIDEO_MIME) return { kind: "video", mime: VIDEO_MIME[ext] };
  if (ext === "pdf") return { kind: "pdf", mime: DOCUMENT_MIME.pdf };
  if (ext in DOCUMENT_MIME)
    return { kind: "document", mime: DOCUMENT_MIME[ext] };
  if (ext in ARCHIVE_MIME) return { kind: "archive", mime: ARCHIVE_MIME[ext] };
  return { kind: "binary", mime: "application/octet-stream" };
}

/**
 * Inverts `metadataCache.resolvedLinks` once: for every link target, how
 * many distinct files point at it and how many references they hold in
 * total. Cheap (one pass over the cache) and shared by both tools so a
 * vault-wide listing does not re-walk the cache per file.
 */
export function countBacklinks(
  resolvedLinks: Record<string, Record<string, number>>,
): Map<string, { files: number; references: number }> {
  const out = new Map<string, { files: number; references: number }>();
  for (const targets of Object.values(resolvedLinks)) {
    for (const [target, count] of Object.entries(targets)) {
      if (count <= 0) continue;
      const entry = out.get(target) ?? { files: 0, references: 0 };
      entry.files += 1;
      entry.references += count;
      out.set(target, entry);
    }
  }
  return out;
}

/**
 * The backlink count of ONE file: the same figure `countBacklinks` holds for
 * it, without building the vault-wide map to read a single entry.
 */
export function countBacklinksFor(
  resolvedLinks: Record<string, Record<string, number>>,
  target: string,
): { files: number; references: number } {
  let files = 0;
  let references = 0;
  for (const targets of Object.values(resolvedLinks)) {
    const count = targets[target] ?? 0;
    if (count <= 0) continue;
    files += 1;
    references += count;
  }
  return { files, references };
}

export function readResolvedLinks(
  metadataCache: unknown,
): Record<string, Record<string, number>> {
  return (
    (
      metadataCache as {
        resolvedLinks?: Record<string, Record<string, number>>;
      }
    ).resolvedLinks ?? {}
  );
}

export function readUnresolvedLinks(
  metadataCache: unknown,
): Record<string, Record<string, number>> {
  return (
    (
      metadataCache as {
        unresolvedLinks?: Record<string, Record<string, number>>;
      }
    ).unresolvedLinks ?? {}
  );
}
