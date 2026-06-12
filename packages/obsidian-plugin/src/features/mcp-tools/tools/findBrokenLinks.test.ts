import { describe, expect, test, beforeEach } from "bun:test";
import {
  findBrokenLinksHandler,
  findBrokenLinksSchema,
} from "./findBrokenLinks";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("find_broken_links tool", () => {
  test("schema declares the tool name", () => {
    expect(findBrokenLinksSchema.get("name")?.toString()).toContain(
      "find_broken_links",
    );
  });

  test("returns empty result on a vault with no broken links", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    setMockMetadata("a.md", { links: [{ link: "b", line: 2 }] });
    const r = await findBrokenLinksHandler({
      arguments: {},
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.total_broken_links).toBe(0);
    expect(data.broken_links).toEqual([]);
  });

  test("detects a broken wiki-link", async () => {
    setMockFile("a.md", "");
    setMockMetadata("a.md", {
      links: [{ link: "NonExistent", original: "[[NonExistent]]", line: 3 }],
    });
    const r = await findBrokenLinksHandler({
      arguments: {},
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.total_broken_links).toBe(1);
    const entry = data.broken_links[0];
    expect(entry.source_path).toBe("a.md");
    expect(entry.link_target).toBe("NonExistent");
    expect(entry.line_number).toBe(4); // 0-based line 3 → 1-based 4
    expect(entry.link_type).toBe("link");
    expect(entry.original).toBe("[[NonExistent]]");
  });

  test("detects a broken embed", async () => {
    setMockFile("a.md", "");
    setMockMetadata("a.md", {
      embeds: [{ link: "missing.png", original: "![[missing.png]]", line: 1 }],
    });
    const r = await findBrokenLinksHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.total_broken_links).toBe(1);
    expect(data.broken_links[0].link_type).toBe("embed");
  });

  test("detects a broken frontmatter link", async () => {
    setMockFile("a.md", "");
    setMockMetadata("a.md", {
      frontmatterLinks: [
        { link: "GhostNote", original: "[[GhostNote]]", key: "parent" },
      ],
    });
    const r = await findBrokenLinksHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.total_broken_links).toBe(1);
    expect(data.broken_links[0].link_type).toBe("frontmatter");
    expect(data.broken_links[0].line_number).toBe(0); // frontmatter sentinel
  });

  test("excludes files in default excluded folders", async () => {
    setMockFile("templates/my-template.md", "");
    setMockMetadata("templates/my-template.md", {
      links: [{ link: "BrokenFromTemplate", line: 1 }],
    });
    const r = await findBrokenLinksHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.total_broken_links).toBe(0);
    expect(data.excluded_folders).toContain("templates");
  });

  test("override exclude_folders replaces defaults entirely", async () => {
    setMockFile("templates/t.md", "");
    setMockMetadata("templates/t.md", {
      links: [{ link: "Broken", line: 1 }],
    });
    setMockFile("custom-exclude/n.md", "");
    setMockMetadata("custom-exclude/n.md", {
      links: [{ link: "AlsoBroken", line: 1 }],
    });
    // Override: only exclude custom-exclude, not templates
    const r = await findBrokenLinksHandler({
      arguments: { exclude_folders: ["custom-exclude"] },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    // templates/t.md is now scanned → its broken link surfaces
    const sources = data.broken_links.map(
      (e: { source_path: string }) => e.source_path,
    );
    expect(sources).toContain("templates/t.md");
    expect(sources).not.toContain("custom-exclude/n.md");
  });

  test("reports scanned_files count", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    const r = await findBrokenLinksHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.scanned_files).toBe(2);
  });

  test("scope limits scan to matching path prefix", async () => {
    setMockFile("Projects/2026/note.md", "");
    setMockFile("Resources/ref.md", "");
    setMockFile("Archive/old.md", "");
    setMockMetadata("Projects/2026/note.md", {
      links: [{ link: "BrokenA", line: 1 }],
    });
    setMockMetadata("Resources/ref.md", {
      links: [{ link: "BrokenB", line: 1 }],
    });
    setMockMetadata("Archive/old.md", {
      links: [{ link: "BrokenC", line: 1 }],
    });
    const r = await findBrokenLinksHandler({
      arguments: { scope: ["Projects/2026", "Resources"], exclude_folders: [] },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    const sources = data.broken_links.map(
      (e: { source_path: string }) => e.source_path,
    );
    expect(sources).toContain("Projects/2026/note.md");
    expect(sources).toContain("Resources/ref.md");
    expect(sources).not.toContain("Archive/old.md");
    expect(data.scope).toEqual(["Projects/2026", "Resources"]);
    expect(data.scanned_files).toBe(2);
  });

  test("scope with trailing slash is normalised", async () => {
    setMockFile("Projects/note.md", "");
    setMockFile("Other/note.md", "");
    setMockMetadata("Projects/note.md", {
      links: [{ link: "Broken", line: 1 }],
    });
    setMockMetadata("Other/note.md", {
      links: [{ link: "AlsoBroken", line: 1 }],
    });
    const r = await findBrokenLinksHandler({
      arguments: { scope: ["Projects/"], exclude_folders: [] },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    const sources = data.broken_links.map(
      (e: { source_path: string }) => e.source_path,
    );
    expect(sources).toContain("Projects/note.md");
    expect(sources).not.toContain("Other/note.md");
  });

  test("omitting scope scans the entire vault", async () => {
    setMockFile("A/note.md", "");
    setMockFile("B/note.md", "");
    setMockMetadata("A/note.md", { links: [{ link: "Broken", line: 1 }] });
    setMockMetadata("B/note.md", { links: [{ link: "BrokenB", line: 1 }] });
    const r = await findBrokenLinksHandler({
      arguments: { exclude_folders: [] },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.scanned_files).toBe(2);
    expect(data.scope).toBeUndefined();
  });

  test("skips files with no metadata cache gracefully", async () => {
    setMockFile("no-cache.md", "[[BrokenLink]]");
    // no setMockMetadata → getFileCache returns null — file is skipped, not an error
    const r = await findBrokenLinksHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    // scanned_files is incremented before the cache check — file counts as scanned
    expect(data.scanned_files).toBe(1);
    expect(data.total_broken_links).toBe(0);
    expect((r as { isError?: boolean }).isError).toBeUndefined();
  });

  test("caps output at limit and reports truncated+total (applied after scope)", async () => {
    setMockFile("Projects/a.md", "");
    setMockFile("Archive/old.md", "");
    setMockMetadata("Projects/a.md", {
      links: [
        { link: "BrokenA", line: 1 },
        { link: "BrokenB", line: 2 },
        { link: "BrokenC", line: 3 },
      ],
    });
    // Outside scope — must not contribute to the full count.
    setMockMetadata("Archive/old.md", {
      links: [{ link: "BrokenD", line: 1 }],
    });
    const r = await findBrokenLinksHandler({
      arguments: { scope: ["Projects"], exclude_folders: [], limit: 2 },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.broken_links).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.total_broken_links).toBe(3);
  });

  test("default limit leaves a small result set untouched (no truncated field)", async () => {
    setMockFile("a.md", "");
    setMockMetadata("a.md", {
      links: [
        { link: "BrokenA", line: 1 },
        { link: "BrokenB", line: 2 },
      ],
    });
    const r = await findBrokenLinksHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.broken_links).toHaveLength(2);
    expect(data.truncated).toBeUndefined();
  });
});
