import { describe, expect, test, beforeEach } from "bun:test";
import {
  setNotePropertyHandler,
  setNotePropertySchema,
} from "./setNoteProperty";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

function readFm(path: string): Record<string, unknown> | undefined {
  const app = mockApp();
  const file = app.vault.getAbstractFileByPath(path);
  return app.metadataCache.getFileCache(file as never)?.frontmatter as
    | Record<string, unknown>
    | undefined;
}

describe("set_note_property tool", () => {
  test("schema declares the tool name", () => {
    expect(setNotePropertySchema.get("name")?.toString()).toContain(
      "set_note_property",
    );
  });

  test("sets a scalar value, preserving native type", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: {} });
    const r = await setNotePropertyHandler({
      arguments: { path: "n.md", key: "priority", value: 5 },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    expect(readFm("n.md")?.priority).toBe(5);
  });

  test("overwrites an existing key", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: { status: "todo" } });
    await setNotePropertyHandler({
      arguments: { path: "n.md", key: "status", value: "done" },
      app: mockApp(),
    });
    expect(readFm("n.md")?.status).toBe("done");
  });

  test("sets a boolean (native type, not string)", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: {} });
    await setNotePropertyHandler({
      arguments: { path: "n.md", key: "done", value: true },
      app: mockApp(),
    });
    expect(readFm("n.md")?.done).toBe(true);
  });

  test("sets a list value", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: {} });
    await setNotePropertyHandler({
      arguments: { path: "n.md", key: "tags", value: ["x", "y"] },
      app: mockApp(),
    });
    expect(readFm("n.md")?.tags).toEqual(["x", "y"]);
  });

  test("auto-initialises a missing frontmatter block", async () => {
    setMockFile("n.md", "just a body, no frontmatter");
    const r = await setNotePropertyHandler({
      arguments: { path: "n.md", key: "k", value: "v" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    expect(readFm("n.md")?.k).toBe("v");
  });

  test("value:null removes the key (delete redirect)", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: { gone: "x", keep: "y" } });
    await setNotePropertyHandler({
      arguments: { path: "n.md", key: "gone", value: null },
      app: mockApp(),
    });
    const fm = readFm("n.md");
    expect(fm && Object.prototype.hasOwnProperty.call(fm, "gone")).toBe(false);
    expect(fm?.keep).toBe("y");
  });

  test("rejects a YAML-illegal key with invalid_key", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: {} });
    const r = await setNotePropertyHandler({
      arguments: { path: "n.md", key: "bad: key", value: "v" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text as string).errorCode).toBe(
      "invalid_key",
    );
    expect(readFm("n.md") ?? {}).toEqual({});
  });

  test("errors with file_not_found for a missing path", async () => {
    const r = await setNotePropertyHandler({
      arguments: { path: "nope.md", key: "k", value: "v" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text as string).errorCode).toBe(
      "file_not_found",
    );
  });

  test("errors with not_a_file when the path is a folder", async () => {
    setMockFolder("Projects");
    const r = await setNotePropertyHandler({
      arguments: { path: "Projects", key: "k", value: "v" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text as string).errorCode).toBe(
      "not_a_file",
    );
  });
});
