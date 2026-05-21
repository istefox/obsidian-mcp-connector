import { type } from "arktype";
import type { App, TFile } from "obsidian";
import {
  resolveHeadingPath,
  findBlockPositionFromCache,
  hasParentH1,
  hasAnyH1,
  isBlockRangeStructurallyUnsafe,
  normalizeAppendBody,
  planFrontmatterReplace,
  planFrontmatterAppend,
  type PatchOperation,
} from "$/features/mcp-tools/services/patchHelpers";

export const patchActiveFileSchema = type({
  name: '"patch_active_file"',
  arguments: {
    operation: '"append"|"prepend"|"replace"',
    targetType: '"heading"|"block"|"frontmatter"',
    target: type("string>0").describe(
      "Heading name, block id, or frontmatter key (depending on targetType).",
    ),
    content: type("string").describe(
      "Content to apply (semantics depend on operation+targetType).",
    ),
    "targetDelimiter?": "string",
    "createTargetIfMissing?": "boolean",
    "allowRootHeadings?": type("boolean").describe(
      "When true, allow targeting a level-2-or-deeper heading with no level-1 (#) parent even when the document contains an H1 elsewhere (the ambiguous 'mixed' case the H2-root guard rejects with createTargetIfMissing=false). Files with no H1 at all are accepted without this flag. Default false.",
    ),
  },
}).describe(
  "Patches the currently active note relative to a heading, block reference, or frontmatter key.",
);

export type PatchActiveFileContext = {
  arguments: {
    operation: PatchOperation;
    targetType: "heading" | "block" | "frontmatter";
    target: string;
    content: string;
    targetDelimiter?: string;
    createTargetIfMissing?: boolean;
    allowRootHeadings?: boolean;
  };
  app: App;
};

export async function patchActiveFileHandler(
  ctx: PatchActiveFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const file = ctx.app.workspace.getActiveFile();
  if (!file) {
    return {
      content: [{ type: "text", text: "No active file." }],
      isError: true,
    };
  }
  return await applyPatch(ctx.app, file as TFile, ctx.arguments);
}

/**
 * Core patch logic — exported for reuse by patchVaultFile (T13). T13's handler
 * resolves the file by path, then delegates here.
 *
 * Per-target-type default for createTargetIfMissing (per source 0.3.7 fix +
 * issue #71):
 *   heading + frontmatter → true  (preserve 0.2.x behaviour)
 *   block → false  (fail loud on unresolved id; safer per #71 block-in-table
 *                   corruption risk)
 *
 * Args:
 *   app: Obsidian App instance.
 *   file: The TFile to patch.
 *   args: Patch parameters validated by patchActiveFileSchema.
 *
 * Returns:
 *   MCP result object, with isError=true on failure.
 */
