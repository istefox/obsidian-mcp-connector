/**
 * Command line for the headless server:
 *
 *   obsidian-mcp-headless [vault] [--no-semantic] [--http [--port N] [--data FILE] [--print-token]]
 *
 * The vault path is positional and falls back to $OBSIDIAN_VAULT. Stdio is
 * the default transport, which is what an MCP client that spawns the
 * server expects. `--http` selects the always-on service mode.
 */

import { type } from "arktype";
import { PortNumber } from "$/features/mcp-transport/types";

export type HeadlessArgs =
  | { kind: "help"; text: string }
  | { kind: "error"; message: string }
  | {
      kind: "run";
      vault: string;
      http: boolean;
      port?: number;
      data?: string;
      printToken: boolean;
      /** False under `--no-semantic`: `search_vault_smart` is not registered. */
      semantic: boolean;
    };

export const USAGE = [
  "Usage: obsidian-mcp-headless [vault-path] [options]",
  "",
  "Serves an Obsidian vault directory over MCP, without Obsidian.",
  "The vault path may also come from the OBSIDIAN_VAULT environment variable.",
  "",
  "Options:",
  "  --no-semantic    Do not offer search_vault_smart (it downloads a model on first use)",
  "  --http           Serve over HTTP on 127.0.0.1 with a bearer token (default: stdio)",
  "  --port N         HTTP port (default: the first free port from 27201)",
  "  --data FILE      State file for the HTTP token (default: under the user config dir)",
  "  --print-token    Print the HTTP bearer token and exit",
  "  --help           Show this help",
].join("\n");

/** The first Node 24 LTS release, the oldest Node the server supports. */
export const MIN_NODE_VERSION = "24.11.0";

/**
 * Why `version` (a `process.versions.node` string) cannot run the server,
 * or undefined when it can.
 */
export function unsupportedNodeReason(version: string): string | undefined {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const have = parts(version);
  const need = parts(MIN_NODE_VERSION);
  for (let i = 0; i < need.length; i += 1) {
    const h = have[i] ?? 0;
    if (h > need[i]) return undefined;
    if (h < need[i]) break;
    if (i === need.length - 1) return undefined;
  }
  return `obsidian-mcp-headless needs Node ${MIN_NODE_VERSION} or newer, found ${version}`;
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): HeadlessArgs {
  let vault: string | undefined;
  let http = false;
  let port: number | undefined;
  let data: string | undefined;
  let printToken = false;
  let semantic = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string | undefined => argv[++i];
    switch (arg) {
      case "--help":
      case "-h":
        return { kind: "help", text: USAGE };
      case "--http":
        http = true;
        break;
      case "--print-token":
        printToken = true;
        break;
      case "--no-semantic":
        semantic = false;
        break;
      case "--port": {
        const raw = value();
        const parsed = PortNumber(raw === undefined ? NaN : Number(raw));
        if (parsed instanceof type.errors) {
          return {
            kind: "error",
            message: "--port needs an integer from 1024 to 65535",
          };
        }
        port = parsed;
        break;
      }
      case "--data": {
        data = value();
        if (!data)
          return { kind: "error", message: "--data needs a file path" };
        break;
      }
      default:
        if (arg.startsWith("-")) {
          return { kind: "error", message: `Unknown option: ${arg}` };
        }
        if (vault !== undefined) {
          return { kind: "error", message: "Only one vault path is accepted" };
        }
        vault = arg;
    }
  }

  vault ??= env.OBSIDIAN_VAULT || undefined;
  if (!vault) {
    return {
      kind: "error",
      message:
        "Missing vault path. Usage: obsidian-mcp-headless /path/to/vault",
    };
  }
  if (!http && (port !== undefined || data !== undefined || printToken)) {
    return {
      kind: "error",
      message: "--port, --data and --print-token only apply with --http",
    };
  }
  return { kind: "run", vault, http, port, data, printToken, semantic };
}
