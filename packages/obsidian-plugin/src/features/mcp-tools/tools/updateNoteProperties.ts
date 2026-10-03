import { type } from "arktype";
import type { App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";
import { coerceJsonEncodedArray, isInvalidKey } from "../services/propertyKeys";

const propertyValue = type(
  "string | number | boolean | string[] | number[] | null",
);

export const updateNotePropertiesSchema = type({
  name: '"update_note_properties"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the note."),
    "set?": type({ "[string]": propertyValue }).describe(
      "Keys to write with their values: string, number, boolean, homogeneous list of strings or numbers (dates as ISO 8601 strings), or `null` to remove that key. Existing keys are overwritten, others are left alone.",
    ),
    "remove?": type("string[]").describe(
      "Keys to remove. A key that is absent is skipped, not an error.",
    ),
  },
}).describe(
  'Sets and/or removes several frontmatter keys on one note in a single atomic `processFrontMatter` write: one call, one file version, one undo step, instead of a `set_note_property` call per key. Creates the frontmatter block if missing. Keys not named are untouched; to replace the whole block use `patch_vault_file` with `targetType: "frontmatter"`.',
);

export type PropertyValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | null;

export type UpdateNotePropertiesContext = {
  arguments: {
    path: string;
    set?: Record<string, PropertyValue>;
    remove?: string[];
  };
  app: App;
};

export async function updateNotePropertiesHandler(
  ctx: UpdateNotePropertiesContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path } = ctx.arguments;
  const set = ctx.arguments.set ?? {};
  const remove = ctx.arguments.remove ?? [];

  if (Object.keys(set).length === 0 && remove.length === 0) {
    return errorJson(
      "Nothing to do: pass at least one key in `set` or `remove`.",
      "invalid_params",
      { tool: "update_note_properties" },
    );
  }
  const invalid = [...Object.keys(set), ...remove].filter(isInvalidKey);
  if (invalid.length > 0) {
    return errorJson(
      `Invalid frontmatter key${invalid.length > 1 ? "s" : ""}: ${invalid
        .map((k) => JSON.stringify(k))
        .join(
          ", ",
        )}. A key cannot be empty, contain ":" or a newline, or start with "#".`,
      "invalid_key",
      { key: invalid[0], keys: invalid },
    );
  }

  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson("File not found", "file_not_found", { path })
      : errorJson("Path is a folder, not a file", "not_a_file", { path });
  }

  if (resolved.file.extension !== "md") {
    return errorJson(`Not a markdown file: ${path}`, "not_markdown", {
      path,
      targetType: "file",
    });
  }

  const written: string[] = [];
  const removed: string[] = [];
  const absent: string[] = [];
  let after: Record<string, unknown> = {};
  await ctx.app.fileManager.processFrontMatter(resolved.file, (rawFm) => {
    const fm = rawFm as Record<string, unknown>;
    // Removals first, so `set` wins when a key is named in both.
    for (const key of remove) {
      if (Object.prototype.hasOwnProperty.call(fm, key)) {
        delete fm[key];
        removed.push(key);
      } else {
        absent.push(key);
      }
    }
    for (const [key, value] of Object.entries(set)) {
      if (value === null) {
        if (Object.prototype.hasOwnProperty.call(fm, key)) {
          delete fm[key];
          removed.push(key);
        } else {
          absent.push(key);
        }
      } else {
        fm[key] = coerceJsonEncodedArray(value);
        written.push(key);
      }
    }
    const { position: _position, ...rest } = fm;
    after = rest;
  });

  return successJson({
    path,
    set: written,
    removed,
    ...(absent.length > 0 ? { notPresent: absent } : {}),
    frontmatter: after,
  });
}
