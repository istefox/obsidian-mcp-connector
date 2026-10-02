import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockModifyFail,
  setMockReadMutation,
} from "$/test-setup";
import { setTaskStatusHandler, setTaskStatusSchema } from "./setTaskStatus";

beforeEach(() => resetMockVault());

const DOC = [
  "# Plan",
  "- [ ] write spec",
  "    - [x] outline  ",
  "3. [/] review",
  "- plain item",
  "",
].join("\n");

async function run(args: Record<string, unknown>) {
  const r = await setTaskStatusHandler({
    arguments: args as never,
    app: mockApp(),
  });
  return { r, data: JSON.parse(r.content[0].text) };
}
async function content(path = "plan.md") {
  const app = mockApp();
  return app.vault.read(app.vault.getAbstractFileByPath(path) as never);
}

describe("set_task_status", () => {
  test("schema: name, enum status, single-char marker", () => {
    expect(setTaskStatusSchema.get("name").toString()).toContain(
      "set_task_status",
    );
    const args = setTaskStatusSchema.get("arguments");
    expect(() =>
      args.assert({ path: "a.md", line: 0, status: "maybe" }),
    ).toThrow();
    expect(() =>
      args.assert({ path: "a.md", line: 0, status: "done", marker: "xx" }),
    ).toThrow();
    expect(() =>
      args.assert({ path: "a.md", line: -1, status: "done" }),
    ).toThrow();
    expect(
      args.assert({ path: "a.md", line: 0, status: "done", marker: "/" }),
    ).toBeTruthy();
  });

  test("done ticks the box and keeps everything else byte for byte", async () => {
    setMockFile("plan.md", DOC);
    const { r, data } = await run({ path: "plan.md", line: 1, status: "done" });
    expect(r.isError).toBeUndefined();
    expect(data).toEqual({
      path: "plan.md",
      line: 1,
      status: "done",
      previousMarker: " ",
      marker: "x",
      text: "write spec",
      changed: true,
    });
    expect(await content()).toBe(
      DOC.replace("- [ ] write spec", "- [x] write spec"),
    );
  });

  test("open unticks an indented, trailing-space task without touching its whitespace", async () => {
    setMockFile("plan.md", DOC);
    const { data } = await run({ path: "plan.md", line: 2, status: "open" });
    expect(data.previousMarker).toBe("x");
    expect(data.text).toBe("outline");
    expect(await content()).toBe(
      DOC.replace("    - [x] outline  ", "    - [ ] outline  "),
    );
  });

  test("custom marker on an ordered task", async () => {
    setMockFile("plan.md", DOC);
    const { data } = await run({
      path: "plan.md",
      line: 3,
      status: "done",
      marker: "-",
    });
    expect(data.marker).toBe("-");
    expect(data.status).toBe("done");
    expect(await content()).toContain("3. [-] review");
  });

  test("already in the requested state: success, changed false, no write", async () => {
    setMockFile("plan.md", DOC);
    const { data } = await run({ path: "plan.md", line: 2, status: "done" });
    expect(data.changed).toBe(false);
    expect(data.previousMarker).toBe("x");
    expect(await content()).toBe(DOC);
  });

  test("expectedText guards the write; the message carries the current text", async () => {
    setMockFile("plan.md", DOC);
    const ok = await run({
      path: "plan.md",
      line: 1,
      status: "done",
      expectedText: "write spec",
    });
    expect(ok.r.isError).toBeUndefined();
    const stale = await run({
      path: "plan.md",
      line: 3,
      status: "done",
      expectedText: "write spec",
    });
    expect(stale.r.isError).toBe(true);
    expect(stale.data.errorCode).toBe("stale_precondition");
    expect(stale.data.target).toBe("review");
    expect(await content()).toContain("3. [/] review");
  });

  test("the precondition is checked against the content the write sees (TOCTOU)", async () => {
    setMockFile("plan.md", DOC);
    // A list_tasks-style read happens first; by the time process() reads,
    // another writer has reworded the task. The write must see the new
    // text and refuse, not trust the earlier read.
    setMockReadMutation(
      "plan.md",
      DOC.replace("- [ ] write spec", "- [ ] write the spec"),
    );
    await content();
    const { data } = await run({
      path: "plan.md",
      line: 1,
      status: "done",
      expectedText: "write spec",
    });
    expect(data.errorCode).toBe("stale_precondition");
    expect(data.target).toBe("write the spec");
    expect(await content()).toContain("- [ ] write the spec");
  });

  test("not a task, past the end, missing file, folder, non-markdown", async () => {
    setMockFile("plan.md", DOC);
    setMockFolder("Dir");
    setMockFile("img.png", "x");
    expect(
      (await run({ path: "plan.md", line: 4, status: "done" })).data.errorCode,
    ).toBe("not_a_task");
    expect(
      (await run({ path: "plan.md", line: 0, status: "done" })).data.errorCode,
    ).toBe("not_a_task");
    const past = (await run({ path: "plan.md", line: 99, status: "done" }))
      .data;
    expect(past.errorCode).toBe("line_out_of_range");
    expect(past.lineCount).toBe(6);
    expect(
      (await run({ path: "none.md", line: 0, status: "done" })).data.errorCode,
    ).toBe("file_not_found");
    expect(
      (await run({ path: "Dir", line: 0, status: "done" })).data.errorCode,
    ).toBe("not_a_file");
    expect(
      (await run({ path: "img.png", line: 0, status: "done" })).data.errorCode,
    ).toBe("not_markdown");
    expect(await content()).toBe(DOC);
  });

  test("a space marker with status done is refused as invalid_params", async () => {
    setMockFile("plan.md", DOC);
    const { data } = await run({
      path: "plan.md",
      line: 1,
      status: "done",
      marker: " ",
    });
    expect(data.errorCode).toBe("invalid_params");
  });

  test("a failing write surfaces as write_failed", async () => {
    setMockFile("plan.md", DOC);
    setMockModifyFail("plan.md");
    const { r, data } = await run({ path: "plan.md", line: 1, status: "done" });
    expect(r.isError).toBe(true);
    expect(data.errorCode).toBe("write_failed");
  });
});
