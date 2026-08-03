import { FileSystemAdapter } from "obsidian";
import type McpToolsPlugin from "$/main";
// Direct path, not the `mcp-transport` barrel: `AccessControlSection`
// imports `$/features/mcp-client-config` and `mcp-transport/index.ts`
// re-exports that component, so the barrel would close a cycle.
// `tokenStore.ts` imports nothing from this feature, so this edge does not.
import { readTokens } from "$/features/mcp-transport/services/tokenStore";
import { generateMcpb } from "./mcpbGenerator";

/**
 * Generate a `.mcpb` bundle and put it where the user asks for it.
 *
 * Lives in a service rather than in the component because the export is
 * driven from a token row, and the Electron/vault write dance is worth
 * keeping in one testable place regardless of how many rows there are.
 *
 * There is deliberately no "export the vault's bundle" entry point. A
 * bundle authenticates as exactly one token, so the caller has to name
 * which; a helper that picked `tokens[0]` for them is how the download
 * button ends up bound to a position instead of an identity.
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

function readFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Could not read the token list, .mcpb not exported: ${message}`;
}

/**
 * Generate a `.mcpb` for one token and put it where the user asks.
 *
 * Args:
 *   plugin: The plugin, for the manifest version and the vault paths.
 *   tokenId: Token the bundle authenticates with. Validated against the
 *     live list before anything is written — an unknown id would ship a
 *     bundle that is dead on arrival, and a blank one would take the
 *     shim's legacy branch and silently resolve `bearerToken`.
 *
 * Returns:
 *   The message to show the user.
 */
export async function downloadMcpb(
  plugin: McpToolsPlugin,
  tokenId: string,
): Promise<string> {
  const id = tokenId.trim();
  if (!id) {
    return "Cannot export a .mcpb without a token id.";
  }

  // Fail closed, and before the adapter check so an unusual host gets
  // the same refusal rather than a different one: a bundle whose token
  // cannot be verified is a bundle that must not be written.
  let tokens;
  try {
    tokens = await readTokens(plugin);
  } catch (err) {
    return readFailure(err);
  }
  if (!tokens.some((t) => t.id === id)) {
    return `Token '${id}' is no longer configured — reopen Access control and export again.`;
  }

  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    return "Download .mcpb requires a desktop vault (FileSystemAdapter).";
  }

  const bytes = generateMcpb({
    version: plugin.manifest.version,
    vaultPath: adapter.getBasePath(),
    configDir: plugin.app.vault.configDir,
    tokenId: id,
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
