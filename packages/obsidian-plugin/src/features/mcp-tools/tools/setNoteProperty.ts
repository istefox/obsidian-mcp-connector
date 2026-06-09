import { type } from "arktype";
import { TFile, type App } from "obsidian";

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

// LLM clients (e.g. Claude) sometimes send arrays as JSON-encoded strings
// ('["a","b"]') rather than native JSON arrays (["a","b"]) when constructing
// tool calls. Detect and unwrap: if the value is a string that parses as a
// homogeneous JSON array of strings or numbers, return the parsed array so
// processFrontMatter writes a YAML list instead of a quoted string.
function coerceJsonEncodedArray(
  value: string | number | boolean | string[] | number[],
): string | number | boolean | string[] | number[] {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) return value;
    if (parsed.every((item): item is string => typeof item === "string")) {
      return parsed;
    }
    if (parsed.every((item): item is number => typeof item === "number")) {
      return parsed;
    }
  } catch {
    // not valid JSON — use the string as-is
  }
  return value;
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
  if (!(abstract instanceof TFile)) {
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
  const file = abstract;

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
    content: [
      { type: "text", text: JSON.stringify({ path, key, action }, null, 2) },
    ],
  };
}
