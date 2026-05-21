import { describe, expect, test, beforeEach } from "bun:test";
import { type } from "arktype";
import {
  _resetMissingIsUserIgnoredWarning,
  getRecentFilesHandler,
  getRecentFilesSchema,
} from "./getRecentFiles";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFileStat,
  setMockIgnored,
} from "$/test-setup";

beforeEach(() => {
  resetMockVault();
  // The one-shot warning flag in `getRecentFiles.ts` persists at module
  // scope across tests; reset it so each test exercises a clean state.
  _resetMissingIsUserIgnoredWarning();
});

describe("get_recent_files tool", () => {
  test("schema declares the tool name", () => {
    expect(getRecentFilesSchema.get("name")?.toString()).toContain(
      "get_recent_files",
    );
  });

  test("returns empty result when vault has no files", async () => {
    const r = await getRecentFilesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data).toEqual({ totalFiles: 0, files: [] });
  });

  test("orders files by mtime descending", async () => {
    setMockFile("old.md", "");
    setMockFile("newest.md", "");
    setMockFile("middle.md", "");
    setMockFileStat("old.md", { mtime: 1000 });
    setMockFileStat("middle.md", { mtime: 2000 });
    setMockFileStat("newest.md", { mtime: 3000 });

    const r = await getRecentFilesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalFiles).toBe(3);
    expect(data.files.map((f: { path: string }) => f.path)).toEqual([
      "newest.md",
      "middle.md",
      "old.md",
    ]);
  });

  test("applies a path-ascending tiebreaker on equal mtimes", async () => {
    // Three files share the same `mtime` (common on bulk imports /
    // sync events). The response contract pins `path` ascending as
    // the secondary key so repeat calls return deterministic order
    // regardless of the underlying `vault.getMarkdownFiles()`
    // iteration order, which is undocumented.
    setMockFile("zebra.md", "");
    setMockFile("apple.md", "");
    setMockFile("mango.md", "");
    setMockFile("recent.md", "");
    setMockFileStat("zebra.md", { mtime: 1000 });
    setMockFileStat("apple.md", { mtime: 1000 });
    setMockFileStat("mango.md", { mtime: 1000 });
    setMockFileStat("recent.md", { mtime: 9999 });

    const r = await getRecentFilesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.files.map((f: { path: string }) => f.path)).toEqual([
      "recent.md",
      "apple.md",
      "mango.md",
      "zebra.md",
    ]);
  });

  test("default limit is 20", async () => {
    for (let i = 0; i < 25; i++) {
      const p = `note-${i}.md`;
      setMockFile(p, "");
      setMockFileStat(p, { mtime: i });
    }
    const r = await getRecentFilesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    // `totalFiles` reports the full visible set, regardless of `limit`.
    expect(data.totalFiles).toBe(25);
    expect(data.files).toHaveLength(20);
    // Most-recent first: indices 24, 23, …, 5.
    expect(data.files[0].path).toBe("note-24.md");
    expect(data.files[19].path).toBe("note-5.md");
  });

  test("respects explicit limit", async () => {
    for (let i = 0; i < 10; i++) {
      const p = `note-${i}.md`;
      setMockFile(p, "");
      setMockFileStat(p, { mtime: i });
    }
    const r = await getRecentFilesHandler({
      arguments: { limit: 3 },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalFiles).toBe(10);
    expect(data.files).toHaveLength(3);
    expect(data.files.map((f: { path: string }) => f.path)).toEqual([
      "note-9.md",
      "note-8.md",
      "note-7.md",
    ]);
  });

  test("limit larger than totalFiles returns all without error", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    setMockFile("c.md", "");
    setMockFileStat("a.md", { mtime: 1 });
    setMockFileStat("b.md", { mtime: 2 });
    setMockFileStat("c.md", { mtime: 3 });

    const r = await getRecentFilesHandler({
      arguments: { limit: 10 },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalFiles).toBe(3);
    expect(data.files).toHaveLength(3);
  });

  test("returns path/mtime/ctime/size per file", async () => {
    setMockFile("doc.md", "hello world");
    setMockFileStat("doc.md", { mtime: 5000, ctime: 1000 });

    const r = await getRecentFilesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.files).toHaveLength(1);
    const entry = data.files[0];
    expect(entry.path).toBe("doc.md");
    expect(entry.mtime).toBe(5000);
    expect(entry.ctime).toBe(1000);
    expect(typeof entry.size).toBe("number");
    expect(entry.size).toBeGreaterThan(0);
  });

  test("ignores non-markdown files", async () => {
    setMockFile("note.md", "");
    setMockFile("image.png", "");
    setMockFileStat("note.md", { mtime: 1 });
    setMockFileStat("image.png", { mtime: 999 });

    const r = await getRecentFilesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    // image.png is filtered out by `vault.getMarkdownFiles()` upstream,
    // so it should not appear or count toward `totalFiles`.
    expect(data.totalFiles).toBe(1);
    expect(data.files).toHaveLength(1);
    expect(data.files[0].path).toBe("note.md");
  });

  test("gracefully degrades when isUserIgnored is unavailable", async () => {
    // If a future Obsidian release renames or drops the runtime
    // `MetadataCache.isUserIgnored` accessor, the handler must NOT
    // throw — it falls back to "no exclusion applied" and emits a
    // one-shot warning to the plugin log. Verified here by stripping
    // the accessor from a fresh mockApp().
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    setMockFileStat("a.md", { mtime: 1 });
    setMockFileStat("b.md", { mtime: 2 });

    const app = mockApp();
    delete (app.metadataCache as unknown as { isUserIgnored?: unknown })
      .isUserIgnored;

    const r = await getRecentFilesHandler({ arguments: {}, app });
    const data = JSON.parse(r.content[0].text as string);
    // Without the exclusion accessor, all visible markdown files flow
    // through unfiltered.
    expect(data.totalFiles).toBe(2);
    expect(data.files).toHaveLength(2);
    expect(data.files[0].path).toBe("b.md");
    expect(data.files[1].path).toBe("a.md");
  });

  test("respects Obsidian's excluded files setting", async () => {
    setMockFile("kept.md", "");
    setMockFile("excluded/secret.md", "");
    setMockFileStat("kept.md", { mtime: 1 });
    setMockFileStat("excluded/secret.md", { mtime: 999 });
    // Match-by-exact-path mirrors how the mock backs `isUserIgnored`.
    // The production runtime resolves globs/regex from the user's
    // `Files & Links → Excluded files` setting to the same per-path
    // boolean, so the handler contract is identical.
    setMockIgnored("excluded/secret.md");

    const r = await getRecentFilesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    // The excluded file MUST NOT appear in `files` and MUST NOT count
    // toward `totalFiles` — exclusion is applied before the recency
    // slice, not after.
    expect(data.totalFiles).toBe(1);
    expect(data.files).toHaveLength(1);
    expect(data.files[0].path).toBe("kept.md");
  });

  test("schema rejects invalid limit values", () => {
    // arktype-level validation: 0, negatives, floats, and >100 all
    // bounce before reaching the handler. The MCP transport surfaces
    // schema rejections to the client as validation errors; pinning the
    // contract here keeps the boundary observable at the tool level.
    //
    // arktype returns an `ArkErrors` instance (array-like) on failure
    // and the parsed value on success — `instanceof type.errors` is the
    // canonical predicate.
    const validate = (limit: unknown) =>
      getRecentFilesSchema({
        name: "get_recent_files",
        arguments: { limit },
      });

    expect(validate(0) instanceof type.errors).toBe(true);
    expect(validate(-5) instanceof type.errors).toBe(true);
    expect(validate(5.5) instanceof type.errors).toBe(true);
    expect(validate(101) instanceof type.errors).toBe(true);

    // Boundary values pass.
    expect(validate(1) instanceof type.errors).toBe(false);
    expect(validate(100) instanceof type.errors).toBe(false);

    // Omitted `limit` is valid (handler applies the default of 20).
    expect(
      getRecentFilesSchema({
        name: "get_recent_files",
        arguments: {},
      }) instanceof type.errors,
    ).toBe(false);
  });
});
