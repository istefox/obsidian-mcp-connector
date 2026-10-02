import { type } from "arktype";
import {
  errorJson,
  errorText,
  successText,
} from "../services/responseBuilders";
import type { App } from "obsidian";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";
import { checkWholeFilePrecondition } from "$/features/mcp-tools/services/wholeFilePrecondition";
import { resolveRequireWritePreconditions } from "$/features/mcp-tools/services/writePreconditionSetting";
import type McpToolsPlugin from "$/main";

export const updateActiveFileSchema = type({
  name: '"update_active_file"',
  arguments: {
    content: type("string").describe(
      "Full new markdown content to replace the current active file's content with. Pass expectedContent to guard against silently overwriting a change you have not seen.",
    ),
    "expectedContent?": type("string").describe(
      "The whole current content of the active note, as read via get_active_file. When it no longer matches, the write is refused instead of silently overwriting a change you have not seen. Whitespace-insensitive. Comparison is over the WHOLE file: to change only part of it, use patch_active_file instead. Mandatory if this vault requires write preconditions.",
    ),
  },
}).describe(
  "Overwrites the entire content of the currently active note with the supplied content — guarded by expectedContent when given, or required by this vault's write-precondition setting.",
);

export type UpdateActiveFileContext = {
  arguments: { content: string; expectedContent?: string };
  app: App;
  /** Absent in partial test fixtures; the precondition setting then resolves to its default (off). */
  plugin?: McpToolsPlugin;
};

export async function updateActiveFileHandler(
  ctx: UpdateActiveFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  // Resolved before the lock: async read, while the compare inside
  // vault.process must stay synchronous (same reasoning as createVaultFile).
  const requirePrecondition = await resolveRequireWritePreconditions(
    ctx.plugin,
  );

  // Compare-then-write inside vault.process under the write lock (ADR-0022
  // addendum): this was the last whole-file overwrite still done with a bare
  // vault.modify, on the very file the user is looking at.
  return withVaultWriteLock(async () => {
    const file = ctx.app.workspace.getActiveFile();
    if (!file) {
      return errorText("No active file.");
    }
    let failureText: string | null = null;
    await ctx.app.vault.process(file, (rawContent) => {
      const refusal = checkWholeFilePrecondition({
        action: "overwrite",
        currentContent: rawContent,
        expectedContent: ctx.arguments.expectedContent,
        require: requirePrecondition,
        readTool: "get_active_file",
      });
      if (refusal) {
        failureText = refusal;
        return rawContent;
      }
      return ctx.arguments.content;
    });
    if (failureText !== null) {
      return errorJson(failureText, "stale_precondition", { path: file.path });
    }
    return successText("OK");
  });
}
