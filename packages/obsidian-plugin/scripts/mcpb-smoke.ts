#!/usr/bin/env bun
/*
 * Builds a real `.mcpb` bundle through the exact production path
 * (`generateMcpb()`) and smoke-tests the shipped `server/index.js` shim
 * end to end. No Obsidian and no vault: a throwaway HTTP server on
 * 127.0.0.1 stands in for the plugin's own MCP server, and a temporary
 * `data.json` stands in for the vault's plugin folder.
 *
 * Checks, in order:
 *   1. the archive unzips and manifest.json parses;
 *   2. server/index.js is present and, after undoing the per-bundle
 *      placeholder substitution, matches scripts/connectorShim.js on disk
 *      byte-for-byte — the artefact-level version of the freshness guard
 *      in mcpbGenerator.test.ts. Editing the shim without re-running
 *      scripts/gen-shim-source.ts silently ships the old one; this fails
 *      loud instead.
 *   3. the shim answers `initialize` under plain `node server/index.js`;
 *   4. the shim answers `initialize` loaded the way Claude Desktop's
 *      built-in Node loads it: `import(pathToFileURL(entry))`, with
 *      `process.argv[1]` pointed at the entry and `process.stdin` replaced
 *      by a plain Readable rather than the process's own stdin/tty. This
 *      is the #412 regression (ADR-0013, "Addendum (1.0.1)"): under this
 *      loader `require.main` is the HOST's module, never the shim's own,
 *      so a bare `require.main === module` guard never calls `main()` and
 *      the shim answers nothing until the client times out.
 *
 * Wired as `test:mcpb`. Nothing here talks to any host but 127.0.0.1.
 */
import { spawn } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import * as http from "http";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { strFromU8, unzipSync } from "fflate";
import { generateMcpb } from "../src/features/mcp-client-config/services/mcpbGenerator";

const VAULT_PATH_PLACEHOLDER = '"__OBSIDIAN_MCP_VAULT_PATH__"';
const CONFIG_DIR_PLACEHOLDER = '"__OBSIDIAN_MCP_CONFIG_DIR__"';
const TOKEN_ID_PLACEHOLDER = '"__OBSIDIAN_MCP_TOKEN_ID__"';

const CONFIG_DIR = ".obsidian";
const TOKEN_ID = "mcpb-smoke-token";
const TOKEN_SECRET = "mcpb-smoke-secret-do-not-use";
const CHILD_TIMEOUT_MS = 15000;

// Mimics Claude Desktop's `nodeHost.js`: overwrite argv[1] to point at the
// bundle entry (not this host file), replace process.stdin with a plain
// Readable fed from a side file (not the process's inherited stdin/tty),
// then load the entry exactly the way the built-in-Node launcher does.
const HOST_LOADER_SOURCE = `"use strict";
const fs = require("fs");
const { pathToFileURL } = require("url");
const { Readable } = require("stream");

const [, , entryPath, requestPath] = process.argv;
process.argv = ["node", entryPath];

const payload = fs.readFileSync(requestPath, "utf8");
const stdin = new Readable({ read() {} });
Object.defineProperty(process, "stdin", {
  value: stdin,
  configurable: true,
  enumerable: true,
  writable: true,
});

import(pathToFileURL(entryPath).href)
  .then(() => {
    stdin.push(payload);
    stdin.push(null);
  })
  .catch((err) => {
    console.error("host loader: import() failed:", err);
    process.exit(1);
  });
`;

type ChildResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError: Error | null;
};

function runNode(
  args: string[],
  options: { stdinPayload?: string; timeoutMs?: number } = {},
): Promise<ChildResult> {
  const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn("node", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr, code: null, timedOut: true, spawnError: null });
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut: false, spawnError: err });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false, spawnError: null });
    });
    if (options.stdinPayload !== undefined) {
      child.stdin.write(options.stdinPayload);
    }
    child.stdin.end();
  });
}

