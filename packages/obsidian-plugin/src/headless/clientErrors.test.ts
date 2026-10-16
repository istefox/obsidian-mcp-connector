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
    plugin: {} as never,
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
