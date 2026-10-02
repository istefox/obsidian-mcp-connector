import { type } from "arktype";
import { type App } from "obsidian";
import {
  headingEntriesFromCache,
  normalizeBlockId,
  resolveHeadingEntries,
  splitHeadingPath,
} from "../services/anchorTargets";
import { resolveTFile } from "../services/resolveTFile";
// Response envelopes shared across tools — the success ones aliased to the
// original local names to keep this file's call sites stable.
import {
  errorJson,
  successJson as jsonResponse,
  successText as textResponse,
} from "../services/responseBuilders";

export const getVaultFilePartialSchema = type({
  name: '"get_vault_file_partial"',
  arguments: {
    filename: type("string>0").describe("Vault-relative path to the file."),
    mode: type(
      '"frontmatter" | "heading" | "block" | "document-map" | "lines"',
    ).describe(
      "`frontmatter` = one field value; `heading` = the markdown section under the heading; `block` = the range of the block reference; `document-map` = outline only (headings, block ids, frontmatter keys), no body; `lines` = a raw 0-indexed inclusive line range via `startLine`/`endLine`.",
    ),
    "target?": type("string>0").describe(
      "Frontmatter field name, heading text (nested path via `targetDelimiter`), or block id (leading `^` optional). Ignored for `document-map` and `lines`.",
    ),
    "targetDelimiter?": type("string>0").describe(
      'Delimiter for nested heading paths, e.g. `Parent::Child`. Default `::`. Only for `mode: "heading"`.',
    ),
    "startLine?": type("number.integer>=0").describe(
      '0-indexed first line to return, inclusive. Required for `mode: "lines"`.',
    ),
    "endLine?": type("number.integer>=0").describe(
      '0-indexed last line to return, inclusive. Required for `mode: "lines"`; clamped to end-of-file if past it.',
    ),
  },
}).describe(
  "Reads part of a vault file without loading the body: a single frontmatter field, a heading section, a block range, a raw line range, or the file outline. Read-only and cheap on large notes.",
);

