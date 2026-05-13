import { type } from "arktype";
import type { App, TFile } from "obsidian";

export const getVaultFilePartialSchema = type({
  name: '"get_vault_file_partial"',
  arguments: {
    filename: type("string>0").describe(
      "Vault-relative path to the file.",
    ),
    mode: type(
      '"frontmatter" | "heading" | "block" | "document-map"',
    ).describe(
      'One of: `"frontmatter"` (returns a single frontmatter field value), `"heading"` (returns the markdown section under the target heading), `"block"` (returns the markdown range of the target block reference), or `"document-map"` (returns the file outline — heading list, block-id list, frontmatter-field list — with no body content).',
    ),
    "target?": type("string>0").describe(
      'Field name for `frontmatter`, heading text (optionally nested via `targetDelimiter`) for `heading`, or block id (with or without the leading `^`) for `block`. Required for all modes EXCEPT `document-map` (where it is ignored).',
    ),
    "targetDelimiter?": type("string>0").describe(
      'Delimiter used to address a nested heading path, e.g. `"Parent::Child::Grandchild"`. Defaults to `"::"` (matching the Local REST API convention). Only meaningful for `mode: "heading"`.',
    ),
  },
}).describe(
  "Returns a partial read of a vault file: a single frontmatter field, a heading section, a block range, or the file outline. All four modes operate on Obsidian's already-cached metadata (`MetadataCache`) and `vault.cachedRead`; no Local REST API required. The `frontmatter` and `document-map` modes are zero-I/O on cached data; `heading` and `block` perform one cached read each. Useful for context-window economics on large notes (e.g. spot-check a frontmatter field on a 30 KB file without loading the body). Always read-only.",
);

export type GetVaultFilePartialContext = {
  arguments: {
    filename: string;
    mode: "frontmatter" | "heading" | "block" | "document-map";
    target?: string;
    targetDelimiter?: string;
  };
  app: App;
};

type MockHeading = {
  heading: string;
  level: number;
  position: { start: { line: number }; end?: { line: number } };
};

type MockBlock = {
  position: { start: { line: number }; end: { line: number } };
};

type MockCache = {
  headings?: MockHeading[];
  blocks?: Record<string, MockBlock>;
  frontmatter?: Record<string, unknown>;
};

function errorResponse(
  message: string,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function jsonResponse(
  value: unknown,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function textResponse(
  text: string,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text }],
  };
}

/**
 * Find the heading entry that matches a target path. `target` may be a single
 * heading text or a path of headings separated by `delimiter` (e.g.
 * `"Parent::Child::Grandchild"` with delimiter `"::"`).
 *
 * Returns either the matched heading + the lower bound of its section
 * (exclusive end line: the line BEFORE the next same-or-higher-level heading,
 * or `totalLines` for end-of-file), or an error string.
 *
 * Disambiguation: if the path is unique, the match is returned. If multiple
 * matches exist at the same depth (truly ambiguous), an error is returned. The
 * caller surfaces it as `isError: true`.
 */
function findHeadingSection(
  headings: MockHeading[],
  target: string,
  delimiter: string,
  totalLines: number,
):
  | { startLine: number; endLine: number; level: number }
  | { error: string } {
  const segments = target.split(delimiter).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) {
    return { error: "Invalid heading target: empty after delimiter split." };
  }

  // Walk the segments. For each segment, we need to find a heading whose text
  // matches AND that lives inside the section of the previous segment (i.e.
  // appears after the previous match and before the previous section closes).
  //
  // - prevEndLine starts at `totalLines` so the first segment can match
  //   anywhere in the file.
  // - prevLevel starts at 0 so the first segment matches any level.
  let prevStartLine = -1; // exclusive lower bound for the next segment
  let prevEndLine = totalLines;
  let prevLevel = 0;
  let lastMatch: MockHeading | null = null;

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const candidates = headings.filter(
      (h) =>
        h.heading === seg &&
        h.position.start.line > prevStartLine &&
        h.position.start.line < prevEndLine &&
        (segIdx === 0 || h.level > prevLevel),
    );

    if (candidates.length === 0) {
      const where =
        segIdx === 0
          ? "in the file"
          : `under "${segments.slice(0, segIdx).join(delimiter)}"`;
      return {
        error: `Heading not found: "${seg}" ${where}.`,
      };
    }
    if (candidates.length > 1) {
      const lines = candidates
        .map((c) => `level ${c.level} at line ${c.position.start.line}`)
        .join(", ");
      return {
        error: `Ambiguous heading target: "${seg}" matches multiple headings (${lines}). Use a nested path with \`targetDelimiter\` to disambiguate.`,
      };
    }

    const match = candidates[0];
    lastMatch = match;
    prevStartLine = match.position.start.line;
    prevLevel = match.level;

    // The section under `match` ends at the next heading with level <= match.level
    // (or EOF if no such heading exists). This is the boundary that the next
    // segment in the path must respect.
    const closer = headings.find(
      (h) =>
        h.position.start.line > match.position.start.line &&
        h.level <= match.level,
    );
    prevEndLine = closer ? closer.position.start.line : totalLines;
  }

  if (!lastMatch) {
    return { error: `Heading not found: "${target}".` };
  }

  return {
    startLine: lastMatch.position.start.line,
    endLine: prevEndLine,
    level: lastMatch.level,
  };
}

