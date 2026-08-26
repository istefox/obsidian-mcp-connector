import { type } from "arktype";
import {
  errorJson,
  errorText,
  successText,
} from "../services/responseBuilders";
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
      "Base64-encoded file bytes. Full content of the file; if the path already exists, it is overwritten — pass overwrite: true to confirm that deliberately. If this vault requires write preconditions, overwrite: true is mandatory to replace an existing file.",
    ),
    "overwrite?": type("boolean").describe(
      "Only meaningful when the path already exists. Must be true to replace an existing file when this vault requires write preconditions; when the setting is off, an existing file is overwritten by default unless this is explicitly false. Ignored when the path does not exist yet — creating a brand-new file is never blocked by this or by the setting. A plain boolean rather than a content comparison (contrast create_vault_file's expectedContent): binary bytes have no meaningful whole-file diff to show a caller, and the risk here is writing to the wrong path, not stale content.",
    ),
  },
}).describe(
  "Creates a new binary file (image, audio, or any other non-text file) at the given vault-relative path from base64-encoded content, or overwrites it if it already exists — guarded by overwrite when given, or required by this vault's write-precondition setting. Missing parent directories along the path are created automatically. Use create_vault_file instead for plain text content. Note: the plugin's HTTP transport caps request bodies at 1 MiB, so the maximum writable file is roughly 750 KB after base64 overhead; larger uploads fail with HTTP 413 before reaching this tool.",
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
    return errorText(`Content for ${ctx.arguments.path} is not valid base64.`);
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
        return errorText(`Path ${ctx.arguments.path} is a folder, not a file.`);
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
