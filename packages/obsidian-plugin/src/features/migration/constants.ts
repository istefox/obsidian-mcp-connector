/**
 * Legacy-binary path/name constants. Relocated from the retired
 * 0.3.x binary-installer module — `migration/services/detect.ts` is
 * the only live 0.4.x consumer (it must still recognise a leftover
 * 0.3.x binary on disk to drive the migration UX).
 */
export const BINARY_NAME = {
  windows: "mcp-server.exe",
  macos: "mcp-server",
  linux: "mcp-server",
} as const;

export const INSTALL_PATH = {
  macos: "~/Library/Application Support/obsidian-mcp-tools/bin",
  windows: "%APPDATA%\\obsidian-mcp-tools\\bin",
  linux: "~/.local/share/obsidian-mcp-tools/bin",
} as const;

export const PLATFORM_TYPES = ["windows", "macos", "linux"] as const;
export type Platform = (typeof PLATFORM_TYPES)[number];
