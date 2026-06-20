import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { zipSync, strToU8 } from "fflate";
import { version } from "../../../package.json" with { type: "json" };

const MANIFEST = {
  manifest_version: "0.3",
  name: "obsidian-mcp-connector",
  display_name: "Obsidian MCP Connector",
  version,
  description:
    "Access your Obsidian vault (semantic search, notes, Templater prompts) via MCP.",
  author: { name: "Stefano Ferri" },
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:${user_config.port}/mcp",
        "--header",
        "Authorization: Bearer ${user_config.token}",
      ],
    },
  },
  user_config: {
    token: {
      type: "string",
      title: "Plugin API key",
      description:
        "Bearer token shown in Obsidian → MCP Connector → Access Control.",
      sensitive: true,
      required: true,
    },
    port: {
      type: "string",
      title: "Server port",
      description: "Port the Obsidian MCP plugin listens on.",
      default: "27200",
      required: false,
    },
  },
};

const SERVER_SHIM = `#!/usr/bin/env node
const { spawn } = require("child_process");
const url = process.env.MCP_REMOTE_URL || "http://127.0.0.1:27200/mcp";
const token = process.env.MCP_REMOTE_TOKEN || "";
const args = ["-y", "mcp-remote", url];
if (token) args.push("--header", \`Authorization: Bearer \${token}\`);
spawn("npx", args, { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
`;

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const outPath = join(repoRoot, "obsidian-mcp-connector.mcpb");

const files: Record<string, Uint8Array> = {
  "manifest.json": strToU8(JSON.stringify(MANIFEST, null, 2)),
  "server/index.js": strToU8(SERVER_SHIM),
};

const iconPath = join(import.meta.dir, "..", "assets", "icon.png");
if (existsSync(iconPath)) {
  files["icon.png"] = new Uint8Array(readFileSync(iconPath));
}

const mcpbBytes = zipSync(files);
writeFileSync(outPath, mcpbBytes);
console.log(`Built ${outPath} (${mcpbBytes.length} bytes)`);
