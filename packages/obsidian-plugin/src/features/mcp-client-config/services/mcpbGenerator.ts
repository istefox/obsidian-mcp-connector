import { zipSync, strToU8 } from "fflate";
import { ICON_PNG_B64 } from "../assets/iconPng";
import { CONNECTOR_SHIM_SOURCE } from "../assets/connectorShimSource";

export type McpbGeneratorInput = {
  version: string;
  /** Absolute filesystem path to the vault root (`FileSystemAdapter.getBasePath()`). */
  vaultPath: string;
  /**
   * Vault's configured settings folder name (`Vault#configDir`). Almost
   * always `.obsidian`, but user-configurable — baking in the literal would
   * silently break the shim for anyone who renamed it. Defaults to
   * `.obsidian` for callers without a live App instance.
   */
  configDir?: string;
};

/**
 * Concrete shape of the generated `.mcpb` manifest.json (spec 0.3). Typed
 * literally so a typo like `entrypoint` vs `entry_point` fails to compile
 * instead of shipping a broken bundle. `user_config?: never` encodes the
 * zero-prompt-install invariant: the manifest must never carry a user_config
 * block.
 */
export interface McpbManifest {
  manifest_version: "0.3";
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: { name: string };
  icon: string;
  server: {
    type: "node";
    entry_point: string;
    mcp_config: { command: string; args: string[] };
  };
  user_config?: never;
}

const VAULT_PATH_PLACEHOLDER = '"__OBSIDIAN_MCP_VAULT_PATH__"';
const CONFIG_DIR_PLACEHOLDER = '"__OBSIDIAN_MCP_CONFIG_DIR__"';

// The shim's real source lives at services/connectorShim.js — a
// standalone, unit-tested (bun test) CommonJS Node script with zero
// dependencies. This function only substitutes the things that differ per
// generated bundle: the vault path and the vault's config folder name. See
// docs/architecture/ADR-0013-mcpb-pure-node-shim.md.
function buildShim(input: McpbGeneratorInput): string {
  if (
    !CONNECTOR_SHIM_SOURCE.includes(VAULT_PATH_PLACEHOLDER) ||
    !CONNECTOR_SHIM_SOURCE.includes(CONFIG_DIR_PLACEHOLDER)
  ) {
    throw new Error(
      "connectorShim.js is missing a placeholder — regenerate assets/connectorShimSource.ts",
    );
  }
  return CONNECTOR_SHIM_SOURCE.replace(
    VAULT_PATH_PLACEHOLDER,
    JSON.stringify(input.vaultPath),
  ).replace(
    CONFIG_DIR_PLACEHOLDER,
    JSON.stringify(input.configDir ?? ".obsidian"),
  );
}

function buildManifest(input: McpbGeneratorInput): McpbManifest {
  return {
    manifest_version: "0.3",
    name: "obsidian-mcp-connector",
    display_name: "Obsidian MCP Connector",
    version: input.version,
    description:
      "Access your Obsidian vault (semantic search, notes, Templater prompts) via MCP.",
    author: { name: "Stefano Ferri" },
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "server/index.js",
      // Launches the shim above, which resolves port + token from
      // data.json at spawn time — no secret embedded in this manifest.
      mcp_config: { command: "node", args: ["${__dirname}/server/index.js"] },
    },
  };
}

export function generateMcpb(input: McpbGeneratorInput): Uint8Array {
  const manifest = buildManifest(input);
  const manifestBytes = strToU8(JSON.stringify(manifest, null, 2));
  const shimBytes = strToU8(buildShim(input));
  const iconBytes = Uint8Array.from(atob(ICON_PNG_B64), (c) => c.charCodeAt(0));
  return zipSync({
    "manifest.json": manifestBytes,
    "server/index.js": shimBytes,
    "icon.png": iconBytes,
  });
}