export type GetVaultFilePartialContext = {
  arguments: {
    filename: string;
    mode: "frontmatter" | "heading" | "block" | "document-map" | "lines";
    target?: string;
    targetDelimiter?: string;
    startLine?: number;
    endLine?: number;
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

export async function getVaultFilePartialHandler(
  ctx: GetVaultFilePartialContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { filename, mode, target, targetDelimiter, startLine, endLine } =
    ctx.arguments;

  const resolved = resolveTFile(ctx.app.vault, filename);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(`File not found: ${filename}`, "file_not_found", {
          path: filename,
        })
      : errorJson(`Path is a folder: ${filename}`, "not_a_file", {
          path: filename,
        });
  }
  const file = resolved.file;

  // Schema-level guard: `target` is required for every mode except
  // `document-map` and `lines` (which use `startLine`/`endLine` instead).
  // We enforce this at the handler level (rather than via arktype) so the
  // error message can name the mode explicitly. `block` mode is excluded
  // from the empty-after-trim check: `normalizeBlockId` (R-10) is the single
  // place that owns validating a block target, including the empty-string
  // case, so it must see the raw value rather than have this guard shadow it.
  if (
    mode !== "document-map" &&
    mode !== "lines" &&
    (target === undefined || (mode !== "block" && !target.trim()))
  ) {
    return errorJson(
      `Missing required \`target\` for mode "${mode}". The \`target\` argument is required for "frontmatter", "heading", and "block" modes.`,
      "invalid_params",
      { mode },
    );
  }

  if (mode === "lines" && (startLine === undefined || endLine === undefined)) {
    return errorJson(
      `Missing required \`startLine\`/\`endLine\` for mode "lines". Both are required and 0-indexed.`,
      "invalid_params",
      { mode },
    );
  }
  if (mode === "lines" && startLine! > endLine!) {
    return errorJson(
      `Invalid range: \`startLine\` (${startLine}) must be <= \`endLine\` (${endLine}).`,
      "invalid_params",
      { startLine, endLine },
    );
  }

  const cache = (ctx.app.metadataCache.getFileCache(file) ?? {}) as MockCache;

  // ── frontmatter ───────────────────────────────────────────────────────────
  if (mode === "frontmatter") {
    const fm = cache.frontmatter;
    if (!fm || Object.keys(fm).length === 0) {
      // This tool reflects Obsidian's MetadataCache and never re-parses
      // YAML independently — a second parser would diverge from what the
      // rest of Obsidian (UI, Linter, other plugins) sees (#138). When the
      // cache is empty, disambiguate "genuinely no frontmatter" from "a
      // frontmatter block exists but Obsidian's own parser dropped it" so
      // the error is actionable instead of misleading.
      const fmLines = (await ctx.app.vault.cachedRead(file)).split("\n");
      let blockHasContent = false;
      if (fmLines[0]?.trim() === "---") {
        let closeIdx = -1;
        for (let i = 1; i < fmLines.length; i++) {
          if (fmLines[i].trim() === "---") {
            closeIdx = i;
            break;
          }
        }
        const region =
          closeIdx === -1 ? fmLines.slice(1) : fmLines.slice(1, closeIdx);
        blockHasContent = region.some((l) => l.trim() !== "");
      }
      if (blockHasContent) {
        return errorJson(
          `Frontmatter block present in ${filename} but Obsidian's metadata cache exposed no fields — its YAML parser could not read it. Common cause: an unquoted scalar whose value contains ": " (e.g. \`key: a value with: a colon\`); quote the value (\`key: "a value with: a colon"\`). This tool reflects Obsidian's cache and does not re-parse YAML independently, so the source file must be fixed.`,
          "frontmatter_unparsable",
          { path: filename },
        );
      }
      return errorJson(
        `File has no frontmatter: ${filename}.`,
        "no_frontmatter",
        {
          path: filename,
        },
      );
    }
    const key = target!.trim();
    if (!(key in fm)) {
      return errorJson(
        `Frontmatter field not found: "${key}" in ${filename}.`,
        "property_not_found",
        { path: filename, key },
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
    const blocks = Object.keys(cache.blocks ?? {})
      .slice()
      .sort(compareName);
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

  // ── lines ─────────────────────────────────────────────────────────────────
  if (mode === "lines") {
    // 0-indexed, inclusive on both ends — matches `block` mode's
    // inclusive-end convention below. `endLine` past EOF clamps rather
    // than erroring, so callers don't need to know the file's length
    // up front.
    const clampedEnd = Math.min(endLine!, lines.length - 1);
    const section = lines.slice(startLine, clampedEnd + 1).join("\n");
    return textResponse(section);
  }

  // ── heading ───────────────────────────────────────────────────────────────
  if (mode === "heading") {
    const headings = cache.headings ?? [];
    if (headings.length === 0) {
      return errorJson(`File has no headings: ${filename}.`, "no_headings", {
        path: filename,
      });
    }
    const delim = targetDelimiter ?? "::";
    const segments = splitHeadingPath(target!, delim);
    const result = resolveHeadingEntries(
      headingEntriesFromCache(cache),
      segments,
      lines.length,
      delim,
    );
    if (result.kind === "not-found") {
      return errorJson(
        `Heading not found: "${result.segment}" ${result.where}.`,
        "heading_not_found",
        { path: filename, target },
      );
    }
    if (result.kind === "ambiguous") {
      return errorJson(result.message, "ambiguous_heading", {
        path: filename,
        target,
      });
    }
    // `endLine` is the start line of the next same-or-higher-level heading
    // (exclusive) or `lines.length` for EOF. Slice [startLine, endLine).
    const section = lines.slice(result.line, result.endLine).join("\n");
    return textResponse(section);
  }

  // ── block ─────────────────────────────────────────────────────────────────
  if (mode === "block") {
    const blocks = cache.blocks ?? {};
    const idResult = normalizeBlockId(target!);
    if (!idResult.ok) {
      return errorJson(idResult.error, "invalid_block_id", { target });
    }
    const key = idResult.id;
    const entry = blocks[key];
    if (!entry) {
      return errorJson(
        `Block not found: "^${key}" in ${filename}.`,
        "block_not_found",
        { path: filename, blockId: key },
      );
    }
    // Block position uses inclusive end line in the metadata cache.
    const section = lines
      .slice(entry.position.start.line, entry.position.end.line + 1)
      .join("\n");
    return textResponse(section);
  }

  // Unreachable: arktype validates `mode` to the four-value union.
  return errorJson(`Unknown mode: "${mode}".`, "invalid_params", { mode });
}
