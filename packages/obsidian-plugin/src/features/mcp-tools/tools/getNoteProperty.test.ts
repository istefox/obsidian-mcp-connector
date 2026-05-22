import { describe, expect, test, beforeEach } from "bun:test";
import {
  getNotePropertyHandler,
  getNotePropertySchema,
} from "./getNoteProperty";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_note_property tool", () => {
  test("schema declares the tool name", () => {
    expect(getNotePropertySchema.get("name")?.toString()).toContain(
      "get_note_property",
    );
  });

  test("returns the native-typed value for an existing key", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: { priority: 5, status: "done" } });
    const r = await getNotePropertyHandler({
      arguments: { path: "n.md", key: "priority" },
      app: mockApp(),
    });
    expect(JSON.parse(r.content[0].text as string)).toEqual({
      path: "n.md",
      key: "priority",
      value: 5,
    });
  });

  test("returns value:null when the key is absent", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: { status: "done" } });
    const r = await getNotePropertyHandler({
      arguments: { path: "n.md", key: "missing" },
      app: mockApp(),
    });
    expect(JSON.parse(r.content[0].text as string)).toEqual({
      path: "n.md",
      key: "missing",
      value: null,
    });
  });

  test("returns value:null when the note has no frontmatter", async () => {
    setMockFile("n.md", "body only");
    const r = await getNotePropertyHandler({
      arguments: { path: "n.md", key: "any" },
      app: mockApp(),
    });
    expect(JSON.parse(r.content[0].text as string).value).toBeNull();
  });

  test("errors with file_not_found for a missing path", async () => {
    const r = await getNotePropertyHandler({
      arguments: { path: "nope.md", key: "k" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text as string).errorCode).toBe(
      "file_not_found",
    );
  });

  test("errors with not_a_file when the path is a folder", async () => {
    setMockFolder("Projects");
    const r = await getNotePropertyHandler({
      arguments: { path: "Projects", key: "k" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text as string).errorCode).toBe(
      "not_a_file",
    );
  });

  test("preserves list values verbatim", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: { tags: ["a", "b"] } });
    const r = await getNotePropertyHandler({
      arguments: { path: "n.md", key: "tags" },
      app: mockApp(),
    });
    expect(JSON.parse(r.content[0].text as string).value).toEqual(["a", "b"]);
  });
});
