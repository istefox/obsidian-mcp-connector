import { type } from "arktype";
import { errorText } from "../services/responseBuilders";
import {
  applyPatch,
  type PatchArgs,
} from "$/features/mcp-tools/services/patchHelpers";
import type McpToolsPlugin from "$/main";
import { resolveRequireWritePreconditions } from "$/features/mcp-tools/services/writePreconditionSetting";

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
    "expectedContent?": type("string").describe(
      "For operation=replace only: the text you believe currently occupies the target, as read via get_vault_file. When it no longer matches, the patch is refused instead of overwriting a change you have not seen. Whitespace-insensitive. Ignored for append/prepend.",
    ),
  },
}).describe(
  "Patches the currently active note relative to a heading, block reference, or frontmatter key.",
);

export type PatchActiveFileContext = {
  arguments: PatchArgs;
  app: import("obsidian").App;
  /** See patchVaultFile.ts — absent in partial fixtures, default is off. */
  plugin?: McpToolsPlugin;
};

/**
 * Thin wrapper over the shared services/patchHelpers.ts:applyPatch —
 * the same implementation patch_vault_file uses — applied to the
 * currently active file. The two tools carried duplicated ~200-line
 * applyPatch copies for a long time; the copies diverged once (fork
 * #137 landed in only one of them), so the duplicate was retired.
 *
 * That sharing is why `expectedContent` reaches this tool as well.
 * ADR-0019 decided the guard for `patch_vault_file`; extending it here is not
 * incidental. The active file is the one the user is looking at, so it is the
 * single most likely place for an agent's replace to land on top of something
 * a human just typed. Declaring it in this schema too means a client that
 * passes the argument is honoured rather than silently validated away.
 */
export async function patchActiveFileHandler(
  ctx: PatchActiveFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const file = ctx.app.workspace.getActiveFile();
  if (!file) {
    return errorText("No active file.");
  }
  return await applyPatch(ctx.app, file, ctx.arguments, {
    requirePrecondition: await resolveRequireWritePreconditions(ctx.plugin),
  });
}