function startThrowawayServer(
  expectedToken: string,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        let id: unknown = null;
        try {
          id = (JSON.parse(body) as { id?: unknown }).id ?? null;
        } catch {
          // Falls through to the error response below with id: null.
        }
        if (req.headers.authorization !== `Bearer ${expectedToken}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32001, message: "unexpected bearer token" },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "mcpb-smoke-server", version: "0.0.0" },
            },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function writeDataJson(dataPath: string, port: number) {
  mkdirSync(dirname(dataPath), { recursive: true });
  writeFileSync(
    dataPath,
    JSON.stringify({
      mcpTransport: {
        livePort: port,
        bearerToken: TOKEN_SECRET,
        tokens: [
          { id: TOKEN_ID, label: "smoke", token: TOKEN_SECRET, createdAt: 1 },
        ],
      },
    }),
  );
}

function fail(message: string, detail?: string): never {
  throw new Error(detail ? `${message}\n${detail}` : message);
}

function assertAnswersInitialize(
  result: ChildResult,
  id: number,
  label: string,
) {
  if (result.spawnError) {
    fail(`${label}: could not spawn node`, String(result.spawnError));
  }
  if (result.timedOut) {
    fail(
      `${label}: timed out after ${CHILD_TIMEOUT_MS}ms waiting for a response`,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const line = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => {
      try {
        return (JSON.parse(l) as { id?: unknown }).id === id;
      } catch {
        return false;
      }
    });
  if (!line) {
    fail(
      `${label}: no JSON-RPC response with id ${id} on stdout`,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const parsed = JSON.parse(line!) as {
    error?: unknown;
    result?: unknown;
  };
  if (parsed.error) {
    fail(`${label}: shim answered with an error`, JSON.stringify(parsed.error));
  }
  if (!parsed.result) {
    fail(`${label}: shim answered with neither result nor error`, line);
  }
  if (result.code !== 0) {
    fail(
      `${label}: shim exited with code ${result.code}, expected 0`,
      result.stderr,
    );
  }
}

async function main() {
  const vaultDir = mkdtempSync(join(tmpdir(), "mcpb-smoke-vault-"));
  // realpath: on macOS, os.tmpdir() resolves through /var -> /private/var, a
  // symlink. Node's CJS loader resolves __filename through the real path, so
  // if entryDir stayed symlinked, the argv[1] we set for step 4 below would
  // never string-equal __filename inside the shim, and isEntryPoint's argv
  // arm would falsely read as "not the entry point" — a harness artifact
  // that would make this test fail the exact way the #412 regression does,
  // for an unrelated reason.
  const entryDir = realpathSync(
    mkdtempSync(join(tmpdir(), "mcpb-smoke-entry-")),
  );
  const dataPath = join(
    vaultDir,
    CONFIG_DIR,
    "plugins",
    "mcp-tools-istefox",
    "data.json",
  );

  const { server, port } = await startThrowawayServer(TOKEN_SECRET);
  try {
    writeDataJson(dataPath, port);

    console.log("Building .mcpb bundle via generateMcpb()...");
    const bundleBytes = generateMcpb({
      version: "0.0.0-smoke",
      vaultPath: vaultDir,
      configDir: CONFIG_DIR,
      tokenId: TOKEN_ID,
    });

    // 1. The archive unzips and manifest.json parses.
    const files = unzipSync(bundleBytes);
    const manifestBytes = files["manifest.json"];
    if (!manifestBytes) fail("manifest.json missing from the built .mcpb");
    try {
      JSON.parse(strFromU8(manifestBytes));
    } catch (err) {
      fail("manifest.json does not parse as JSON", String(err));
    }
    console.log("  ok  archive unzips, manifest.json parses");

    // 2. server/index.js is present and matches connectorShim.js on disk.
    const entryBytes = files["server/index.js"];
    if (!entryBytes) fail("server/index.js missing from the built .mcpb");
    const entrySource = strFromU8(entryBytes);
    const reconstructed = entrySource
      .replace(JSON.stringify(vaultDir), VAULT_PATH_PLACEHOLDER)
      .replace(JSON.stringify(CONFIG_DIR), CONFIG_DIR_PLACEHOLDER)
      .replace(JSON.stringify(TOKEN_ID), TOKEN_ID_PLACEHOLDER);
    const onDiskShim = readFileSync(
      join(import.meta.dir, "connectorShim.js"),
      "utf8",
    );
    if (reconstructed !== onDiskShim) {
      fail(
        "server/index.js does not match scripts/connectorShim.js",
        "assets/connectorShimSource.ts is stale — run: " +
          "bun run packages/obsidian-plugin/scripts/gen-shim-source.ts",
      );
    }
    console.log(
      "  ok  server/index.js matches scripts/connectorShim.js (generator is up to date)",
    );

    const entryPath = join(entryDir, "index.js");
    writeFileSync(entryPath, entrySource);

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcpb-smoke", version: "0.0.0" },
      },
    };
    const requestLine = `${JSON.stringify(request)}\n`;

    // 3. Plain `node server/index.js`.
    const plain = await runNode([entryPath], { stdinPayload: requestLine });
    assertAnswersInitialize(plain, request.id, "plain `node server/index.js`");
    console.log("  ok  answers initialize under plain `node server/index.js`");

    // 4. Claude Desktop's built-in-Node loader (#412 regression guard).
    const requestPath = join(entryDir, "request.json");
    writeFileSync(requestPath, requestLine);
    const hostPath = join(entryDir, "host.cjs");
    writeFileSync(hostPath, HOST_LOADER_SOURCE);
    const loaded = await runNode([hostPath, entryPath, requestPath]);
    assertAnswersInitialize(
      loaded,
      request.id,
      "Claude Desktop's built-in-Node loader (import(pathToFileURL(entry)))",
    );
    console.log(
      "  ok  answers initialize under the built-in-Node loader (#412 regression guard)",
    );

    console.log("\n.mcpb bundle smoke: all checks passed.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(entryDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
