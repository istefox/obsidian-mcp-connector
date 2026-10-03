import { type } from "arktype";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson } from "../services/responseBuilders";
import { coerceJsonEncodedArray, isInvalidKey } from "../services/propertyKeys";

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
      "String, number, boolean, or homogeneous list of strings/numbers (dates as ISO 8601 strings). `null` removes the key. No mixed-type lists.",
    ),
  },
}).describe(
  'Sets one frontmatter key on a note atomically. Creates the frontmatter block if missing; `value: null` deletes the key. To replace the whole block use `patch_vault_file` with `targetType: "frontmatter"`.',
);

export type SetNotePropertyContext = {
  arguments: {
    path: string;
    key: string;
    value: string | number | boolean | string[] | number[] | null;
  };
  app: App;
};

export async function setNotePropertyHandler(
  ctx: SetNotePropertyContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, key, value } = ctx.arguments;

  if (isInvalidKey(key)) {
    return errorJson("Invalid frontmatter key", "invalid_key", { key });
  }

  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson("File not found", "file_not_found", { path })
      : errorJson("Path is a folder, not a file", "not_a_file", { path });
  }
  const file = resolved.file;

  if (file.extension !== "md") {
    return errorJson(`Not a markdown file: ${path}`, "not_markdown", {
      path,
      targetType: "file",
    });
  }

  await ctx.app.fileManager.processFrontMatter(file, (rawFm) => {
    const fm = rawFm as Record<string, unknown>;
    if (value === null) {
      delete fm[key];
    } else {
      fm[key] = coerceJsonEncodedArray(value);
    }
  });

  const action = value === null ? "deleted" : "set";
  return {
    content: [{ type: "text", text: JSON.stringify({ path, key, action }) }],
  };
}
