import { type } from "arktype";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson } from "../services/responseBuilders";

export const getNoteOutlineSchema = type({
  name: '"get_note_outline"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the note."),
  },
}).describe(
  "Returns the structured heading outline of a note: level (1–6), heading text, 1-based line number, and the literal heading text as the link anchor. Empty array when the note has no headings. Use the anchors to construct `[[note#heading]]` links. Reads from Obsidian's metadata cache (no file I/O). Always read-only.",
);

export type GetNoteOutlineContext = {
  arguments: { path: string };
  app: App;
};

export async function getNoteOutlineHandler(
  ctx: GetNoteOutlineContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path } = ctx.arguments;
  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(`File not found: ${path}`, "file_not_found", { path })
      : errorJson(`Path is a folder: ${path}`, "not_a_file", { path });
  }
  const abstract = resolved.file;

  const cache = ctx.app.metadataCache.getFileCache(abstract);
  const raw = cache?.headings ?? [];

  const headings = raw.map((h) => {
    const text = h.heading.trim();
    return {
      level: h.level,
      text,
      line_number: h.position.start.line + 1,
      anchor: text,
    };
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          path,
          heading_count: headings.length,
          headings,
        }),
      },
    ],
  };
}
