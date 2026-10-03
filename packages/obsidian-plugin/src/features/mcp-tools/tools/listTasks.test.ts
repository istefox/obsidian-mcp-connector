import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockIgnored,
  setMockMetadata,
} from "$/test-setup";
import { listTasksHandler, listTasksSchema } from "./listTasks";

beforeEach(() => resetMockVault());

function seed() {
  setMockFile(
    "Work/plan.md",
    [
      "# Plan",
      "- [ ] write spec",
      "  - [x] outline",
      "- [/] review",
      "- plain item",
    ].join("\n"),
  );
  setMockMetadata("Work/plan.md", {
    listItems: [
      { line: 1, task: " ", parent: -1 },
      { line: 2, task: "x", parent: 1 },
      { line: 3, task: "/", parent: -1 },
      { line: 4, parent: -1 },
    ],
  });
  setMockFile("Home/chores.md", "- [ ] buy milk\n- [X] call mum");
  setMockMetadata("Home/chores.md", {
    listItems: [
      { line: 0, task: " ", parent: -1 },
      { line: 1, task: "X", parent: -1 },
    ],
  });
  setMockFile("Home/notes.md", "no tasks here");
  setMockMetadata("Home/notes.md", {});
  setMockFolder("Work");
  setMockFolder("Home");
}

async function run(args: Record<string, unknown>) {
  const r = await listTasksHandler({ arguments: args, app: mockApp() });
  return { r, data: JSON.parse(r.content[0].text) };
}

describe("list_tasks", () => {
  test("schema declares the tool name", () => {
    expect(listTasksSchema.get("name").toString()).toContain("list_tasks");
    expect(() =>
      listTasksSchema.get("arguments").assert({ status: "maybe" }),
    ).toThrow();
    expect(() =>
      listTasksSchema.get("arguments").assert({ limit: 0 }),
    ).toThrow();
  });

  test("vault-wide: every task, ordered by path then line, with marker, text and parent", async () => {
    seed();
    const { r, data } = await run({});
    expect(r.isError).toBeUndefined();
    expect(data.status).toBe("all");
    expect(data.totalTasks).toBe(5);
    expect(data.truncated).toBeUndefined();
    expect(data.tasks).toEqual([
      {
        path: "Home/chores.md",
        line: 0,
        status: "open",
        marker: " ",
        text: "buy milk",
      },
      {
        path: "Home/chores.md",
        line: 1,
        status: "done",
        marker: "X",
        text: "call mum",
      },
      {
        path: "Work/plan.md",
        line: 1,
        status: "open",
        marker: " ",
        text: "write spec",
      },
      {
        path: "Work/plan.md",
        line: 2,
        status: "done",
        marker: "x",
        text: "outline",
        parentLine: 1,
      },
      {
        path: "Work/plan.md",
        line: 3,
        status: "done",
        marker: "/",
        text: "review",
      },
    ]);
  });

  test("status filter: open and done", async () => {
    seed();
    expect(
      (await run({ status: "open" })).data.tasks.map(
        (t: { text: string }) => t.text,
      ),
    ).toEqual(["buy milk", "write spec"]);
    const done = (await run({ status: "done" })).data;
    expect(done.tasks.map((t: { marker: string }) => t.marker)).toEqual([
      "X",
      "x",
      "/",
    ]);
    expect(done.totalTasks).toBe(3);
  });

  test("folder scope, with and without slashes", async () => {
    seed();
    for (const folder of ["Home", "/Home/", "Home/"]) {
      const { data } = await run({ folder });
      expect(data.folder).toBe(folder);
      expect(data.tasks.map((t: { path: string }) => t.path)).toEqual([
        "Home/chores.md",
        "Home/chores.md",
      ]);
    }
  });

  test("a folder that does not exist is folder_not_found; an empty one is just empty", async () => {
    seed();
    const missing = await run({ folder: "Nope" });
    expect(missing.r.isError).toBe(true);
    expect(missing.data.errorCode).toBe("folder_not_found");
    setMockFolder("Empty");
    const empty = await run({ folder: "Empty" });
    expect(empty.r.isError).toBeUndefined();
    expect(empty.data.tasks).toEqual([]);
  });

  test("single file scope wins over folder; missing or non-markdown paths are refused", async () => {
    seed();
    const { data } = await run({ path: "Work/plan.md", folder: "Home" });
    expect(data.path).toBe("Work/plan.md");
    expect(data.folder).toBeUndefined();
    expect(data.totalTasks).toBe(3);

    const missing = await run({ path: "Work/none.md" });
    expect(missing.data.errorCode).toBe("file_not_found");
    const folder = await run({ path: "Work" });
    expect(folder.data.errorCode).toBe("not_a_file");
    setMockFile("img.png", "x");
    const png = await run({ path: "img.png" });
    expect(png.data.errorCode).toBe("not_markdown");
  });

  test("limit truncates and says so, totalTasks still counts everything", async () => {
    seed();
    const { data } = await run({ limit: 2 });
    expect(data.tasks).toHaveLength(2);
    expect(data.totalTasks).toBe(5);
    expect(data.truncated).toBe(true);
  });

  test("files excluded in Obsidian's own settings are skipped vault-wide", async () => {
    seed();
    setMockIgnored("Work/plan.md");
    const { data } = await run({});
    expect(
      data.tasks.every((t: { path: string }) => t.path === "Home/chores.md"),
    ).toBe(true);
  });

  test("a line the parser cannot read falls back to the cache marker", async () => {
    setMockFile("odd.md", "- [ ]weird spacing");
    setMockMetadata("odd.md", {
      listItems: [{ line: 0, task: " ", parent: -1 }],
    });
    const { data } = await run({});
    expect(data.tasks).toEqual([
      {
        path: "odd.md",
        line: 0,
        status: "open",
        marker: " ",
        text: "- [ ]weird spacing",
      },
    ]);
  });
});

