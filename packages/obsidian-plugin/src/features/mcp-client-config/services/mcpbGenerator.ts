import { zipSync, strToU8 } from "fflate";
import { ICON_PNG_B64 } from "../assets/iconPng";

export type McpbGeneratorInput = {
  version: string;
  /** Absolute filesystem path to the vault root (`FileSystemAdapter.getBasePath()`). */
  vaultPath: string;
};

// Obsidian's plugin folder id (`obsidian-mcp-tools/manifest.json` "id"),
// distinct from the mcp_config "name" below — this is the path segment
// under `<vault>/.obsidian/plugins/`.
const OBSIDIAN_PLUGIN_ID = "mcp-tools-istefox";

// Entry-point shim, actually invoked via manifest.json's `mcp_config`
// (see buildManifest). Only the vault path is baked in — port and
// token are resolved fresh from data.json on every spawn, so an
// already-installed bundle keeps working across a token rotation or a
// port that fell back to a different value in the range, with no
// re-export/reinstall (see setup.ts's `livePort` write-back).
function buildShim(input: McpbGeneratorInput): string {
  return `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const vaultPath = ${JSON.stringify(input.vaultPath)};
const dataPath = path.join(vaultPath, ".obsidian", "plugins", ${JSON.stringify(OBSIDIAN_PLUGIN_ID)}, "data.json");

let data;
try {
  data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
} catch (err) {
  console.error(\`obsidian-mcp-connector: could not read \${dataPath}: \${err.message}\`);
  process.exit(1);
}

const transport = data.mcpTransport || {};
const port = transport.livePort;
const token = transport.bearerToken;
if (!port || !token) {
  console.error(\`obsidian-mcp-connector: \${dataPath} is missing mcpTransport.livePort or mcpTransport.bearerToken — is Obsidian running?\`);
  process.exit(1);
}

const url = \`http://127.0.0.1:\${port}/mcp\`;
const args = ["-y", "mcp-remote", url, "--header", \`Authorization: Bearer \${token}\`];
spawn("npx", args, { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
`;
}

function buildManifest(input: McpbGeneratorInput): Record<string, unknown> {
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
      mcp_config: { command: "node", args: ["server/index.js"] },
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
