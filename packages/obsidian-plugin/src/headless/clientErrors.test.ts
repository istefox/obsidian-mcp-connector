/**
 * What an MCP client reads when a tool fails on a headless vault, through
 * the registered tools as the server runs them. The tools replace the
 * message of any error that has a `code` with a generic phrase, so a
 * headless refusal that explains itself carries a `reason` instead. The
 * `obsidian` module the unit-test preload mocks is given the headless
 * runtime, which is what the headless bundle ships, and put back afterwards.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mocked from "obsidian";
import * as shim from "./obsidianShim";
import type { HeadlessAppHandle } from "./headlessApp";
import { nodeMoveOps } from "./moveEntry";

const original = { ...mocked };

let createHeadlessApp: typeof import("./headlessApp").createHeadlessApp;
let ToolRegistryClass: typeof import("$/features/mcp-transport/services/toolRegistry").ToolRegistryClass;
let registerTools: typeof import("./registerTools").registerTools;

beforeAll(async () => {
  void mock.module("obsidian", () => ({
    ...original,
    TAbstractFile: shim.TAbstractFile,
    TFile: shim.TFile,
    TFolder: shim.TFolder,
  }));
  ({ createHeadlessApp } = await import("./headlessApp"));
  ({ ToolRegistryClass } =
    await import("$/features/mcp-transport/services/toolRegistry"));
  ({ registerTools } = await import("./registerTools"));
});
afterAll(() => {
  void mock.module("obsidian", () => original);
});

let dir: string;
let root: string;
let handle: HeadlessAppHandle | undefined;

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

beforeEach(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "headless-client-errors-")),
  );
  root = path.join(dir, "vault");
  fs.mkdirSync(root);
});
afterEach(() => {
  handle?.close();
  handle = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

type Result = { content: Array<{ text: string }>; isError?: boolean };

/** A tool call through the registry, and the error body the client gets. */
async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ error: string; errorCode: string }> {
  const registry = new ToolRegistryClass();
  await registerTools(registry, {
    app: handle!.app,
    plugin: { loadData: async () => ({}) } as never,
    pluginVersion: "0.0.0-test",
  });
  const result = (await registry.dispatch(
    { name, arguments: args },
    {} as never,
  )) as Result;
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0].text);
}

describe("a conflicting edit", () => {
  test("tells the client that nothing was written and to retry", async () => {
    write("n.md", "- [ ] task\n");
    let edited = false;
    handle = await createHeadlessApp(root, {
      beforeCommit: async (rel) => {
        if (edited) return;
        edited = true;
        fs.writeFileSync(path.join(root, rel), "- [ ] typed in an editor\n");
      },
    });
    const body = await call("set_task_status", {
      path: "n.md",
      line: 0,
      status: "done",
    });
    expect(body.errorCode).toBe("write_failed");
    expect(body.error).toContain("nothing was written");
    expect(body.error).toContain("Read it again and retry");
    expect(body.error).not.toContain("file system error");
    expect(fs.readFileSync(path.join(root, "n.md"), "utf8")).toBe(
      "- [ ] typed in an editor\n",
    );
  });
});

describe("a path the vault refuses", () => {
  test("says why when the path cannot be written", async () => {
    handle = await createHeadlessApp(root);
    const body = await call("delete_vault_directory", {
      path: "C:/dir",
      recursive: true,
    });
    expect(body.error).toContain("Absolute paths are not allowed");
    expect(body.error).not.toContain("file system error");
  });

  // delete_vault_directory maps an EACCES `code` to its own permission
  // answer, and the headless refusals of that kind must keep earning it.
  test.each([
    ["leaves the vault", "../outside"],
    ["is a hidden folder", ".hidden/dir"],
  ])("a path that %s is still a permission refusal", async (_, p) => {
    handle = await createHeadlessApp(root);
    const body = await call("delete_vault_directory", {
      path: p,
      recursive: true,
    });
    expect(body.errorCode).toBe("permission_denied");
  });
});

describe("a rename the vault refuses", () => {
  beforeEach(async () => {
    write("Notes/old.md", "# Old\n");
    handle = await createHeadlessApp(root);
  });

  test("a name that would break links says so", async () => {
    const body = await call("rename_vault_file", {
      from: "Notes/old.md",
      to: "Notes/new|name.md",
    });
    expect(body.errorCode).toBe("rename_failed");
    expect(body.error).toContain("would break links");
    expect(body.error).not.toContain("file system error");
  });

  test("a folder moved into itself says so", async () => {
    const body = await call("rename_vault_file", {
      from: "Notes",
      to: "Notes/inner",
    });
    expect(body.errorCode).toBe("rename_failed");
    expect(body.error).toContain("cannot move into itself");
    expect(body.error).not.toContain("file system error");
  });
});

describe("a trash that leaves a file behind", () => {
  const hostPaths = (text: string) => text.includes(dir);

  test("names the temporary name that could not be removed, without the vault path", async () => {
    write("a.md", "original");
    handle = await createHeadlessApp(root, {
      moveOps: {
        ...nodeMoveOps,
        unlink: async (p) => {
          if (p.endsWith(".tmp")) {
            throw Object.assign(new Error(`EACCES: denied, unlink '${p}'`), {
              code: "EACCES",
            });
          }
          await fs.promises.unlink(p);
        },
      },
    });
    const body = await call("delete_vault_file", { path: "a.md" });
    expect(body.error).toContain("moved to the trash");
    expect(body.error).toContain("could not be removed");
    expect(hostPaths(body.error)).toBe(false);
  });

  test("names where a file that could not be put back is kept, without the vault path", async () => {
    write("a.md", "original");
    write(".trash/a.md", "older");
    handle = await createHeadlessApp(root, {
      moveOps: {
        ...nodeMoveOps,
        rename: async (src, dst) => {
          await fs.promises.rename(src, dst);
          // An external save recreates the name right after it is captured.
          if (path.basename(dst).endsWith(".tmp")) {
            fs.writeFileSync(path.join(root, "a.md"), "external");
          }
        },
      },
    });
    const body = await call("delete_vault_file", { path: "a.md" });
    expect(body.error).toContain("the file is kept at");
    expect(hostPaths(body.error)).toBe(false);
  });
});
