import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockMetadata,
} from "$/test-setup";
import {
  updateNotePropertiesHandler,
  updateNotePropertiesSchema,
} from "./updateNoteProperties";

beforeEach(() => resetMockVault());

function readFm(path: string): Record<string, unknown> | undefined {
  const app = mockApp();
  const file = app.vault.getAbstractFileByPath(path);
  return app.metadataCache.getFileCache(file as never)?.frontmatter as
    | Record<string, unknown>
    | undefined;
}

async function run(args: Record<string, unknown>) {
  const r = await updateNotePropertiesHandler({
    arguments: args as never,
    app: mockApp(),
  });
  return { r, data: JSON.parse(r.content[0].text) };
}

describe("update_note_properties", () => {
  test("schema: name, typed set values, string[] remove", () => {
    expect(updateNotePropertiesSchema.get("name").toString()).toContain(
      "update_note_properties",
    );
    const args = updateNotePropertiesSchema.get("arguments");
    expect(
      args.assert({
        path: "n.md",
        set: { a: 1, b: "x", c: true, d: ["x"], e: [1, 2], f: null },
      }),
    ).toBeTruthy();
    expect(args.assert({ path: "n.md", remove: ["a"] })).toBeTruthy();
    expect(() =>
      args.assert({ path: "n.md", set: { a: { nested: 1 } } }),
    ).toThrow();
    expect(() => args.assert({ path: "n.md", set: { a: ["x", 1] } })).toThrow();
    expect(() => args.assert({ path: "n.md", remove: "a" })).toThrow();
  });

  test("sets several keys and removes others in one write", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", {
      frontmatter: { status: "todo", old: 1, keep: "yes" },
    });
    const { r, data } = await run({
      path: "n.md",
      set: { status: "done", priority: 3, tags: ["a", "b"], gone: null },
      remove: ["old", "missing"],
    });
    expect(r.isError).toBeUndefined();
    expect(data).toEqual({
      path: "n.md",
      set: ["status", "priority", "tags"],
      removed: ["old"],
      notPresent: ["missing", "gone"],
      frontmatter: {
        status: "done",
        keep: "yes",
        priority: 3,
        tags: ["a", "b"],
      },
    });
    expect(readFm("n.md")).toEqual({
      status: "done",
      keep: "yes",
      priority: 3,
      tags: ["a", "b"],
    });
  });

  test("set wins over remove for a key named in both", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: { a: 1 } });
    const { data } = await run({ path: "n.md", set: { a: 2 }, remove: ["a"] });
    expect(data.set).toEqual(["a"]);
    expect(data.removed).toEqual(["a"]);
    expect(readFm("n.md")).toEqual({ a: 2 });
  });

  test("creates frontmatter on a note that has none", async () => {
    setMockFile("plain.md", "text");
    const { data } = await run({ path: "plain.md", set: { title: "T" } });
    expect(data.frontmatter).toEqual({ title: "T" });
    expect(readFm("plain.md")).toEqual({ title: "T" });
  });

  test("a JSON-encoded list string becomes a YAML list", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: {} });
    await run({ path: "n.md", set: { tags: '["x","y"]', note: "[not json" } });
    expect(readFm("n.md")).toEqual({ tags: ["x", "y"], note: "[not json" });
  });

  test("nothing to do, invalid keys, missing file, folder", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: { a: 1 } });
    setMockFolder("Dir");
    expect((await run({ path: "n.md" })).data.errorCode).toBe("invalid_params");
    expect(
      (await run({ path: "n.md", set: {}, remove: [] })).data.errorCode,
    ).toBe("invalid_params");
    const bad = (
      await run({ path: "n.md", set: { "a:b": 1 }, remove: ["#c", ""] })
    ).data;
    expect(bad.errorCode).toBe("invalid_key");
    expect(bad.keys).toEqual(["a:b", "#c", ""]);
    expect(readFm("n.md")).toEqual({ a: 1 });
    expect((await run({ path: "none.md", set: { a: 1 } })).data.errorCode).toBe(
      "file_not_found",
    );
    expect((await run({ path: "Dir", set: { a: 1 } })).data.errorCode).toBe(
      "not_a_file",
    );
  });
});
