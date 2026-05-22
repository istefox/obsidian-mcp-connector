import { type } from "arktype";
import type { App, TFile } from "obsidian";

export const deleteNotePropertySchema = type({
  name: '"delete_note_property"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the note."),
    key: type("string>0").describe(
      "Top-level frontmatter (YAML) key to remove.",
    ),
  },
}).describe(
  "Removes a single frontmatter (note property) key from a vault note via Obsidian's atomic `processFrontMatter` API. Idempotent: deleting a key that is absent (or a note with no frontmatter) succeeds as a no-op. To clear a key you can also call `set_note_property` with `value: null`.",
);

export type DeleteNotePropertyContext = {
  arguments: { path: string; key: string };
  app: App;
};

export async function deleteNotePropertyHandler(
  ctx: DeleteNotePropertyContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, key } = ctx.arguments;
  const abstract = ctx.app.vault.getAbstractFileByPath(path);
  if (!abstract) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "File not found", errorCode: "file_not_found", path },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  if ((abstract as { children?: unknown }).children !== undefined) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "Path is a folder, not a file",
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
  const file = abstract as TFile;

  await ctx.app.fileManager.processFrontMatter(file, (fm) => {
    delete fm[key];
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ path, key, action: "deleted" }, null, 2),
      },
    ],
  };
}
