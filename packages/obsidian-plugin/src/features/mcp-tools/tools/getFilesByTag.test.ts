import { describe, expect, test, beforeEach } from "bun:test";
import { getFilesByTagHandler, getFilesByTagSchema } from "./getFilesByTag";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_files_by_tag tool", () => {
  test("schema declares the tool name", () => {
    expect(getFilesByTagSchema.get("name")?.toString()).toContain(
      "get_files_by_tag",
    );
  });

  test("returns empty result when vault has no matching tags", async () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", { tags: [{ tag: "#other" }] });
    const r = await getFilesByTagHandler({
      arguments: { tag: "#missing" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data).toEqual({
      tag: "#missing",
      includeNested: true,
      totalFiles: 0,
      files: [],
    });
  });

  test("matches inline tags in a single file", async () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      tags: [{ tag: "#project" }, { tag: "#project" }, { tag: "#other" }],
    });
    const r = await getFilesByTagHandler({
      arguments: { tag: "project" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalFiles).toBe(1);
    expect(data.files).toEqual([{ path: "note.md", count: 2 }]);
  });

  test("accepts the tag with or without a leading `#`", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    setMockMetadata("a.md", { tags: [{ tag: "#daily" }] });
    setMockMetadata("b.md", { tags: [{ tag: "#daily" }] });

    const withHash = await getFilesByTagHandler({
      arguments: { tag: "#daily" },
      app: mockApp(),
    });
    const withoutHash = await getFilesByTagHandler({
      arguments: { tag: "daily" },
      app: mockApp(),
    });
    expect(withHash.content[0].text).toBe(withoutHash.content[0].text);
  });

  test("matches frontmatter tags (array form)", async () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      frontmatter: { tags: ["project", "#archive"] },
    });
    const r = await getFilesByTagHandler({
      arguments: { tag: "project" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalFiles).toBe(1);
    expect(data.files).toEqual([{ path: "note.md", count: 1 }]);
  });

  test("counts inline and frontmatter occurrences as separate hits", async () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      tags: [{ tag: "#project" }],
      frontmatter: { tags: ["project"] },
    });
    const r = await getFilesByTagHandler({
      arguments: { tag: "project" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    // Inline + frontmatter are treated as separate occurrences so the
    // count reflects how prominently the tag appears in the file
    // (search-relevance signal). 1 inline + 1 fm = 2.
    expect(data.files).toEqual([{ path: "note.md", count: 2 }]);
  });

  test("matches nested tags by default (includeNested = true)", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    setMockFile("c.md", "");
    setMockMetadata("a.md", { tags: [{ tag: "#project" }] });
    setMockMetadata("b.md", { tags: [{ tag: "#project/active" }] });
    setMockMetadata("c.md", {
      tags: [{ tag: "#project/active/sub" }],
    });
    const r = await getFilesByTagHandler({
      arguments: { tag: "project" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.includeNested).toBe(true);
    expect(data.totalFiles).toBe(3);
    expect(data.files.map((f: { path: string }) => f.path).sort()).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });

  test("excludes nested tags when includeNested = false", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    setMockMetadata("a.md", { tags: [{ tag: "#project" }] });
    setMockMetadata("b.md", { tags: [{ tag: "#project/active" }] });
    const r = await getFilesByTagHandler({
      arguments: { tag: "project", includeNested: "false" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.includeNested).toBe(false);
    expect(data.totalFiles).toBe(1);
    expect(data.files).toEqual([{ path: "a.md", count: 1 }]);
  });

  test("matching is case-insensitive", async () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", { tags: [{ tag: "#Project" }] });
    const r = await getFilesByTagHandler({
      arguments: { tag: "PROJECT" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalFiles).toBe(1);
    expect(data.tag).toBe("#project");
  });

  test("sort is count desc with path-asc tiebreaker", async () => {
    setMockFile("z.md", "");
    setMockFile("a.md", "");
    setMockFile("m.md", "");
    setMockFile("low.md", "");
    setMockMetadata("z.md", {
      tags: [{ tag: "#tag" }, { tag: "#tag" }, { tag: "#tag" }],
    });
    setMockMetadata("a.md", { tags: [{ tag: "#tag" }, { tag: "#tag" }] });
    setMockMetadata("m.md", { tags: [{ tag: "#tag" }, { tag: "#tag" }] });
    setMockMetadata("low.md", { tags: [{ tag: "#tag" }] });

    const r = await getFilesByTagHandler({
      arguments: { tag: "tag" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.files).toEqual([
      { path: "z.md", count: 3 },
      { path: "a.md", count: 2 },
      { path: "m.md", count: 2 },
      { path: "low.md", count: 1 },
    ]);
  });

  test("rejects empty tag input", async () => {
    const r = await getFilesByTagHandler({
      arguments: { tag: "  " },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Invalid tag");
  });

  test("rejects tag input that is only `#` characters", async () => {
    const r = await getFilesByTagHandler({
      arguments: { tag: "###" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Invalid tag");
  });

  test("ignores files outside the markdown set", async () => {
    setMockFile("note.md", "");
    setMockFile("image.png", "");
    setMockMetadata("note.md", { tags: [{ tag: "#k" }] });
    // image.png is not a markdown file → vault.getMarkdownFiles()
    // skips it; no metadata cache lookup is attempted.
    const r = await getFilesByTagHandler({
      arguments: { tag: "k" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalFiles).toBe(1);
    expect(data.files[0].path).toBe("note.md");
  });
});
