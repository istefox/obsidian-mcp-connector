// See docs/architecture/ADR-0024-converge-anchor-matchers.md.
import { describe, expect, test, beforeEach } from "bun:test";
import { getNoteOutlineHandler, getNoteOutlineSchema } from "./getNoteOutline";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_note_outline tool", () => {
  test("schema declares the tool name", () => {
    expect(getNoteOutlineSchema.get("name")?.toString()).toContain(
      "get_note_outline",
    );
  });

  test("returns ordered headings with 1-based line numbers", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", {
      headings: [
        { heading: "Introduction", level: 1, line: 0 },
        { heading: "Background", level: 2, line: 4 },
        { heading: "Details", level: 2, line: 9 },
      ],
    });
    const r = await getNoteOutlineHandler({
      arguments: { path: "n.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.heading_count).toBe(3);
    expect(data.headings[0]).toEqual({
      level: 1,
      text: "Introduction",
      line_number: 1,
      anchor: "Introduction",
    });
    expect(data.headings[1].line_number).toBe(5);
  });

  test("returns empty headings array for a note with no headings", async () => {
    setMockFile("n.md", "just body");
    setMockMetadata("n.md", {});
    const r = await getNoteOutlineHandler({
      arguments: { path: "n.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.heading_count).toBe(0);
    expect(data.headings).toEqual([]);
    expect(r.isError).toBeUndefined();
  });

  test("errors with file_not_found for a missing path", async () => {
    const r = await getNoteOutlineHandler({
      arguments: { path: "ghost.md" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text as string).errorCode).toBe(
      "file_not_found",
    );
  });

  test("anchor is the literal heading text", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", {
      headings: [{ heading: "Hello World 2026", level: 1, line: 0 }],
    });
    const r = await getNoteOutlineHandler({
      arguments: { path: "n.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.headings[0].anchor).toBe("Hello World 2026");
  });

  test("anchor preserves punctuation in the heading text", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", {
      headings: [{ heading: "C++ Basics!", level: 2, line: 0 }],
    });
    const r = await getNoteOutlineHandler({
      arguments: { path: "n.md" },
      app: mockApp(),
    });
    expect(JSON.parse(r.content[0].text as string).headings[0].anchor).toBe(
      "C++ Basics!",
    );
  });

  test("anchor preserves non-ASCII heading text verbatim", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", {
      headings: [{ heading: "Résumé", level: 2, line: 0 }],
    });
    const r = await getNoteOutlineHandler({
      arguments: { path: "n.md" },
      app: mockApp(),
    });
    expect(JSON.parse(r.content[0].text as string).headings[0].anchor).toBe(
      "Résumé",
    );
  });

  test("trims surrounding heading whitespace and keeps anchor equal to text", async () => {
    setMockFile("n.md", "##   Spaced   ");
    setMockMetadata("n.md", {
      headings: [{ heading: "  Spaced   ", level: 2, line: 0 }],
    });
    const r = await getNoteOutlineHandler({
      arguments: { path: "n.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.headings[0].anchor).toBe("Spaced");
    expect(
      data.headings.every(
        (heading: { anchor: string; text: string }) =>
          heading.anchor === heading.text,
      ),
    ).toBe(true);
  });

  test("returns empty result on no-cache file (safe skip)", async () => {
    setMockFile("n.md", "body");
    // No setMockMetadata → cache returns null → treat as 0 headings
    const r = await getNoteOutlineHandler({
      arguments: { path: "n.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.heading_count).toBe(0);
    expect(r.isError).toBeUndefined();
  });
});
