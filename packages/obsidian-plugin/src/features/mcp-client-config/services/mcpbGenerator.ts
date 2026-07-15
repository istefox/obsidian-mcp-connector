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
//
// Claude Desktop can launch this before Obsidian's window has finished
// opening (the app process can be alive with no vault loaded yet, e.g.
// after the window was closed rather than quit), so the server may not
// be listening on the first attempt. waitForServer() polls data.json +
// a raw TCP probe for up to 30s before giving up, instead of failing
// immediately against a port nothing is listening on yet.
function buildShim(input: McpbGeneratorInput): string {
  return `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const vaultPath = ${JSON.stringify(input.vaultPath)};
const dataPath = path.join(vaultPath, ".obsidian", "plugins", ${JSON.stringify(OBSIDIAN_PLUGIN_ID)}, "data.json");

const RETRY_WINDOW_MS = 30000;
const RETRY_INTERVAL_MS = 1000;

function readTransport() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  } catch (err) {
    return { error: \`could not read \${dataPath}: \${err.message}\` };
  }
  const transport = data.mcpTransport || {};
  const port = transport.livePort;
  const token = transport.bearerToken;
  if (!port || !token) {
    return { error: \`\${dataPath} is missing mcpTransport.livePort or mcpTransport.bearerToken\` };
  }
  return { port, token };
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-reads data.json on every attempt, not just once: a slow-starting
// plugin can still be mid-fallback across the port range when this
// first runs, so an early read could catch a livePort value that is
// about to change.
async function waitForServer() {
  const deadline = Date.now() + RETRY_WINDOW_MS;
  let lastError = "timed out waiting for the MCP server";
  while (Date.now() < deadline) {
    const resolved = readTransport();
    if (resolved.error) {
      lastError = resolved.error;
    } else if (await probePort(resolved.port)) {
      return resolved;
    } else {
      lastError = \`port \${resolved.port} is not accepting connections yet\`;
    }
    await sleep(RETRY_INTERVAL_MS);
  }
  console.error(\`obsidian-mcp-connector: \${lastError} — is Obsidian open with the vault loaded?\`);
  process.exit(1);
}

(async () => {
  const { port, token } = await waitForServer();
  const url = \`http://127.0.0.1:\${port}/mcp\`;
  const args = ["-y", "mcp-remote", url, "--header", \`Authorization: Bearer \${token}\`];
  spawn("npx", args, { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
})();
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
