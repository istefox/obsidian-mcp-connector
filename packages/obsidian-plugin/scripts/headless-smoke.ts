#!/usr/bin/env bun
/*
 * Smoke test for the headless bundle, run against the real file under real
 * `node` (build it first: `build:headless`, which `test:headless` does).
 *
 * Stdio is the primary path: the client spawns the server on a temp vault
 * and speaks newline-delimited JSON-RPC. Checked in order:
 *   - stdout carries only JSON-RPC messages, also after a JsonLogic `log`
 *     query, which prints through `console.log`;
 *   - `initialize` and `tools/list` answer, and desktop-only tools are absent;
 *   - a note reads back;
 *   - a created note is immediately visible to properties, tags and backlinks;
 *   - an edit made outside the server becomes visible, polled against a
 *     bounded deadline derived from the watcher debounce;
 *   - closing stdin exits 0.
 * Then the install the README gives: the file copied under an extensionless
 * name into a folder with no package.json and run through its shebang,
 * with module detection off where Node has the switch, which is how Node
 * releases without detection load it. It must answer `initialize` and
 * `tools/list`.
 * Then a shorter HTTP check on the port the server binds itself (read from
 * its "Listening on" line, so no other process can take it in between): no
 * token is 401, a token lists tools in both protocol eras, SIGTERM exits 0.
 *
 * Nothing here touches any host but 127.0.0.1. Temp dirs are removed.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_ONLY_TOOLS } from "../src/headless/toolSets";
import { WATCH_DEBOUNCE_MS } from "../src/headless/watcher";

const BUNDLE = join(
  import.meta.dir,
  "../dist/headless/obsidian-mcp-headless.js",
);

/** The watcher settles a path after the debounce; the rest is slack for a slow disk. */
const VISIBLE_DEADLINE_MS = WATCH_DEBOUNCE_MS * 50;
const POLL_MS = 50;
/** Hang guard for a reply or an exit, not a timing assertion. */
const REPLY_GUARD_MS = 15000;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.warn(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`, detail ?? "");
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, REPLY_GUARD_MS);
    child.once("exit", (code) => {
      clearTimeout(guard);
      resolve(code);
    });
  });
}

type Reply = {
  id?: number;
  result?: Record<string, unknown>;
  error?: unknown;
};

/** A stdio MCP client over a spawned server. */
class StdioClient {
  readonly child: ChildProcess;
  readonly stdoutLines: string[] = [];
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, (reply: Reply) => void>();

  constructor(command: string[], env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "pipe", "ignore"],
      env,
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (
        let nl = this.buffer.indexOf("\n");
        nl >= 0;
        nl = this.buffer.indexOf("\n")
      ) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line === "") continue;
        this.stdoutLines.push(line);
        try {
          const reply = JSON.parse(line) as Reply;
          if (reply.id !== undefined) this.waiting.get(reply.id)?.(reply);
        } catch {
          // Reported by the stdout-is-JSON-RPC check.
        }
      }
    });
  }

  request(method: string, params: unknown = {}): Promise<Reply> {
    const id = this.nextId++;
    const reply = new Promise<Reply>((resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error(`No reply to ${method}`)),
        REPLY_GUARD_MS,
      );
      this.waiting.set(id, (r) => {
        clearTimeout(guard);
        resolve(r);
      });
    });
    this.child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return reply;
  }

  notify(method: string): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  /** Call a tool and return its first text block. */
  async tool(name: string, args: Record<string, unknown>): Promise<string> {
    const reply = await this.request("tools/call", { name, arguments: args });
    const content = reply.result?.content as
      | Array<{ type: string; text?: string }>
      | undefined;
    return content?.[0]?.text ?? JSON.stringify(reply);
  }
}

async function stdioChecks(vault: string): Promise<void> {
  const client = new StdioClient(["node", BUNDLE, vault]);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "headless-smoke", version: "0" },
    });
    check(
      "stdio: initialize answers",
      init.result?.protocolVersion !== undefined,
      init,
    );
    client.notify("notifications/initialized");

    const list = await client.request("tools/list");
    const names = (
      (list.result?.tools as Array<{ name: string }> | undefined) ?? []
    ).map((t) => t.name);
    check(
      "stdio: tools/list serves vault tools",
      names.includes("get_vault_file"),
    );
    const leaked = DESKTOP_ONLY_TOOLS.filter((n) => names.includes(n));
    check("stdio: desktop-only tools are absent", leaked.length === 0, leaked);

    const read = await client.tool("get_vault_file", { path: "Note.md" });
    check(
      "stdio: get_vault_file reads a note",
      read.includes("Seed body"),
      read,
    );

    await client.tool("create_vault_file", {
      path: "Fresh.md",
      content: "---\nstatus: new\n---\nHello #smoke-tag and [[Note]]\n",
    });
    const props = await client.tool("get_note_properties", {
      path: "Fresh.md",
    });
    check(
      "stdio: new note's properties visible at once",
      props.includes("new"),
      props,
    );
    const tagged = await client.tool("get_files_by_tag", { tag: "smoke-tag" });
    check(
      "stdio: new note's tag visible at once",
      tagged.includes("Fresh.md"),
      tagged,
    );
    const back = await client.tool("get_backlinks", { path: "Note.md" });
    check(
      "stdio: new note's backlink visible at once",
      back.includes("Fresh.md"),
      back,
    );

    writeFileSync(join(vault, "External.md"), "Edited outside #ext-tag\n");
    const deadline = Date.now() + VISIBLE_DEADLINE_MS;
    let seen = false;
    while (!seen && Date.now() < deadline) {
      seen = (
        await client.tool("get_files_by_tag", { tag: "ext-tag" })
      ).includes("External.md");
      if (!seen) await sleep(POLL_MS);
    }
    check("stdio: external write becomes visible", seen);

    await client.tool("search_vault", {
      queryType: "jsonlogic",
      query: JSON.stringify({ log: "smoke-log-marker" }),
    });

    const jsonOnly = client.stdoutLines.every((line) => {
      try {
        return (JSON.parse(line) as { jsonrpc?: string }).jsonrpc === "2.0";
      } catch {
        return false;
      }
    });
    check("stdio: stdout carries only JSON-RPC", jsonOnly, client.stdoutLines);

    client.child.stdin!.end();
    check("stdio: closing stdin exits 0", (await exited(client.child)) === 0);
  } catch (err) {
    check("stdio: session completed", false, err);
    client.child.kill("SIGKILL");
  }
}

async function installedChecks(vault: string, workDir: string): Promise<void> {
  const bin = join(workDir, "bin");
  mkdirSync(bin);
  const exe = join(bin, "obsidian-mcp-headless");
  copyFileSync(BUNDLE, exe);
  chmodSync(exe, 0o755);
  const canDisable =
    spawnSync("node", ["--no-experimental-detect-module", "-e", ""]).status ===
    0;
  const env = canDisable
    ? {
        ...process.env,
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --no-experimental-detect-module`.trim(),
      }
    : process.env;
  const client = new StdioClient([exe, vault], env);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "headless-smoke", version: "0" },
    });
    check(
      "installed: extensionless file answers initialize",
      init.result?.protocolVersion !== undefined,
      init,
    );
    client.notify("notifications/initialized");
    const list = await client.request("tools/list");
    check(
      "installed: extensionless file lists tools",
      JSON.stringify(list.result ?? {}).includes("get_vault_file"),
    );
    client.child.stdin!.end();
    check(
      "installed: closing stdin exits 0",
      (await exited(client.child)) === 0,
    );
  } catch (err) {
    check("installed: session completed", false, err);
    client.child.kill("SIGKILL");
  }
}

