#!/usr/bin/env bun
/*
 * Smoke test for the headless bundle, run against the real file under real
 * `node` (build it first: `build:headless`, which `test:headless` does).
 *
 * Stdio is the primary path: the client spawns the server on a temp vault
 * and speaks newline-delimited JSON-RPC. Checked in order:
 *   - stdout carries only JSON-RPC messages, also after a JsonLogic `log`
 *     query, which prints through `console.log`;
 *   - `initialize` and `tools/list` answer, desktop-only tools are absent, and
 *     `search_vault_smart` is listed but nothing is downloaded by starting
 *     (it is never called here: the first call downloads a model);
 *   - a note reads back;
 *   - a created note is immediately visible to properties, tags and backlinks;
 *   - an edit made outside the server becomes visible, polled against a
 *     bounded deadline derived from the watcher debounce;
 *   - file-name search finds a note, and renaming a note rewrites the links
 *     to it in another note;
 *   - the vault's `.obsidian` settings apply: a path in "Excluded files" is
 *     hidden from file-name search, and the daily note tool creates its note
 *     in the configured folder from the configured template, which
 *     `append_to_periodic_note` then extends;
 *   - `fetch` is served, and refuses loopback addresses however they are
 *     spelled, before any request reaches a server on this machine (a
 *     successful fetch needs a public host, which this script never
 *     contacts, so that path is covered by the unit tests);
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
 * Then `--no-semantic`, which must leave `search_vault_smart` unlisted.
 *
 * Then the index lock, with no download: this script holds a vault's lock
 * as another server would, and the first `search_vault_smart` call must be
 * refused as `semantic_search_unavailable`. That runs the bundle's
 * `node:sqlite` lock under real Node without wiring the feature or
 * fetching a model.
 *
 * Nothing here touches any host but 127.0.0.1. Temp dirs are removed, and
 * the semantic-search cache is pointed at one of them so the user's own
 * cache is never read or written.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  realpathSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, lockFilePath } from "../src/headless/cacheLock";
import { defaultCachePath, defaultCacheRoot } from "../src/headless/hostData";
import { DESKTOP_ONLY_TOOLS } from "../src/headless/toolSets";
import { WATCH_DEBOUNCE_MS } from "../src/headless/watcher";

/** The cache folder the server creates under $XDG_CACHE_HOME. */
const ROOT_NAME = "obsidian-mcp-connector";

const BUNDLE = join(
  import.meta.dir,
  "../dist/headless/obsidian-mcp-headless.js",
);

/** The watcher settles a path after the debounce; the rest is slack for a slow disk. */
const VISIBLE_DEADLINE_MS = WATCH_DEBOUNCE_MS * 50;
const POLL_MS = 50;
/** Hang guard for a reply or an exit, not a timing assertion. */
const REPLY_GUARD_MS = 15000;

/** The tools that came with desktop parity: periodic notes and `fetch`. */
const PARITY_TOOLS = [
  "fetch",
  "get_or_create_daily_note",
  "get_or_create_periodic_note",
  "append_to_periodic_note",
];

/** Spellings of this machine's loopback address that a URL check could miss. */
const LOOPBACK_SPELLINGS = (port: number) => [
  `http://localhost:${port}/page`,
  `http://localhost.:${port}/page`,
  `http://pages.localhost:${port}/page`,
  `http://[::ffff:127.0.0.1]:${port}/page`,
  `http://[::ffff:7f00:1]:${port}/page`,
  `http://2130706433:${port}/page`,
  `http://0x7f.1:${port}/page`,
];

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

/** A local HTTP server that counts what reaches it. Closed by the caller. */
async function startPageServer(): Promise<{
  server: Server;
  port: number;
  hits: () => number;
}> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><h1>Smoke page</h1></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    hits: () => hits,
  };
}

