import { type } from "arktype";
import type { App } from "obsidian";
import { resolveHeadingForWrite } from "../services/anchorTargets";
import {
  allBlockIds,
  attachBlockId,
  BLOCK_ID_PATTERN,
  existingBlockId,
  generateBlockId,
  locateBlock,
} from "../services/blockId";
import { buildObsidianUri } from "../services/buildObsidianUri";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";
import { withVaultWriteLock } from "../services/vaultWriteLock";

export const ensureBlockIdSchema = type({
  name: '"ensure_block_id"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path of the markdown file.",
    ),
    "line?": type("number.integer>=0").describe(
      "0-indexed line inside the block to address (a search hit, a `list_tasks` line, ...). Either `line` or `heading` is required.",
    ),
    "heading?": type("string>0").describe(
      "A heading in the file (exact text or `Parent::Child` path): the target is the first block under it. Use `get_note_outline` to see the headings.",
    ),
    "id?": type("string>0").describe(
      "Block id to write when the block has none (Latin letters, digits and dashes). Omitted: a 6-character id is generated. If the block already carries an id, that one is returned and this value is ignored.",
    ),
    "dry_run?": type("boolean").describe(
      "When `true`, reports what would be written without touching the file. Default `false`.",
    ),
  },
}).describe(
  "Returns a stable `^block-id` for a block of a note, creating one when the block has none, so it can be linked or embedded with `[[note#^id]]` / `![[note#^id]]`. Follows Obsidian's placement rules: at the end of a paragraph's last line, directly on a list item's line, or on its own line after a table, fenced code block, quote or callout. Idempotent: calling it again returns the existing id. Atomic write through `vault.process`; nothing else in the file changes. Returns `id`, `created`, the line the id sits on, the ready-made `link` and an `obsidian://` URI.",
);

export type EnsureBlockIdContext = {
  arguments: {
    path: string;
    line?: number;
    heading?: string;
    id?: string;
    dry_run?: boolean;
  };
  app: App;
};

type Outcome =
  | {
      kind: "ok";
      id: string;
      created: boolean;
      idLine: number;
      blockStartLine: number;
      blockEndLine: number;
      requestedIdIgnored: boolean;
    }
  | { kind: "line_out_of_range"; lineCount: number }
  | { kind: "heading_not_found"; segment: string; where: string }
  | { kind: "ambiguous_heading"; message: string }
  | { kind: "empty_section" }
  | { kind: "blank_line" }
  | { kind: "heading_line" }
  | { kind: "block_id_taken"; id: string };

