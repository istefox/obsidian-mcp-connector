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

  test("returns plain markdown content when no format specified, plus a second URI block (ADR-0026 D4)", async () => {
    setMockFile("Inbox/note.md", "# Hello\n\nBody.");
    setMockActiveFile("Inbox/note.md");

    const result = await getActiveFileHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("# Hello\n\nBody.");
    expect(result.content[1].text).toBe(
      "URI: obsidian://open?vault=Test%20Vault&file=Inbox%2Fnote.md",
    );
  });

  test("returns JSON shape when format=json, plus uri, no structuredContent", async () => {
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
    expect(parsed.uri).toBe(
      "obsidian://open?vault=Test%20Vault&file=Inbox%2Fnote.md",
    );
    expect(
      (result as { structuredContent?: unknown }).structuredContent,
    ).toBeUndefined();
  });

  test("returns informative error when no active file", async () => {
    setMockActiveFile(null);
    const result = await getActiveFileHandler({
      arguments: {},
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no active file/i);
    expect(result.content).toHaveLength(1);
  });

  describe("heading input (ADR-0026 D7-D9, R-01, R-04)", () => {
    test("heading matching resolves %23<heading> in the markdown URI block", async () => {
      setMockFile("Inbox/note.md", "# Title\n\n## Section\nBody");
      setMockActiveFile("Inbox/note.md");

      const result = await getActiveFileHandler({
        arguments: { heading: "Section" },
        app: mockApp(),
      });

      expect(result.content).toHaveLength(2);
      expect(result.content[1].text).toContain("%23Section");
    });

    test("heading matching resolves %23<heading> in the json uri", async () => {
      setMockFile("Inbox/note.md", "# Title\n\n## Section\nBody");
      setMockActiveFile("Inbox/note.md");

      const result = await getActiveFileHandler({
        arguments: { format: "json", heading: "Section" },
        app: mockApp(),
      });

      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.uri).toBe(
        "obsidian://open?vault=Test%20Vault&file=Inbox%2Fnote.md%23Section",
      );
    });

    test("heading not found returns heading_not_found error, no uri, no content", async () => {
      setMockFile("Inbox/note.md", "# Title\nBody");
      setMockActiveFile("Inbox/note.md");

      const result = await getActiveFileHandler({
        arguments: { heading: "Nope" },
        app: mockApp(),
      });

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.errorCode).toBe("heading_not_found");
      expect(parsed.heading).toBe("Nope");
      expect(parsed.path).toBe("Inbox/note.md");
    });
  });
});
