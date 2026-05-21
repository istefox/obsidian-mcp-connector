import { describe, expect, test, beforeEach } from "bun:test";
import {
  appendToActiveFileHandler,
  appendToActiveFileSchema,
} from "./appendToActiveFile";
import {
  mockApp,
  resetMockVault,
  setMockActiveFile,
  setMockFile,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("append_to_active_file tool", () => {
  test("schema declares the tool name", () => {
    expect(appendToActiveFileSchema.get("name")?.toString()).toContain(
      "append_to_active_file",
    );
  });

  test("appends content to existing active file with newline normalization", async () => {
    setMockFile("Inbox/note.md", "# Top\n\nExisting body.");
    setMockActiveFile("Inbox/note.md");
    const app = mockApp();

    const result = await appendToActiveFileHandler({
      arguments: { content: "More" },
      app,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/ok|appended/i);

    const file = app.workspace.getActiveFile();
    if (!file) throw new Error("expected active file");
    const final = await app.vault.read(file);
    expect(final).toContain("Existing body.");
    expect(final).toContain("More");
    // normalizeAppendBody adds \n\n when content lacks trailing newline
    expect(final.endsWith("More\n\n")).toBe(true);
  });

  test("preserves trailing newlines when content already ends with newline", async () => {
    setMockFile("a.md", "X");
    setMockActiveFile("a.md");
    const app = mockApp();

    await appendToActiveFileHandler({ arguments: { content: "Y\n" }, app });

    const file = app.workspace.getActiveFile()!;
    expect(await app.vault.read(file)).toBe("XY\n");
  });

  test("returns error when no active file", async () => {
    setMockActiveFile(null);
    const result = await appendToActiveFileHandler({
      arguments: { content: "anything" },
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no active file/i);
  });
});
