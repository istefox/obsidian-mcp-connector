import { FileSystemAdapter } from "obsidian";
import type McpToolsPlugin from "$/main";
import { generateMcpb } from "./mcpbGenerator";

/**
 * Generate a `.mcpb` bundle and put it where the user asks for it.
 *
 * Lives in a service rather than in the component that used to own it
 * because two surfaces now export bundles — the client-config section
 * (for the vault's first token) and every token row in Access Control
 * (for its own) — and a second copy of the Electron/vault write dance
 * is exactly how the two would drift.
 */

const FILENAME = "obsidian-mcp-connector.mcpb";

type SaveDialog = {
  showSaveDialog(options: {
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
  }): Promise<{ filePath?: string }>;
};

/** Electron's save dialog, or null on mobile and other unusual hosts. */
function electronDialog(): SaveDialog | null {
  try {
    const remote = (require("electron") as { remote?: { dialog?: SaveDialog } })
      .remote;
    return remote?.dialog ?? null;
  } catch {
    return null;
  }
}

/**
 * Args:
 *   plugin: The plugin, for the manifest version and the vault paths.
 *   tokenId: Token the bundle authenticates with. Omitted for the
 *     vault's first token, whose secret the legacy `bearerToken` field
 *     mirrors — which is what every bundle generated before per-token
 *     export reads, so those keep resolving unchanged.
 *
 * Returns:
 *   The message to show the user.
 */
export async function downloadMcpb(
  plugin: McpToolsPlugin,
  tokenId?: string,
): Promise<string> {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    return "Download .mcpb requires a desktop vault (FileSystemAdapter).";
  }

  const bytes = generateMcpb({
    version: plugin.manifest.version,
    vaultPath: adapter.getBasePath(),
    configDir: plugin.app.vault.configDir,
    tokenId,
  });

  const dialog = electronDialog();
  if (dialog) {
    const { filePath } = await dialog.showSaveDialog({
      defaultPath: FILENAME,
      filters: [{ name: "Claude Desktop Extension", extensions: ["mcpb"] }],
    });
    if (!filePath) return "Save cancelled.";
    // require() is reliable for Node built-ins in Electron; dynamic import() is not.
    const { writeFile } =
      require("fs/promises") as typeof import("fs/promises");
    await writeFile(filePath, Buffer.from(bytes));
    return `${FILENAME} saved.`;
  }

  // Vault fallback when the Electron remote is unavailable.
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  await adapter.writeBinary(FILENAME, ab as ArrayBuffer);
  return `Saved to vault root: ${FILENAME}`;
}