async function stdioChecks(
  vault: string,
  page: { port: number; hits: () => number },
): Promise<void> {
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
    check(
      "stdio: search_vault_smart is served",
      names.includes("search_vault_smart"),
    );
    const missing = PARITY_TOOLS.filter((n) => !names.includes(n));
    check(
      "stdio: periodic note tools and fetch are served",
      missing.length === 0,
      missing,
    );
    check(
      "stdio: file-name search and rename are served",
      names.includes("search_files_by_name") &&
        names.includes("rename_vault_file"),
    );

    const read = await client.tool("get_vault_file", { path: "Note.md" });
    check(
      "stdio: get_vault_file reads a note",
      read.includes("Seed body"),
      read,
    );

    await client.tool("create_vault_directory", {
      path: "Projects/2026/Empty",
    });
    const folders = await client.tool("list_vault_folders", {
      recursive: true,
    });
    check(
      "stdio: list_vault_folders sees an empty nested folder and hides Excluded files",
      folders.includes("Projects/2026/Empty") && !folders.includes('"Ignored"'),
      folders,
    );
    const tree = await client.tool("get_vault_tree", {});
    check(
      "stdio: get_vault_tree returns the empty nested folder",
      tree.includes('"path":"Projects/2026/Empty"') &&
        tree.includes('"empty":true'),
      tree,
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

    const named = await client.tool("search_files_by_name", { query: "frsh" });
    check(
      "stdio: search_files_by_name finds a note fuzzily",
      named.includes("Fresh.md") && !named.includes("isError"),
      named,
    );
    const renamed = await client.tool("rename_vault_file", {
      from: "Note.md",
      to: "Renamed.md",
    });
    check(
      "stdio: rename_vault_file moves a note",
      renamed.includes('"ok":true'),
      renamed,
    );
    const linker = await client.tool("get_vault_file", { path: "Fresh.md" });
    check(
      "stdio: rename_vault_file rewrote the link in another note",
      linker.includes("[[Renamed]]") && !linker.includes("[[Note]]"),
      linker,
    );

    await client.tool("create_vault_file", {
      path: "Board.canvas",
      content: JSON.stringify({
        nodes: [
          {
            id: "a",
            type: "file",
            file: "Renamed.md",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
        edges: [],
      }),
    });
    await client.tool("create_vault_file", {
      path: "Tasks.base",
      content: 'filters:\n  and:\n    - file.path == "Renamed.md"\n',
    });
    const moved = await client.tool("rename_vault_file", {
      from: "Renamed.md",
      to: "Final.md",
    });
    const board = await client.tool("get_vault_file", { path: "Board.canvas" });
    check(
      "stdio: rename_vault_file updates a canvas file node",
      board.includes("Final.md") && !board.includes("Renamed.md"),
      board,
    );
    check(
      "stdio: rename_vault_file warns about a base filter it left",
      moved.includes('"warnings"') && moved.includes("Tasks.base"),
      moved,
    );

    const hidden = await client.tool("search_files_by_name", {
      query: "hidden",
    });
    check(
      "stdio: a path in Excluded files is hidden from search",
      !hidden.includes("Ignored/Hidden.md") && !hidden.includes("isError"),
      hidden,
    );
    const shown = await client.tool("search_files_by_name", {
      query: "visible",
    });
    check(
      "stdio: a path outside Excluded files is still found",
      shown.includes("Visible.md"),
      shown,
    );

    const daily = await client.tool("get_or_create_daily_note", {
      date: "2026-03-15",
    });
    check(
      "stdio: daily note is created in the configured folder from its template",
      daily.includes('"path":"Journal/2026-03-15.md"') &&
        daily.includes('"created":true') &&
        daily.includes("# 2026-03-15"),
      daily,
    );
    const appended = await client.tool("append_to_periodic_note", {
      date: "2026-03-15",
      content: "- smoke entry",
    });
    check(
      "stdio: append_to_periodic_note extends the existing daily note",
      appended.includes('"appended":true') &&
        appended.includes('"created":false'),
      appended,
    );
    const dailyFile = await client.tool("get_vault_file", {
      path: "Journal/2026-03-15.md",
    });
    check(
      "stdio: the daily note holds the template and the appended line",
      dailyFile.includes("# 2026-03-15") && dailyFile.includes("- smoke entry"),
      dailyFile,
    );

    const outcomes: string[] = [];
    for (const url of LOOPBACK_SPELLINGS(page.port)) {
      outcomes.push(await client.tool("fetch", { url }));
    }
    check(
      "stdio: fetch refuses every spelling of loopback",
      outcomes.every((o) => o.includes('"isError"') || o.includes('"error"')),
      outcomes,
    );
    // The tool's own host check now catches every spelling above, so the
    // network layer needs an address that check does not know: shared
    // address space (100.64.0.0/10) is refused only when connecting.
    const cgnat = await client.tool("fetch", {
      url: `http://100.64.0.1:${page.port}/page`,
    });
    check(
      "stdio: the network layer refuses an address the tool's own check lets through",
      cgnat.includes("Refusing to connect"),
      cgnat,
    );
    check(
      "stdio: no refused fetch reached the local server",
      page.hits() === 0,
      page.hits(),
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

    // Nothing is wired or fetched before the first semantic search: the
    // cache folder is not even made.
    const cacheRoot = join(process.env.XDG_CACHE_HOME!, ROOT_NAME);
    check(
      "stdio: starting downloads no model and no runtime files",
      !existsSync(cacheRoot) ||
        !readdirSync(cacheRoot).some(
          (f) => f === "models" || f.startsWith("ort-"),
        ),
      existsSync(cacheRoot) ? readdirSync(cacheRoot) : [],
    );

    client.child.stdin!.end();
    check("stdio: closing stdin exits 0", (await exited(client.child)) === 0);
  } catch (err) {
    check("stdio: session completed", false, err);
    client.child.kill("SIGKILL");
  }
}

/** A symlinked app.json is not followed, and the server says so on stderr. */
function settingsWarningChecks(workDir: string): void {
  const vault = join(workDir, "vault-warn");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  writeFileSync(join(workDir, "elsewhere.json"), '{"userIgnoreFilters":["x"]}');
  symlinkSync(
    join(workDir, "elsewhere.json"),
    join(vault, ".obsidian", "app.json"),
  );
  // An empty stdin ends the session as soon as the server is up.
  const run = spawnSync("node", [BUNDLE, vault], {
    input: "",
    encoding: "utf8",
  });
  check(
    "settings: a symlinked app.json is reported on stderr",
    run.stderr.includes("Ignoring .obsidian/app.json: it is a symlink") &&
      run.stderr.includes('"Excluded files" is not applied'),
    run.stderr,
  );
  check("settings: the server still starts and exits 0", run.status === 0);
}

async function lockChecks(workDir: string): Promise<void> {
  const vault = join(workDir, "vault-lock");
  mkdirSync(vault);
  writeFileSync(join(vault, "Note.md"), "# Note\nSeed body\n");
  const real = realpathSync(vault);
  // The cache folder the server will use: XDG_CACHE_HOME is set for the run.
  const root = defaultCacheRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const other = acquireLock(lockFilePath(root, defaultCachePath(real)));
  check("lock: the script holds the vault's index lock", other.ok);
  if (!other.ok) return;
  const client = new StdioClient(["node", BUNDLE, vault]);
  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "headless-smoke", version: "0" },
    });
    client.notify("notifications/initialized");
    const refused = await client.tool("search_vault_smart", { query: "note" });
    check(
      "lock: a search is refused while another process holds the index",
      refused.includes("semantic_search_unavailable") &&
        refused.includes("another obsidian-mcp-headless process"),
      refused,
    );
    client.child.stdin!.end();
    check("lock: closing stdin exits 0", (await exited(client.child)) === 0);
  } catch (err) {
    check("lock: session completed", false, err);
    client.child.kill("SIGKILL");
  } finally {
    other.release();
  }
}

