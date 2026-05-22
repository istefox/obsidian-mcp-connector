import { type } from "arktype";
import type { App, TFile } from "obsidian";

export const setNotePropertySchema = type({
  name: '"set_note_property"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the note."),
    key: type("string>0").describe(
      "Top-level frontmatter (YAML) key to set. Must not contain `:`, a newline, or a leading `#`.",
    ),
    value: type(
      "string | number | boolean | string[] | number[] | null",
    ).describe(
      "Value to set. Native JSON types map to YAML: string, number, boolean, or a homogeneous list of strings/numbers. Dates are passed as ISO 8601 strings. Passing `null` removes the key (same as `delete_note_property`). Mixed-type lists are not supported — use `patch_vault_file` for those.",
    ),
  },
}).describe(
  'Sets a single frontmatter (note property) key on a vault note via Obsidian\'s atomic `processFrontMatter` API (no read-modify-write race). Creates the frontmatter block if the note has none. Passing `value: null` deletes the key. Coexists with `patch_vault_file targetType:"frontmatter"`, which replaces the entire block; this tool is for single-key edits.',
);

export type SetNotePropertyContext = {
  arguments: {
    path: string;
    key: string;
    value: string | number | boolean | string[] | number[] | null;
  };
  app: App;
};

// YAML-illegal in a plain top-level key: a colon, any newline, or a leading
// `#` (comment marker).
function isInvalidKey(key: string): boolean {
  return /[:\n\r]/.test(key) || key.trimStart().startsWith("#");
}

export async function setNotePropertyHandler(
  ctx: SetNotePropertyContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, key, value } = ctx.arguments;

  if (isInvalidKey(key)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "Invalid frontmatter key", errorCode: "invalid_key", key },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

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
    if (value === null) {
      delete fm[key];
    } else {
      fm[key] = value;
    }
  });

  const action = value === null ? "deleted" : "set";
  return {
    content: [
      { type: "text", text: JSON.stringify({ path, key, action }, null, 2) },
    ],
  };
}