export async function ensureBlockIdHandler(ctx: EnsureBlockIdContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, heading, dry_run = false } = ctx.arguments;
  const requestedId = ctx.arguments.id;

  if (ctx.arguments.line === undefined && heading === undefined) {
    return errorJson("Pass `line` or `heading`.", "invalid_params", { path });
  }
  if (requestedId !== undefined && !BLOCK_ID_PATTERN.test(requestedId)) {
    return errorJson(
      "Block identifiers can only consist of Latin letters, numbers, and dashes.",
      "invalid_params",
      { path, id: requestedId },
    );
  }

  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(`File not found: ${path}`, "file_not_found", { path })
      : errorJson(`Path is a folder: ${path}`, "not_a_file", { path });
  }
  const file = resolved.file;
  if (file.extension !== "md") {
    return errorJson(`Not a markdown file: ${path}`, "not_markdown", {
      path,
      targetType: "file",
    });
  }

  const cache = ctx.app.metadataCache.getFileCache(file);

  const apply = (current: string): string => {
    const lines = current.split("\n");
    let target: number;
    if (ctx.arguments.line !== undefined) {
      target = ctx.arguments.line;
      if (target >= lines.length) {
        outcome = { kind: "line_out_of_range", lineCount: lines.length };
        return current;
      }
    } else {
      const res = resolveHeadingForWrite(cache, lines, [heading as string]);
      if (res.kind === "not-found") {
        outcome = {
          kind: "heading_not_found",
          segment: res.segment,
          where: res.where,
        };
        return current;
      }
      if (res.kind === "ambiguous") {
        outcome = { kind: "ambiguous_heading", message: res.message };
        return current;
      }
      let i = res.line + 1;
      while (i < res.endLine && lines[i].trim().length === 0) i += 1;
      if (i >= res.endLine || /^#{1,6}\s/.test(lines[i])) {
        outcome = { kind: "empty_section" };
        return current;
      }
      target = i;
    }

    const placement = locateBlock(lines, target);
    if (placement.kind === "blank") {
      outcome = { kind: "blank_line" };
      return current;
    }
    if (placement.kind === "heading") {
      outcome = { kind: "heading_line" };
      return current;
    }
    const existing = existingBlockId(lines, placement);
    if (existing) {
      outcome = {
        kind: "ok",
        id: existing.id,
        created: false,
        idLine: existing.line,
        blockStartLine: placement.startLine,
        blockEndLine: placement.endLine,
        requestedIdIgnored:
          requestedId !== undefined && requestedId !== existing.id,
      };
      return current;
    }
    const taken = allBlockIds(lines);
    for (const id of Object.keys(cache?.blocks ?? {})) taken.add(id);
    if (requestedId !== undefined && taken.has(requestedId)) {
      outcome = { kind: "block_id_taken", id: requestedId };
      return current;
    }
    const id = requestedId ?? generateBlockId(taken);
    const written = attachBlockId(lines, placement, id);
    outcome = {
      kind: "ok",
      id,
      created: true,
      idLine: written.line,
      blockStartLine: placement.startLine,
      blockEndLine: placement.endLine,
      requestedIdIgnored: false,
    };
    return dry_run ? current : written.lines.join("\n");
  };

  let outcome: Outcome | undefined;
  try {
    if (dry_run) {
      apply(await ctx.app.vault.cachedRead(file));
    } else {
      await withVaultWriteLock(() => ctx.app.vault.process(file, apply));
    }
  } catch (error) {
    return errorJson(
      `Failed to update ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "write_failed",
      { path },
    );
  }

  switch (outcome?.kind) {
    case "ok": {
      const ref = `${file.basename}#^${outcome.id}`;
      return successJson({
        path,
        id: outcome.id,
        created: outcome.created,
        dryRun: dry_run,
        line: outcome.idLine,
        blockStartLine: outcome.blockStartLine,
        blockEndLine: outcome.blockEndLine,
        link: `[[${ref}]]`,
        embed: `![[${ref}]]`,
        uri: buildObsidianUri(ctx.app.vault.getName(), file.path),
        ...(outcome.requestedIdIgnored
          ? { requestedIdIgnored: requestedId }
          : {}),
      });
    }
    case "line_out_of_range":
      return errorJson(
        `Line ${ctx.arguments.line} is out of range: the file has ${outcome.lineCount} lines.`,
        "line_out_of_range",
        { path, line: ctx.arguments.line, lineCount: outcome.lineCount },
      );
    case "heading_not_found":
      return errorJson(
        `Heading "${outcome.segment}" not found ${outcome.where}.`,
        "heading_not_found",
        { path, heading },
      );
    case "ambiguous_heading":
      return errorJson(outcome.message, "ambiguous_heading", { path, heading });
    case "empty_section":
      return errorJson(
        `Heading "${heading}" has no content block under it to identify.`,
        "empty_section",
        { path, heading },
      );
    case "blank_line":
      return errorJson(
        `Line ${ctx.arguments.line} is blank; a block id needs a line with content.`,
        "invalid_params",
        { path, line: ctx.arguments.line },
      );
    case "heading_line":
      return errorJson(
        "The target is a heading; link to it with [[note#Heading]] instead of a block id, or pass a line inside its section.",
        "unsupported_block",
        { path, line: ctx.arguments.line },
      );
    case "block_id_taken":
      return errorJson(
        `Block id ^${outcome.id} is already used by another block in this file.`,
        "block_id_taken",
        { path, id: outcome.id },
      );
    default:
      return errorJson(`Failed to update ${path}: no outcome`, "write_failed", {
        path,
      });
  }
}
