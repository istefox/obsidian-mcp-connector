import { type } from "arktype";
import { errorText } from "../services/responseBuilders";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import {
  applyPatch,
  type PatchArgs,
} from "$/features/mcp-tools/services/patchHelpers";
import type McpToolsPlugin from "$/main";
import { resolveRequireWritePreconditions } from "$/features/mcp-tools/services/writePreconditionSetting";

export const patchVaultFileSchema = type({
  name: '"patch_vault_file"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path to the file to patch.",
    ),
    operation: '"append"|"prepend"|"replace"',
    targetType: '"heading"|"block"|"frontmatter"',
    target: type("string>0").describe(
      "Heading name, block id (without ^), or frontmatter key.",
    ),
    content: type("string").describe("Content to apply."),
    "targetDelimiter?": type("string").describe(
      "Delimiter used to join ancestor heading names (default: '::').",
    ),
    "createTargetIfMissing?": type("boolean").describe(
      "Creates the target if not found. Default true for heading/frontmatter, false for block. Pass false to fail loud when patching an H2-or-deeper heading in a file with no parent H1.",
    ),
    "allowRootHeadings?": type("boolean").describe(
      "Allows targeting an H2-or-deeper heading with no H1 parent in a file that has an H1 elsewhere (otherwise rejected when createTargetIfMissing=false). Default false.",
    ),
    "expectedContent?": type("string").describe(
      "For operation=replace only: the text you believe currently occupies the target, as read via get_vault_file. When it no longer matches, the patch is refused instead of overwriting a change you have not seen. Whitespace-insensitive. Ignored for append/prepend.",
    ),
  },
}).describe(
  "Patches a vault file relative to a heading, block reference, or frontmatter key. Unlike patch_active_file, operates on any file by vault-relative path.",
);

export type PatchVaultFileContext = {
  arguments: {
    path: string;
    operation: "append" | "prepend" | "replace";
    targetType: "heading" | "block" | "frontmatter";
    target: string;
    content: string;
    targetDelimiter?: string;
    createTargetIfMissing?: boolean;
    allowRootHeadings?: boolean;
    expectedContent?: string;
  };
  app: App;
  /**
   * Absent in partial test fixtures, exactly as in getVaultFile's context.
   * Without it the write-precondition setting resolves to its default (off),
   * which is the behaviour every existing client already relies on.
   */
  plugin?: McpToolsPlugin;
};

export async function patchVaultFileHandler(
  ctx: PatchVaultFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const resolved = resolveTFile(ctx.app.vault, ctx.arguments.path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorText(`File not found: ${ctx.arguments.path}`)
      : errorText(`Path is a folder: ${ctx.arguments.path}`);
  }
  const file = resolved.file;

  // Strip `path` from the arguments before forwarding — applyPatch only needs
  // the patch-specific fields (operation, targetType, target, content, …).
  const patchArgs = { ...ctx.arguments } as PatchArgs & { path?: string };
  delete patchArgs.path;
  // Resolved here rather than inside applyPatch: this read is async, and the
  // compute it guards must stay synchronous inside vault.process.
  return await applyPatch(ctx.app, file, patchArgs, {
    requirePrecondition: await resolveRequireWritePreconditions(ctx.plugin),
  });
}