export async function applyPatch(
  app: App,
  file: TFile,
  args: PatchActiveFileContext["arguments"],
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  // Block defaults to false to fail loud on unresolved block ids — avoids
  // silent corruption in block-in-table scenarios (issue #71).
  const createIfMissing =
    args.createTargetIfMissing ?? args.targetType !== "block";
  const delimiter = args.targetDelimiter ?? "::";

  // --- frontmatter branch ---
  // Mirrors the frontmatter logic in services/patchHelpers.ts:applyPatch
  // (used by patch_vault_file). Both call sites share planFrontmatter*
  // helpers so the policy stays in one place — see issues #12 / #13 for
  // why this was non-trivial. Note: the two `applyPatch` functions are
  // currently duplicated; consolidating them is a separate refactor.
  if (args.targetType === "frontmatter") {
    let rejection: string | null = null;
    await app.fileManager.processFrontMatter(file, (fm) => {
      const existing = fm[args.target];
      if (args.operation === "replace") {
        const plan = planFrontmatterReplace(
          existing,
          args.content,
          args.target,
        );
        if (plan.kind === "reject") {
          rejection = plan.message;
          return;
        }
        fm[args.target] = plan.kind === "ok" ? plan.value : args.content;
        return;
      }
      // append / prepend
      const plan = planFrontmatterAppend(existing, args.content);
      if (plan.kind === "array-push") {
        const arr = (existing as unknown[]).slice();
        if (args.operation === "append") arr.push(...plan.values);
        else arr.unshift(...plan.values);
        fm[args.target] = arr;
        return;
      }
      // string-concat: existing is scalar / null / undefined.
      if (existing == null) {
        fm[args.target] = args.content;
        return;
      }
      fm[args.target] =
        args.operation === "append"
          ? String(existing) + args.content
          : args.content + String(existing);
    });
    if (rejection !== null) {
      return {
        content: [{ type: "text", text: rejection }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: "OK" }] };
  }

  const fileContent = await app.vault.read(file);
  const lines = fileContent.split("\n");

  // --- heading branch ---
  if (args.targetType === "heading") {
    const fullPath = resolveHeadingPath(fileContent, args.target, delimiter);

    if (!fullPath && !createIfMissing) {
      return {
        content: [
          {
            type: "text",
            text: `Heading "${args.target}" not found and createTargetIfMissing=false.`,
          },
        ],
        isError: true,
      };
    }

    if (!fullPath) {
      // Target heading not found — append at EOF (createIfMissing=true path).
      const normalized = normalizeAppendBody(args.content, args.operation);
      await app.vault.modify(file, fileContent + normalized);
      return { content: [{ type: "text", text: "OK" }] };
    }

    // Resolve the leaf name from the full path and locate the heading line.
    const leafName = fullPath.split(delimiter).pop()!;
    let headingLine = -1;
    let headingLevel = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = /^(#+)\s+(.+?)\s*$/.exec(lines[i]);
      if (m && m[2].trim() === leafName) {
        headingLine = i;
        headingLevel = m[1].length;
        break;
      }
    }

    // 0.3.9 #16 parity: reject root-orphan H2+ when createTargetIfMissing=false.
    // Mirror of the gate in services/patchHelpers.ts:applyPatch — see fork #80,
    // #83. #139 narrowed it: ambiguous only when an H1 exists elsewhere
    // (mixed doc); an H1-free file is allowed, `allowRootHeadings` is the
    // explicit opt-in for the mixed case. The shared hasParentH1/hasAnyH1
    // helpers keep the policy in one place across the two applyPatch impls.
    if (
      headingLine !== -1 &&
      headingLevel >= 2 &&
      !createIfMissing &&
      !hasParentH1(lines, headingLine) &&
      !args.allowRootHeadings &&
      hasAnyH1(lines)
    ) {
      return {
        content: [
          {
            type: "text",
            text: `Heading "${args.target}" is a level-${headingLevel} heading with no level-1 (#) parent, while the document does contain an H1 elsewhere — the section boundary is ambiguous. Refusing to patch. Pass allowRootHeadings:true to target it explicitly, or createTargetIfMissing:true to bypass. (Files with no H1 at all are accepted automatically.)`,
          },
        ],
        isError: true,
      };
    }

    // Find end of this heading's section: next heading at same-or-higher level.
    let sectionEnd = lines.length;
    for (let i = headingLine + 1; i < lines.length; i++) {
      const m = /^(#+)\s+/.exec(lines[i]);
      if (m && m[1].length <= headingLevel) {
        sectionEnd = i;
        break;
      }
    }

    if (args.operation === "append") {
      // Insert at end of section, just before sectionEnd.
      // normalizeAppendBody adds trailing "\n\n" — strip the last "\n" so
      // splice doesn't introduce a blank line before the next heading.
      const normalized = normalizeAppendBody(args.content, "append");
      lines.splice(sectionEnd, 0, normalized.replace(/\n$/, ""));
    } else if (args.operation === "prepend") {
      lines.splice(headingLine + 1, 0, args.content);
    } else {
      // replace: swap out the section body between this heading and the next.
      // The original body absorbed both the leading blank line (between the
      // heading and the first body line) and the trailing blank line (between
      // the last body line and the next sibling/parent heading). Splicing the
      // new content in without re-emitting either separator produces
      // `## A\n<content>\n## B` instead of the expected
      // `## A\n\n<content>\n\n## B`. We re-emit:
      //   - a leading blank when the content does not already start with one
      //     (Linter-correct shape; matches 0.3.x behaviour; closes #76);
      //   - a trailing blank when the tail is another heading and the content
      //     does not already end blank (post-beta.1 fix).
      const tailIsHeading =
        sectionEnd < lines.length && /^#{1,6}\s/.test(lines[sectionEnd]);
      const contentStartsBlank =
        args.content === "" || args.content.startsWith("\n");
      const contentEndsBlank =
        args.content === "" || args.content.endsWith("\n");

      const replacement: string[] = [];
      if (!contentStartsBlank) replacement.push("");
      replacement.push(args.content);
      if (tailIsHeading && !contentEndsBlank) replacement.push("");

      lines.splice(
        headingLine + 1,
        sectionEnd - headingLine - 1,
        ...replacement,
      );
    }

    await app.vault.modify(file, lines.join("\n"));
    return { content: [{ type: "text", text: "OK" }] };
  }

  // --- block branch ---
  if (args.targetType === "block") {
    const cache = app.metadataCache.getFileCache(file);
    const pos = findBlockPositionFromCache(cache, args.target);

    if (!pos && !createIfMissing) {
      return {
        content: [
          {
            type: "text",
            text: `Block "^${args.target}" not found in active file (createTargetIfMissing=false).`,
          },
        ],
        isError: true,
      };
    }

    if (!pos) {
      // Block not found — append at EOF (createIfMissing=true path).
      const normalized = normalizeAppendBody(args.content, args.operation);
      await app.vault.modify(file, fileContent + normalized);
      return { content: [{ type: "text", text: "OK" }] };
    }

    // 0.3.x parity: reject when block resolves inside a table or fenced code
    // block. Mirror of the gate in services/patchHelpers.ts:applyPatch —
    // see fork #81, #83. 0.4.3 fork #84: full block range
    // check, not just startLine — see range wrapper in patchHelpers.ts.
    if (isBlockRangeStructurallyUnsafe(lines, pos.startLine, pos.endLine)) {
      return {
        content: [
          {
            type: "text",
            text: `Block "^${args.target}" resolved to line ${pos.startLine + 1} but it is inside a markdown table or fenced code block. Refusing to patch — replacing or splicing this region would corrupt the surrounding structure. Move the block id outside the table/code block to make it patchable.`,
          },
        ],
        isError: true,
      };
    }

    if (args.operation === "append") {
      lines.splice(pos.endLine + 1, 0, args.content);
    } else if (args.operation === "prepend") {
      lines.splice(pos.startLine, 0, args.content);
    } else {
      // replace: swap the lines from startLine to endLine (inclusive).
      lines.splice(
        pos.startLine,
        pos.endLine - pos.startLine + 1,
        args.content,
      );
    }

    await app.vault.modify(file, lines.join("\n"));
    return { content: [{ type: "text", text: "OK" }] };
  }

  // Unreachable if ArkType validation ran correctly.
  return {
    content: [
      {
        type: "text",
        text: `Unknown targetType: ${(args as unknown as { targetType: string }).targetType}`,
      },
    ],
    isError: true,
  };
}
