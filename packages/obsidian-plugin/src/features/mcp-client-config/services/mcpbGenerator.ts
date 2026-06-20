import { zipSync, strToU8 } from "fflate";

export type McpbGeneratorInput = {
  version: string;
  port: number;
};

// Fallback launcher satisfying the entry_point schema requirement.
// Claude Desktop typically invokes npx mcp-remote directly via mcp_config;
// this shim handles the case where the entry_point is executed instead.
const SERVER_SHIM = `#!/usr/bin/env node
const { spawn } = require("child_process");
const url = process.env.MCP_REMOTE_URL || "http://127.0.0.1:27200/mcp";
const token = process.env.MCP_REMOTE_TOKEN || "";
const args = ["-y", "mcp-remote", url];
if (token) args.push("--header", \`Authorization: Bearer \${token}\`);
spawn("npx", args, { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
`;

function buildManifest(input: McpbGeneratorInput): Record<string, unknown> {
  return {
    manifest_version: "0.3",
    name: "obsidian-mcp-connector",
    display_name: "Obsidian MCP Connector",
    version: input.version,
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
        default: String(input.port),
        required: false,
      },
    },
  };
}

export function generateMcpb(input: McpbGeneratorInput): Uint8Array {
  const manifest = buildManifest(input);
  const manifestBytes = strToU8(JSON.stringify(manifest, null, 2));
  const shimBytes = strToU8(SERVER_SHIM);
  return zipSync({
    "manifest.json": manifestBytes,
    "server/index.js": shimBytes,
  });
}
