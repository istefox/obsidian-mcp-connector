import { type } from "arktype";
import type { App, TFile } from "obsidian";

export const getNotePropertySchema = type({
  name: '"get_note_property"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path to the note (e.g. `Projects/Roadmap.md`).",
    ),
    key: type("string>0").describe("Top-level frontmatter (YAML) key to read."),
  },
}).describe(
  'Reads a single frontmatter (note property) value from a vault note, preserving its native YAML type (string, number, boolean, or list). Returns `value: null` when the key is absent or the note has no frontmatter — that is not an error. Reads from Obsidian\'s metadata cache (no file I/O). Always read-only. To read the whole frontmatter block, use `get_vault_file_partial` with `mode:"frontmatter"`.',
);

export type GetNotePropertyContext = {
  arguments: { path: string; key: string };
  app: App;
};

export async function getNotePropertyHandler(
  ctx: GetNotePropertyContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const abstract = ctx.app.vault.getAbstractFileByPath(ctx.arguments.path);
  if (!abstract) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "File not found",
              errorCode: "file_not_found",
              path: ctx.arguments.path,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  // A folder path resolves to a TFolder (duck-typed via `children`), not a
  // TFile — guard before casting so we don't read a folder as a note.
  if ((abstract as { children?: unknown }).children !== undefined) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "Path is a folder, not a file",
              errorCode: "not_a_file",
              path: ctx.arguments.path,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  const file = abstract as TFile;
  const fm = ctx.app.metadataCache.getFileCache(file)?.frontmatter as
    | Record<string, unknown>
    | undefined;
  const value =
    fm && Object.prototype.hasOwnProperty.call(fm, ctx.arguments.key)
      ? fm[ctx.arguments.key]
      : null;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            path: ctx.arguments.path,
            key: ctx.arguments.key,
            value: value ?? null,
          },
          null,
          2,
        ),
      },
    ],
  };
}
