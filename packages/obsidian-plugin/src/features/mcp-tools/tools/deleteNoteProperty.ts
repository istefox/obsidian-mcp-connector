import { type } from "arktype";
import { errorJson, successJson } from "../services/responseBuilders";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";

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
  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson("File not found", "file_not_found", { path })
      : errorJson("Path is a folder, not a file", "not_a_file", { path });
  }
  const file = resolved.file;

  await ctx.app.fileManager.processFrontMatter(file, (rawFm) => {
    const fm = rawFm as Record<string, unknown>;
    delete fm[key];
  });

  return successJson({ path, key, action: "deleted" });
}
