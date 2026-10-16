/**
 * Entry point of the headless server: the MCP vault tools served from a
 * vault directory, with no Obsidian.
 *
 * Stdio (default) is what an MCP client that spawns the server speaks:
 * newline-delimited JSON-RPC on stdin and stdout, nothing else on stdout.
 * `--http` is the always-on service: 127.0.0.1 only, bearer token from the
 * same token store the desktop plugin uses.
 */

import fs from "node:fs/promises";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { updateTokenPolicy } from "$/features/adaptive-tool-loading/tokenPolicyStore";
import {
  createMcpService,
  destroyMcpService,
} from "$/features/mcp-transport/services/mcpServer";
import {
  resolveServerName,
  setup,
  teardown,
} from "$/features/mcp-transport/services/setup";
import { ensureTokenStore } from "$/features/mcp-transport/services/tokenStore";
import { logger } from "$/shared/logger";
import { DEFAULT_LOG_LEVEL } from "$/shared/log/logLine";
import manifest from "../../../../manifest.json";
import { parseArgs, unsupportedNodeReason } from "./args";
import { createHeadlessApp } from "./headlessApp";
import {
  asPlugin,
  checkDataOutsideVault,
  createFileHost,
  createMemoryHost,
  defaultDataPath,
  withFixedPort,
  type HostParts,
} from "./hostData";
import { createHeadlessSemantic } from "./semanticSearch";
import { createShutdown, unrefTimer } from "./shutdown";
import { routeConsoleToStderr, stderrLogFs } from "./stderrLogFs";

/** The token id a stdio session is served under; there is no real token. */
const STDIO_SESSION = "stdio";

const hostManifest = { id: manifest.id, version: manifest.version };

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

function onShutdown(cleanup: () => Promise<void>): void {
  const shutdown = createShutdown(cleanup, {
    exit: (code) => process.exit(code),
    say,
    startTimer: unrefTimer,
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
}

async function serveOverStdio(
  vaultDir: string,
  semantic: boolean,
): Promise<void> {
  routeConsoleToStderr();
  const { app, close } = await createHeadlessApp(vaultDir);
  const host = createMemoryHost({ app, manifest: hostManifest });
  const search = semantic
    ? createHeadlessSemantic(app, await fs.realpath(vaultDir), host)
    : undefined;
  host.semanticGate = search?.gate;
  // No token means no stored policy, and an unknown id would get the
  // restricted "adaptive" profile. A client that spawned this process owns
  // it, so the whole tool set is its surface.
  await updateTokenPolicy(host, STDIO_SESSION, { profile: "all" });
  const service = await createMcpService({
    app,
    plugin: asPlugin(host),
    pluginVersion: hostManifest.version,
    serverName: resolveServerName(app, undefined),
  });
  const handle = serveStdio((ctx) =>
    service.buildMcpServer(STDIO_SESSION, ctx.era === "modern"),
  );
  say(
    `obsidian-mcp-headless ${hostManifest.version} serving ${vaultDir} over stdio`,
  );
  onShutdown(async () => {
    await handle.close();
    await destroyMcpService(service);
    await search?.teardown();
    close();
    await logger.flush();
  });
}

async function serveOverHttp(
  vaultDir: string,
  options: {
    port?: number;
    data?: string;
    printToken: boolean;
    semantic: boolean;
  },
): Promise<void> {
  const real = await fs.realpath(vaultDir);
  const dataFile = await checkDataOutsideVault(
    options.data ?? defaultDataPath(real),
    real,
  );

  if (options.printToken) {
    // The token store needs a host with an `app` only for the server name,
    // which printing does not use.
    const host = await createFileHost(
      { app: {} as HostParts["app"], manifest: hostManifest },
      dataFile,
    );
    const tokens = await ensureTokenStore(host);
    process.stdout.write(`${tokens[0].token}\n`);
    return;
  }

  const { app, close } = await createHeadlessApp(real);
  const stored = await createFileHost(
    { app, manifest: hostManifest },
    dataFile,
  );
  const host =
    options.port === undefined ? stored : withFixedPort(stored, options.port);
  const search = options.semantic
    ? createHeadlessSemantic(app, real, host)
    : undefined;
  host.semanticGate = search?.gate;
  const result = await setup(asPlugin(host));
  if (!result.success) {
    await search?.teardown();
    close();
    throw new Error(
      options.port !== undefined && result.error.includes("is in use")
        ? `Port ${options.port} is in use. Free it or choose another --port.`
        : result.error,
    );
  }
  // `get_server_info` reads the bound port from here, as on the desktop.
  host.mcpTransportState = result.state;
  say(`obsidian-mcp-headless ${hostManifest.version} serving ${real}`);
  say(`Listening on http://127.0.0.1:${result.state.server.port}/mcp`);
  say(`Bearer token: run with --http --print-token (state file: ${dataFile})`);
  onShutdown(async () => {
    await teardown(result.state);
    await search?.teardown();
    close();
    await logger.flush();
  });
}

async function main(): Promise<void> {
  const unsupported = unsupportedNodeReason(process.versions.node);
  if (unsupported) {
    say(unsupported);
    process.exitCode = 1;
    return;
  }
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.kind === "help") {
    process.stdout.write(`${args.text}\n`);
    return;
  }
  if (args.kind === "error") {
    say(args.message);
    process.exitCode = 2;
    return;
  }
  logger.configure({ dir: "", level: DEFAULT_LOG_LEVEL, fs: stderrLogFs });
  if (args.http) await serveOverHttp(args.vault, args);
  else await serveOverStdio(args.vault, args.semantic);
}

main().catch((err: unknown) => {
  say(
    `obsidian-mcp-headless: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
