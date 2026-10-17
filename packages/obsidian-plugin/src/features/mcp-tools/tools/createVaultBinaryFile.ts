import { type } from "arktype";
import { errorJson, successText } from "../services/responseBuilders";
import { TFile, type App } from "obsidian";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";
import { checkCreateBinaryPrecondition } from "$/features/mcp-tools/services/createPrecondition";
import { resolveRequireWritePreconditions } from "$/features/mcp-tools/services/writePreconditionSetting";
import type McpToolsPlugin from "$/main";

export const createVaultBinaryFileSchema = type({
  name: '"create_vault_binary_file"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path including extension (e.g. 'Images/Journal/sketch.png'). Any missing parent directories are created automatically.",
    ),
    content: type("string.base64").describe(
      "Base64-encoded file bytes. An existing path is overwritten: pass overwrite: true to confirm (mandatory if this vault requires write preconditions).",
    ),
    "overwrite?": type("boolean").describe(
      "Only meaningful when the path already exists. Must be true to replace an existing file when this vault requires write preconditions; when the setting is off, an existing file is overwritten unless this is explicitly false. Ignored for a new path. A plain boolean, not a content comparison: the risk here is the wrong path, not stale content.",
    ),
  },
}).describe(
  "Creates a binary file (image, audio, any non-text file) from base64 content, overwriting an existing one when `overwrite` allows it; missing parent directories are created. Use create_vault_file for plain text. Request bodies are capped at 1 MiB (about 750 KB of file after base64); larger fails with HTTP 413.",
);

export type CreateVaultBinaryFileContext = {
  arguments: { path: string; content: string; overwrite?: boolean };
  app: App;
  /**
   * Absent in partial test fixtures, exactly as in getVaultFile's context.
   * Without it the write-precondition setting resolves to its default (off),
   * which is the behaviour every existing client already relies on.
   */
  plugin?: McpToolsPlugin;
};

/**
 * Decode a base64 string to an ArrayBuffer using the browser-compatible
 * atob() built-in, mirroring the encode direction in getVaultFile.ts's
 * bufToBase64 — avoids a Node.js Buffer dependency so the same code runs
 * inside the Obsidian plugin (renderer process / Bun test runtime).
 */
export function base64ToBuf(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function createVaultBinaryFileHandler(
  ctx: CreateVaultBinaryFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  let buf: ArrayBuffer;
  try {
    buf = base64ToBuf(ctx.arguments.content);
  } catch {
    return errorJson(
      `Content for ${ctx.arguments.path} is not valid base64.`,
      "invalid_base64",
      { path: ctx.arguments.path },
    );
  }

  // Resolved before the lock: this read is async.
  const requirePrecondition = await resolveRequireWritePreconditions(
    ctx.plugin,
  );

  // Exists-check → write is a two-step TOCTOU against concurrent MCP
  // writes — an independent bug from create_vault_file's, since this
  // handler never acquired the lock at all before ADR-0022. There is no
  // content to compare here (pure binary bytes), so unlike
  // create_vault_file's vault.process compare-then-write, this is a plain
  // existence + flag check inside the lock.
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
      const refusal = checkCreateBinaryPrecondition({
        exists: true,
        overwrite: ctx.arguments.overwrite,
        require: requirePrecondition,
      });
      if (refusal) {
        return errorJson(refusal, "stale_precondition", {
          path: ctx.arguments.path,
        });
      }
      await ctx.app.vault.modifyBinary(existing, buf);
    } else {
      await ensureParentFolderExists(ctx.app, ctx.arguments.path);
      await ctx.app.vault.createBinary(ctx.arguments.path, buf);
    }
    return successText("OK");
  });
}
