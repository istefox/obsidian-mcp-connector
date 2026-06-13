import { type } from "arktype";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";

/**
 * Maps lowercased file extensions to their MIME type and MCP content-block
 * kind. Audio and image extensions that can be returned as native MCP content
 * blocks are listed here; everything else (video, PDF, Office, archives) is
 * absent and falls back to the JSON metadata hint.
 *
 * Kept in sync with BINARY_EXTENSION_MIME_TYPES in packages/mcp-server.
 */
const MIME_BY_EXT: ReadonlyMap<
  string,
  { mime: string; kind: "image" | "audio" }
> = new Map([
  // Image — all map to the "image" MCP content-block kind
  ["png", { mime: "image/png", kind: "image" }],
  ["jpg", { mime: "image/jpeg", kind: "image" }],
  ["jpeg", { mime: "image/jpeg", kind: "image" }],
  ["gif", { mime: "image/gif", kind: "image" }],
  ["webp", { mime: "image/webp", kind: "image" }],
  ["svg", { mime: "image/svg+xml", kind: "image" }],
  ["bmp", { mime: "image/bmp", kind: "image" }],
  ["tiff", { mime: "image/tiff", kind: "image" }],
  ["tif", { mime: "image/tiff", kind: "image" }],
  ["ico", { mime: "image/x-icon", kind: "image" }],
  ["avif", { mime: "image/avif", kind: "image" }],
  ["heic", { mime: "image/heic", kind: "image" }],
  ["heif", { mime: "image/heif", kind: "image" }],
  // Audio — all map to the "audio" MCP content-block kind
  ["mp3", { mime: "audio/mpeg", kind: "audio" }],
  ["wav", { mime: "audio/wav", kind: "audio" }],
  ["m4a", { mime: "audio/mp4", kind: "audio" }],
  ["ogg", { mime: "audio/ogg", kind: "audio" }],
  ["opus", { mime: "audio/opus", kind: "audio" }],
  ["flac", { mime: "audio/flac", kind: "audio" }],
  ["aac", { mime: "audio/aac", kind: "audio" }],
  ["wma", { mime: "audio/x-ms-wma", kind: "audio" }],
]);

/**
 * Upper bound on raw byte size for inline binary content. Base64 encoding
 * inflates the payload by ~33%, so a 10 MiB cap means ~13.3 MiB on the wire.
 * Files larger than this return the JSON metadata hint instead.
 */
const INLINE_BYTE_CAP = 10 * 1024 * 1024; // 10 MiB

/**
 * Known text extensions that should be read with vault.read() and returned as
 * a plain text content block. Extensions not in this set AND not in MIME_BY_EXT
 * are treated as unsupported binary.
 */
const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "csv",
  "json",
  "yaml",
  "yml",
  "html",
  "xml",
  "css",
  "js",
  "ts",
  "canvas",
]);

export const getVaultFileSchema = type({
  name: '"get_vault_file"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the file."),
    "format?": type('"text"|"json"').describe(
      'Force output format. "text" returns raw content; "json" returns content + frontmatter + tags as a structured object. Default: auto-detect by extension.',
    ),
  },
}).describe(
  "Reads a file from the vault. Markdown and other text files return a text content block. Supported image and audio files up to 10 MiB are returned as native MCP image/audio content blocks. Video, PDF, Office documents, archives, and oversized audio/image files return a structured JSON metadata hint.",
);

export type GetVaultFileContext = {
  arguments: { path: string; format?: "text" | "json" };
  app: App;
};

/**
 * Encode an ArrayBuffer as a base64 string using the browser-compatible
 * btoa() built-in. Avoids a Node.js Buffer dependency so the same code
 * runs inside the Obsidian plugin (renderer process / Bun test runtime).
 */
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // Build the binary string in 8 KiB chunks to stay within the call-stack
  // limit imposed by some JS engines when spreading large arrays.
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type AudioBlock = { type: "audio"; data: string; mimeType: string };
type ContentBlock = TextBlock | ImageBlock | AudioBlock;

export async function getVaultFileHandler(ctx: GetVaultFileContext): Promise<{
  content: Array<ContentBlock>;
  isError?: boolean;
}> {
  const resolved = resolveTFile(ctx.app.vault, ctx.arguments.path);
  if (!resolved.ok) {
    return {
      content: [
        {
          type: "text",
          text:
            resolved.reason === "not_found"
              ? `File not found: ${ctx.arguments.path}`
              : `Path is a folder: ${ctx.arguments.path}`,
        },
      ],
      isError: true,
    };
  }

  const file = resolved.file;
  const ext = file.extension.toLowerCase();

  const mimeEntry = MIME_BY_EXT.get(ext);

  // ── JSON format ────────────────────────────────────────────────────────────
  // Explicit format=json: read text content and attach metadata regardless of
  // extension. Shape: ApiNoteJson contract:
  // `{ path, content, frontmatter, tags, stat: { ctime, mtime, size } }`.
  // The `stat` field was missing in the initial 0.4.0 port — folotp flagged
  // the drift between the description and the actual response.
  if (ctx.arguments.format === "json") {
    const text = await ctx.app.vault.read(file);
    const cache = ctx.app.metadataCache.getFileCache(file);
    const frontmatter = (cache?.frontmatter as Record<string, unknown>) ?? {};
    const tags = Array.isArray(frontmatter.tags)
      ? (frontmatter.tags as string[])
      : [];
    const stat = {
      ctime: file.stat?.ctime ?? 0,
      mtime: file.stat?.mtime ?? 0,
      size: file.stat?.size ?? 0,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            path: file.path,
            content: text,
            frontmatter,
            tags,
            stat,
          }),
        },
      ],
    };
  }

  // ── Text content ───────────────────────────────────────────────────────────
  // No MIME entry means the extension is either a known text type or an unknown
  // binary that we cannot embed natively. Check the text-extension set first.
  if (!mimeEntry || ctx.arguments.format === "text") {
    if (TEXT_EXTENSIONS.has(ext) || !ext || ctx.arguments.format === "text") {
      // For explicit format=text or known text extensions, read as string.
      // If the extension is completely unknown and format is not forced, fall
      // through to the unsupported-binary branch below via the mimeEntry check.
      const text = await ctx.app.vault.read(file);
      return { content: [{ type: "text", text }] };
    }

    // Extension is known-binary (video, PDF, archive…) but has no native MCP
    // content-block kind → return JSON metadata hint.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            kind: "binary_file",
            filename: file.path,
            mimeType: "application/octet-stream",
            hint: "This file is binary (video, PDF, Office document, or archive) and cannot be returned as text content. Use show_file_in_obsidian to open it in the Obsidian UI.",
          }),
        },
      ],
    };
  }

  // ── Supported binary (image / audio) ───────────────────────────────────────
  const buf = await ctx.app.vault.readBinary(file);

  // Size gate — fall back to metadata hint rather than blowing the context window.
  if (buf.byteLength > INLINE_BYTE_CAP) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            kind: "binary_file",
            filename: file.path,
            mimeType: mimeEntry.mime,
            hint: "This file is too large to be returned inline (exceeds the 10 MiB cap to avoid overflowing the MCP client context window). Use show_file_in_obsidian to open it in the Obsidian UI.",
          }),
        },
      ],
    };
  }

  const data = bufToBase64(buf);

  if (mimeEntry.kind === "image") {
    return {
      content: [{ type: "image", data, mimeType: mimeEntry.mime }],
    };
  }

  return {
    content: [{ type: "audio", data, mimeType: mimeEntry.mime }],
  };
}
