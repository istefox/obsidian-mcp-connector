import { type } from "arktype";
import type { App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";

export const getNotePropertiesSchema = type({
  name: '"get_note_properties"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the note."),
  },
}).describe(
  "Reads the whole frontmatter (all note properties) of a note as one JSON object, native YAML types preserved, from Obsidian's metadata cache. `frontmatter: null` when the note has none; that is not an error. Cheaper than one `get_note_property` call per key.",
);

export type GetNotePropertiesContext = {
  arguments: { path: string };
  app: App;
};

export async function getNotePropertiesHandler(
  ctx: GetNotePropertiesContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path } = ctx.arguments;
  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson("File not found", "file_not_found", { path })
      : errorJson("Path is a folder, not a file", "not_a_file", { path });
  }
  const raw = ctx.app.metadataCache.getFileCache(resolved.file)?.frontmatter as
    | Record<string, unknown>
    | undefined;
  // Older Obsidian builds kept a `position` entry inside the cache object;
  // it is cache bookkeeping, not a property the user wrote.
  const { position: _position, ...frontmatter } = raw ?? {};
  const keys = Object.keys(frontmatter);
  return successJson({
    path,
    frontmatter: raw === undefined ? null : frontmatter,
    keys,
  });
}