async function post(
  port: number,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function httpChecks(vault: string, workDir: string): Promise<void> {
  const state = join(workDir, "state.json");

  const printed = spawnSync(
    "node",
    [BUNDLE, vault, "--http", "--print-token", "--data", state],
    { encoding: "utf8" },
  );
  const token = printed.stdout.trim();
  check(
    "http: --print-token prints a token and exits 0",
    printed.status === 0 && token.length > 20,
  );

  const server = spawn("node", [BUNDLE, vault, "--http", "--data", state], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    // Whole lines only: a chunk boundary may split the one being read.
    const port = await new Promise<number>((resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error("server did not start")),
        REPLY_GUARD_MS,
      );
      let pending = "";
      server.stderr!.setEncoding("utf8");
      server.stderr!.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          const m = /Listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(line);
          if (m) {
            clearTimeout(guard);
            resolve(Number(m[1]));
          }
        }
      });
      server.once("exit", () => reject(new Error("server exited early")));
    });

    const listBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };
    const anon = await post(port, null, listBody);
    check(
      "http: request without a token is 401",
      anon.status === 401,
      anon.status,
    );

    const legacy = await post(port, token, listBody, {
      "mcp-protocol-version": "2025-06-18",
    });
    check(
      "http: legacy era lists tools",
      legacy.status === 200 && legacy.text.includes("get_vault_file"),
      legacy.text.slice(0, 200),
    );

    const modern = await post(
      port,
      token,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    );
    check(
      "http: modern era lists tools",
      modern.status === 200 && modern.text.includes("get_vault_file"),
      modern.text.slice(0, 200),
    );

    const info = await post(
      port,
      token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_server_info", arguments: {} },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    check(
      "http: get_server_info reports the bound port",
      info.status === 200 && info.text.includes(String(port)),
      info.text.slice(0, 300),
    );

    server.kill("SIGTERM");
    check("http: SIGTERM exits 0", (await exited(server)) === 0);
  } catch (err) {
    check("http: session completed", false, err);
    server.kill("SIGKILL");
  }
}

async function main(): Promise<void> {
  if (!existsSync(BUNDLE)) {
    console.error(`Missing ${BUNDLE}; run build:headless first.`);
    process.exit(1);
  }
  const workDir = mkdtempSync(join(tmpdir(), "headless-smoke-"));
  try {
    const stdioVault = join(workDir, "vault-stdio");
    mkdirSync(stdioVault);
    writeFileSync(
      join(stdioVault, "Note.md"),
      "---\ntitle: Seed\n---\n# Note\nSeed body\n",
    );
    await stdioChecks(stdioVault);
    await installedChecks(stdioVault, workDir);

    const httpVault = join(workDir, "vault-http");
    mkdirSync(httpVault);
    writeFileSync(join(httpVault, "Note.md"), "# Note\nSeed body\n");
    await httpChecks(httpVault, workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`${failures} headless smoke check(s) failed`);
    process.exit(1);
  }
  console.warn("Headless smoke passed");
}

await main();
