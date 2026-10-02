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
