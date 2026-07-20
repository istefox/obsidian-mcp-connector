import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import { TFile, type App } from "obsidian";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";

export const createVaultBinaryFileSchema = type({
  name: '"create_vault_binary_file"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path including extension (e.g. 'Images/Journal/sketch.png'). Any missing parent directories are created automatically.",
    ),
    content: type("string.base64").describe(
      "Base64-encoded file bytes. Full content of the file; if the path already exists, it is overwritten.",
    ),
  },
}).describe(
  "Creates or overwrites a binary file (image, audio, or any other non-text file) at the given vault-relative path from base64-encoded content. Missing parent directories along the path are created automatically. Use create_vault_file instead for plain text content. Note: the plugin's HTTP transport caps request bodies at 1 MiB, so the maximum writable file is roughly 750 KB after base64 overhead; larger uploads fail with HTTP 413 before reaching this tool.",
);

export type CreateVaultBinaryFileContext = {
  arguments: { path: string; content: string };
  app: App;
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

  const existing = ctx.app.vault.getAbstractFileByPath(ctx.arguments.path);
  if (existing) {
    if (!(existing instanceof TFile)) {
      return errorText(`Path ${ctx.arguments.path} is a folder, not a file.`);
    }
    await ctx.app.vault.modifyBinary(existing, buf);
  } else {
    await ensureParentFolderExists(ctx.app, ctx.arguments.path);
    await ctx.app.vault.createBinary(ctx.arguments.path, buf);
  }
  return successText("OK");
}
