// findOrphanedNotes.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import {
  findOrphanedNotesHandler,
  findOrphanedNotesSchema,
} from "./findOrphanedNotes";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockResolvedLinks,
  setMockFileStat,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("find_orphaned_notes tool", () => {
  test("schema declares the tool name", () => {
    expect(findOrphanedNotesSchema.get("name")?.toString()).toContain(
      "find_orphaned_notes",
    );
  });

  test("returns empty on a vault where every note is referenced", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    setMockResolvedLinks("a.md", { "b.md": 1 });
    setMockResolvedLinks("b.md", { "a.md": 1 });
    const r = await findOrphanedNotesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.total_orphaned).toBe(0);
  });

  test("detects a note with no incoming links", async () => {
    setMockFile("also-orphan.md", "");
    setMockFile("orphan.md", "");
    setMockResolvedLinks("also-orphan.md", {}); // links to nobody
    // orphan.md is not in any resolvedLinks value
    const r = await findOrphanedNotesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.total_orphaned).toBe(2); // both are orphans (neither is linked-to)
    const paths = data.orphaned_notes.map((n: { path: string }) => n.path);
    expect(paths).toContain("orphan.md");
  });

  test("a note linked from an excluded folder is NOT an orphan", async () => {
    setMockFile("note.md", "");
    setMockFile("templates/t.md", "");
    // links from the excluded folder still count as incoming
    setMockResolvedLinks("templates/t.md", { "note.md": 1 });
    const r = await findOrphanedNotesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    const paths = data.orphaned_notes.map((n: { path: string }) => n.path);
    expect(paths).not.toContain("note.md");
  });

  test("excludes notes inside excluded folders from orphan output", async () => {
    setMockFile("templates/t.md", "");
    // t.md has no incoming links — but it's in templates (excluded by default)
    const r = await findOrphanedNotesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    const paths = data.orphaned_notes.map((n: { path: string }) => n.path);
    expect(paths).not.toContain("templates/t.md");
  });

  test("returns mtime and size per orphan entry", async () => {
    setMockFile("solo.md", "hello world");
    setMockFileStat("solo.md", { mtime: 12345 });
    const r = await findOrphanedNotesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    const entry = data.orphaned_notes[0];
    expect(entry.path).toBe("solo.md");
    expect(entry.mtime).toBe(12345);
    expect(entry.size).toBe(11); // "hello world".length
  });

  test("returns empty result on empty vault", async () => {
    const r = await findOrphanedNotesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.total_orphaned).toBe(0);
    expect(data.orphaned_notes).toEqual([]);
  });

  test("caps output at limit and reports truncated+total", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    setMockFile("c.md", "");
    const r = await findOrphanedNotesHandler({
      arguments: { limit: 2 },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.orphaned_notes).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.total_orphaned).toBe(3);
  });

  test("default limit leaves a small result set untouched (no truncated field)", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");
    const r = await findOrphanedNotesHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.orphaned_notes).toHaveLength(2);
    expect(data.truncated).toBeUndefined();
  });
});