export async function getVaultFilePartialHandler(
  ctx: GetVaultFilePartialContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { filename, mode, target, targetDelimiter } = ctx.arguments;

  const abstract = ctx.app.vault.getAbstractFileByPath(filename);
  if (!abstract) {
    return errorResponse(`File not found: ${filename}`);
  }
  const file = abstract as TFile;

  // Schema-level guard: `target` is required for every mode except
  // `document-map`. We enforce this at the handler level (rather than via
  // arktype) so the error message can name the mode explicitly.
  if (mode !== "document-map" && (!target || !target.trim())) {
    return errorResponse(
      `Missing required \`target\` for mode "${mode}". The \`target\` argument is required for "frontmatter", "heading", and "block" modes.`,
    );
  }

  const cache = (ctx.app.metadataCache.getFileCache(file) ??
    {}) as MockCache;

  // ── frontmatter ───────────────────────────────────────────────────────────
  if (mode === "frontmatter") {
    const fm = cache.frontmatter;
    if (!fm || Object.keys(fm).length === 0) {
      return errorResponse(
        `File has no frontmatter: ${filename}.`,
      );
    }
    const key = target!.trim();
    if (!(key in fm)) {
      return errorResponse(
        `Frontmatter field not found: "${key}" in ${filename}.`,
      );
    }
    return jsonResponse(fm[key]);
  }

  // ── document-map ──────────────────────────────────────────────────────────
  if (mode === "document-map") {
    // Pinned locale + sensitivity for cross-platform deterministic order on
    // the frontmatter-key list and the block-id list (matches the contract
    // used by `list_tags` / `get_files_by_tag` / `get_recent_files`).
    const compareName = (a: string, b: string): number =>
      a.localeCompare(b, "en", { sensitivity: "variant" });

    const headings = (cache.headings ?? []).map((h) => ({
      heading: h.heading,
      level: h.level,
      line: h.position.start.line,
    }));
    const blocks = Object.keys(cache.blocks ?? {}).slice().sort(compareName);
    const frontmatterKeys = Object.keys(cache.frontmatter ?? {})
      .slice()
      .sort(compareName);

    return jsonResponse({
      path: file.path,
      frontmatter: frontmatterKeys,
      headings,
      blocks,
    });
  }

  // Modes below need the file contents.
  const text = await ctx.app.vault.cachedRead(file);
  const lines = text.split("\n");

  // ── heading ───────────────────────────────────────────────────────────────
  if (mode === "heading") {
    const headings = cache.headings ?? [];
    if (headings.length === 0) {
      return errorResponse(
        `File has no headings: ${filename}.`,
      );
    }
    const delim = targetDelimiter ?? "::";
    const result = findHeadingSection(headings, target!, delim, lines.length);
    if ("error" in result) {
      return errorResponse(result.error);
    }
    // `endLine` is the start line of the next same-or-higher-level heading
    // (exclusive) or `lines.length` for EOF. Slice [startLine, endLine).
    const section = lines.slice(result.startLine, result.endLine).join("\n");
    return textResponse(section);
  }

  // ── block ─────────────────────────────────────────────────────────────────
  if (mode === "block") {
    const blocks = cache.blocks ?? {};
    // Strip leading `^` characters and trim. Obsidian addresses blocks
    // without the caret in the metadata cache; users may pass either form.
    const key = target!.trim().replace(/^\^+/, "");
    if (!key) {
      return errorResponse(
        `Invalid block target: input is empty or contains only "^" characters.`,
      );
    }
    const entry = blocks[key];
    if (!entry) {
      return errorResponse(
        `Block not found: "^${key}" in ${filename}.`,
      );
    }
    // Block position uses inclusive end line in the metadata cache.
    const section = lines
      .slice(entry.position.start.line, entry.position.end.line + 1)
      .join("\n");
    return textResponse(section);
  }

  // Unreachable: arktype validates `mode` to the four-value union.
  return errorResponse(`Unknown mode: "${mode}".`);
}