describe("list_tasks: vault root and CRLF", () => {
  test('folder: "/" means the whole vault', async () => {
    seed();
    const { r, data } = await run({ folder: "/" });
    expect(r.isError).toBeUndefined();
    expect(data.totalTasks).toBe(5);
  });

  test("a CRLF note reports clean task text", async () => {
    setMockFile("crlf.md", "- [ ] buy milk\r\n- [x] call mum\r\n");
    setMockMetadata("crlf.md", {
      listItems: [
        { line: 0, task: " ", parent: -1 },
        { line: 1, task: "x", parent: -1 },
      ],
    });
    const { data } = await run({ path: "crlf.md" });
    expect(data.tasks.map((t: { text: string }) => t.text)).toEqual([
      "buy milk",
      "call mum",
    ]);
  });
});

describe("list_tasks: paging", () => {
  test("offset skips tasks and truncated tracks the remainder", async () => {
    seed();
    const all = (await run({})).data.tasks as Array<{ path: string }>;
    const { data } = await run({ offset: 2, limit: 2 });
    expect(data.totalTasks).toBe(5);
    expect(data.offset).toBe(2);
    expect(data.tasks).toEqual(all.slice(2, 4));
    expect(data.truncated).toBe(true);
    const last = (await run({ offset: 4, limit: 2 })).data;
    expect(last.tasks).toHaveLength(1);
    expect(last.truncated).toBeUndefined();
  });

  test("an offset past the end returns no tasks but the real total", async () => {
    seed();
    const { data } = await run({ offset: 50 });
    expect(data.tasks).toEqual([]);
    expect(data.totalTasks).toBe(5);
  });

  test("the status filter counts from the cache, before paging", async () => {
    seed();
    const { data } = await run({ status: "open", limit: 1 });
    expect(data.totalTasks).toBe(2);
    expect(data.tasks).toHaveLength(1);
    expect(data.truncated).toBe(true);
  });

  test("only files owning a returned task are read", async () => {
    seed();
    const app = mockApp();
    const read: string[] = [];
    const original = app.vault.cachedRead.bind(app.vault);
    app.vault.cachedRead = async (f: never) => {
      read.push((f as { path: string }).path);
      return original(f);
    };
    const r = await listTasksHandler({
      arguments: { limit: 1 },
      app,
    });
    expect(JSON.parse(r.content[0].text).totalTasks).toBe(5);
    expect(read).toEqual(["Home/chores.md"]);
  });

  test("schema accepts offset and rejects a negative one", () => {
    const args = listTasksSchema.get("arguments");
    expect(() => args.assert({ offset: 3 })).not.toThrow();
    expect(() => args.assert({ offset: -1 })).toThrow();
  });
});
