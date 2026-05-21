import { describe, expect, test, beforeEach } from "bun:test";
import { getActiveFileHandler, getActiveFileSchema } from "./getActiveFile";
import {
  mockApp,
  resetMockVault,
  setMockActiveFile,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_active_file tool", () => {
  test("schema declares the tool name", () => {
    const name = getActiveFileSchema.get("name");
    expect(name?.toString()).toContain("get_active_file");
  });

  test("returns plain markdown content when no format specified", async () => {
    setMockFile("Inbox/note.md", "# Hello\n\nBody.");
    setMockActiveFile("Inbox/note.md");

    const result = await getActiveFileHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("# Hello\n\nBody.");
  });

  test("returns JSON shape when format=json", async () => {
    setMockFile("Inbox/note.md", "---\ntags: [a, b]\n---\n# Hello");
    setMockActiveFile("Inbox/note.md");
    setMockMetadata("Inbox/note.md", {
      frontmatter: { tags: ["a", "b"] },
      headings: [{ heading: "Hello", level: 1, line: 3 }],
    });

    const result = await getActiveFileHandler({
      arguments: { format: "json" },
      app: mockApp(),
    });

    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.path).toBe("Inbox/note.md");
    expect(parsed.frontmatter).toEqual({ tags: ["a", "b"] });
    expect(parsed.tags).toEqual(["a", "b"]);
    expect(parsed.content).toContain("# Hello");
  });

  test("returns informative error when no active file", async () => {
    setMockActiveFile(null);
    const result = await getActiveFileHandler({
      arguments: {},
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no active file/i);
  });
});
