import { describe, expect, test, beforeEach } from "bun:test";
import {
  deleteNotePropertyHandler,
  deleteNotePropertySchema,
} from "./deleteNoteProperty";
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

describe("delete_note_property tool", () => {
  test("schema declares the tool name", () => {
    expect(deleteNotePropertySchema.get("name")?.toString()).toContain(
      "delete_note_property",
    );
  });

  test("removes an existing key, leaving the rest", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: { gone: 1, keep: 2 } });
    const r = await deleteNotePropertyHandler({
      arguments: { path: "n.md", key: "gone" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const fm = readFm("n.md");
    expect(fm && Object.prototype.hasOwnProperty.call(fm, "gone")).toBe(false);
    expect(fm?.keep).toBe(2);
  });

  test("is idempotent for an absent key (no-op success)", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", { frontmatter: { keep: 2 } });
    const r = await deleteNotePropertyHandler({
      arguments: { path: "n.md", key: "missing" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    expect(readFm("n.md")?.keep).toBe(2);
  });

  test("is idempotent for a note with no frontmatter", async () => {
    setMockFile("n.md", "body only");
    const r = await deleteNotePropertyHandler({
      arguments: { path: "n.md", key: "any" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
  });

  test("errors with file_not_found for a missing path", async () => {
    const r = await deleteNotePropertyHandler({
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
    const r = await deleteNotePropertyHandler({
      arguments: { path: "Projects", key: "k" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text as string).errorCode).toBe(
      "not_a_file",
    );
  });
});
