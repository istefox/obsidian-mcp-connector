import { type } from "arktype";
import { TFile, type App } from "obsidian";

export const getNoteOutlineSchema = type({
  name: '"get_note_outline"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the note."),
  },
}).describe(
  "Returns the structured heading outline of a note: level (1–6), heading text, 1-based line number, and an Obsidian-compatible anchor slug. Empty array when the note has no headings. Use the anchors to construct `[[note#heading]]` links. Reads from Obsidian's metadata cache (no file I/O). Always read-only.",
);

export type GetNoteOutlineContext = {
  arguments: { path: string };
  app: App;
};

function toAnchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

export async function getNoteOutlineHandler(
  ctx: GetNoteOutlineContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path } = ctx.arguments;
  const abstract = ctx.app.vault.getAbstractFileByPath(path);
  if (!abstract) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: `File not found: ${path}`,
              errorCode: "file_not_found",
              path,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  if (!(abstract instanceof TFile)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: `Path is a folder: ${path}`,
              errorCode: "not_a_file",
              path,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const cache = ctx.app.metadataCache.getFileCache(abstract);
  const raw = cache?.headings ?? [];

  const headings = raw.map((h) => ({
    level: h.level,
    text: h.heading,
    line_number: h.position.start.line + 1,
    anchor: toAnchor(h.heading),
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { path, heading_count: headings.length, headings },
          null,
          2,
        ),
      },
    ],
  };
}
