import { type } from "arktype";
import { errorJson, successText } from "../services/responseBuilders";
import { TFile, type App } from "obsidian";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";
import { checkCreatePrecondition } from "$/features/mcp-tools/services/createPrecondition";
import { resolveRequireWritePreconditions } from "$/features/mcp-tools/services/writePreconditionSetting";
import type McpToolsPlugin from "$/main";

export const createVaultFileSchema = type({
  name: '"create_vault_file"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path including extension (e.g. 'Notes/new.md'). Any missing parent directories are created automatically.",
    ),
    content: type("string").describe(
      "Full content of the file. An existing path is overwritten: pass expectedContent to guard against overwriting a change you have not seen (mandatory if this vault requires write preconditions).",
    ),
    "expectedContent?": type("string").describe(
      "The whole current content of the file, as read via get_vault_file; only for an existing path. When it no longer matches, the write is refused instead of overwriting a change you have not seen. Whitespace-insensitive, compared over the WHOLE file: to change part of a file use patch_vault_file. Omit it for a new file; a non-empty value is refused if the path does not exist.",
    ),
  },
}).describe(
  "Creates a new file at the given vault-relative path, or overwrites it if it already exists — guarded by expectedContent when given, or required by this vault's write-precondition setting. Missing parent directories along the path are created automatically.",
);

export type CreateVaultFileContext = {
  arguments: { path: string; content: string; expectedContent?: string };
  app: App;
  /**
   * Absent in partial test fixtures, exactly as in getVaultFile's context.
   * Without it the write-precondition setting resolves to its default (off),
   * which is the behaviour every existing client already relies on.
   */
  plugin?: McpToolsPlugin;
};

export async function createVaultFileHandler(
  ctx: CreateVaultFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  // Resolved here, before the lock: this read is async, and the compute it
  // guards (the overwrite branch's precondition check) must stay
  // synchronous inside vault.process, same reasoning as patchVaultFile.ts.
  const requirePrecondition = await resolveRequireWritePreconditions(
    ctx.plugin,
  );

  // Exists-check → create is a two-step TOCTOU against concurrent MCP
  // writes, so the whole branch runs under the vault write lock (see
  // vaultWriteLock.ts). The overwrite branch now compares-then-writes
  // inside vault.process instead of a bare modify (ADR-0022): a concurrent
  // writer (the editor, Obsidian Sync) can no longer land a change between
  // the compare and the write and have it silently discarded — the same
  // lost-update class vaultWriteLock.ts's own header calls out.
  return withVaultWriteLock(async () => {
    const existing = ctx.app.vault.getAbstractFileByPath(ctx.arguments.path);
    if (existing) {
      if (!(existing instanceof TFile)) {
        return errorJson(
          `Path ${ctx.arguments.path} is a folder, not a file.`,
          "not_a_file",
          { path: ctx.arguments.path },
        );
      }
      let failureText: string | null = null;
      await ctx.app.vault.process(existing, (rawContent) => {
        const refusal = checkCreatePrecondition({
          exists: true,
          currentContent: rawContent,
          expectedContent: ctx.arguments.expectedContent,
          require: requirePrecondition,
        });
        if (refusal) {
          failureText = refusal;
          return rawContent;
        }
        return ctx.arguments.content;
      });
      if (failureText !== null) {
        return errorJson(failureText, "stale_precondition", {
          path: ctx.arguments.path,
        });
      }
    } else {
      const refusal = checkCreatePrecondition({
        exists: false,
        currentContent: "",
        expectedContent: ctx.arguments.expectedContent,
        require: requirePrecondition,
      });
      if (refusal) {
        return errorJson(refusal, "stale_precondition", {
          path: ctx.arguments.path,
        });
      }
      await ensureParentFolderExists(ctx.app, ctx.arguments.path);
      await ctx.app.vault.create(ctx.arguments.path, ctx.arguments.content);
    }
    return successText("OK");
  });
}