async function noSemanticChecks(vault: string): Promise<void> {
  const client = new StdioClient(["node", BUNDLE, vault, "--no-semantic"]);
  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "headless-smoke", version: "0" },
    });
    client.notify("notifications/initialized");
    const list = await client.request("tools/list");
    const names = (
      (list.result?.tools as Array<{ name: string }> | undefined) ?? []
    ).map((t) => t.name);
    check(
      "no-semantic: vault tools are served",
      names.includes("get_vault_file"),
    );
    check(
      "no-semantic: search_vault_smart is not listed",
      !names.includes("search_vault_smart"),
    );
    client.child.stdin!.end();
    check(
      "no-semantic: closing stdin exits 0",
      (await exited(client.child)) === 0,
    );
  } catch (err) {
    check("no-semantic: session completed", false, err);
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
      "http: search_vault_smart is served",
      legacy.text.includes("search_vault_smart"),
      legacy.text.slice(0, 200),
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
  // Inherited by every server this script spawns.
  process.env.XDG_CACHE_HOME = join(workDir, "cache");
  try {
    const stdioVault = join(workDir, "vault-stdio");
    mkdirSync(stdioVault);
    writeFileSync(
      join(stdioVault, "Note.md"),
      "---\ntitle: Seed\n---\n# Note\nSeed body\n",
    );
    writeFileSync(join(stdioVault, "Visible.md"), "visible\n");
    mkdirSync(join(stdioVault, "Ignored"));
    writeFileSync(join(stdioVault, "Ignored/Hidden.md"), "hidden\n");
    writeFileSync(join(stdioVault, "Daily.md"), "# {{title}}\n");
    mkdirSync(join(stdioVault, ".obsidian"));
    const settings = (name: string, value: unknown) =>
      writeFileSync(join(stdioVault, ".obsidian", name), JSON.stringify(value));
    settings("app.json", { userIgnoreFilters: ["Ignored/"] });
    settings("core-plugins.json", ["daily-notes"]);
    settings("daily-notes.json", { folder: "Journal", template: "Daily" });

    const page = await startPageServer();
    try {
      await stdioChecks(stdioVault, page);
    } finally {
      page.server.close();
    }
    settingsWarningChecks(workDir);
    await installedChecks(stdioVault, workDir);
    await noSemanticChecks(stdioVault);
    await lockChecks(workDir);

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
