import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFileStat,
  setMockFolder,
  setMockMetadata,
  setMockResolvedLinks,
  setMockUnresolvedLinks,
} from "$/test-setup";
import { getFileInfoHandler, getFileInfoSchema } from "./getFileInfo";

beforeEach(() => resetMockVault());

async function run(path: string) {
  const r = await getFileInfoHandler({ arguments: { path }, app: mockApp() });
  return { r, data: JSON.parse(r.content[0].text) };
}

describe("get_file_info", () => {
  test("schema declares the tool name", () => {
    expect(getFileInfoSchema.get("name").toString()).toContain("get_file_info");
  });

  test("describes a markdown note from stat, links and the metadata cache", async () => {
    setMockFile("Notes/plan.md", "# Plan\n\n- [ ] a\n- [x] b\n- c\n");
    setMockFileStat("Notes/plan.md", { ctime: 100, mtime: 200 });
    setMockMetadata("Notes/plan.md", {
      frontmatter: { title: "Plan", tags: ["x", "y"], position: {} },
      headings: [{ heading: "Plan", level: 1, line: 0 }],
      tags: [{ tag: "#inline", line: 4 }],
      links: [{ link: "other" }, { link: "missing" }],
      embeds: [{ link: "img.png" }],
      listItems: [{ line: 2, task: " " }, { line: 3, task: "x" }, { line: 4 }],
    });
    setMockResolvedLinks("Notes/plan.md", {
      "other.md": 1,
      "img.png": 1,
    });
    setMockUnresolvedLinks("Notes/plan.md", { missing: 1 });
    setMockResolvedLinks("a.md", { "Notes/plan.md": 2 });
    setMockResolvedLinks("b.md", { "Notes/plan.md": 1 });

    const { r, data } = await run("Notes/plan.md");
    expect(r.isError).toBeUndefined();
    expect(data).toEqual({
      path: "Notes/plan.md",
      name: "plan.md",
      basename: "plan",
      extension: "md",
      kind: "markdown",
      mime: "text/markdown",
      size: "# Plan\n\n- [ ] a\n- [x] b\n- c\n".length,
      ctime: 100,
      mtime: 200,
      uri: "obsidian://open?vault=Test%20Vault&file=Notes%2Fplan.md",
      backlinks: { files: 2, references: 3 },
      outgoingLinks: { resolved: 2, unresolved: 1 },
      markdown: {
        hasFrontmatter: true,
        frontmatterKeys: 2,
        headings: 1,
        tags: 3,
        links: 2,
        embeds: 1,
        listItems: 3,
        tasks: { total: 2, open: 1, done: 1 },
      },
    });
  });

  test("a note with no cache entry reports zero counts, not an error", async () => {
    setMockFile("bare.md", "");
    const { r, data } = await run("bare.md");
    expect(r.isError).toBeUndefined();
    expect(data.markdown).toEqual({
      hasFrontmatter: false,
      frontmatterKeys: 0,
      headings: 0,
      tags: 0,
      links: 0,
      embeds: 0,
      listItems: 0,
      tasks: { total: 0, open: 0, done: 0 },
    });
    expect(data.backlinks).toEqual({ files: 0, references: 0 });
  });

  test("counts comma-separated frontmatter tags", async () => {
    setMockFile("t.md", "");
    setMockMetadata("t.md", { frontmatter: { tag: "a, b ,,c" } });
    const { data } = await run("t.md");
    expect(data.markdown.tags).toBe(3);
  });

  test("classifies binaries by extension and leaves markdown null", async () => {
    setMockFile("img/Photo.JPG", "xxxx");
    setMockResolvedLinks("n.md", { "img/Photo.JPG": 2 });
    const { data } = await run("img/Photo.JPG");
    expect(data).toMatchObject({
      name: "Photo.JPG",
      basename: "Photo",
      extension: "JPG",
      kind: "image",
      mime: "image/jpeg",
      size: 4,
      backlinks: { files: 1, references: 2 },
      outgoingLinks: { resolved: 0, unresolved: 0 },
      markdown: null,
    });
  });

  test.each([
    ["a.canvas", "canvas", "application/json"],
    ["a.base", "base", "application/yaml"],
    ["a.csv", "text", "text/csv"],
    ["a.mp3", "audio", "audio/mpeg"],
    ["a.mp4", "video", "video/mp4"],
    ["a.pdf", "pdf", "application/pdf"],
    [
      "a.docx",
      "document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["a.zip", "archive", "application/zip"],
    ["a.xyz", "binary", "application/octet-stream"],
    ["noext", "binary", "application/octet-stream"],
  ])("%s is kind %s with mime %s", async (path, kind, mime) => {
    setMockFile(path, "");
    const { data } = await run(path);
    expect(data.kind).toBe(kind);
    expect(data.mime).toBe(mime);
  });

  test("missing file and folder paths are typed errors", async () => {
    setMockFolder("dir");
    const missing = await run("nope.md");
    expect(missing.r.isError).toBe(true);
    expect(missing.data).toMatchObject({
      errorCode: "file_not_found",
      path: "nope.md",
    });
    const folder = await run("dir");
    expect(folder.r.isError).toBe(true);
    expect(folder.data).toMatchObject({ errorCode: "not_a_file", path: "dir" });
  });
});
