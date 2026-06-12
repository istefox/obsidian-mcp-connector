import { describe, expect, test, beforeEach } from "bun:test";
import { getBacklinksHandler, getBacklinksSchema } from "./getBacklinks";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockResolvedLinks,
  setMockUnresolvedLinks,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_backlinks tool", () => {
  test("schema declares the tool name", () => {
    expect(getBacklinksSchema.get("name")?.toString()).toContain(
      "get_backlinks",
    );
  });

  test("returns empty result when no file links to the target", async () => {
    setMockFile("target.md", "");
    const r = await getBacklinksHandler({
      arguments: { path: "target.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data).toEqual({
      target: "target.md",
      totalBacklinks: 0,
      backlinks: [],
    });
  });

  test("returns a single backlink when one source links the target", async () => {
    setMockFile("target.md", "");
    setMockFile("source.md", "");
    setMockResolvedLinks("source.md", { "target.md": 1 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalBacklinks).toBe(1);
    expect(data.backlinks).toEqual([{ path: "source.md", count: 1 }]);
  });

  test("returns multiple sources with their per-source counts", async () => {
    setMockFile("target.md", "");
    setMockResolvedLinks("a.md", { "target.md": 3 });
    setMockResolvedLinks("b.md", { "target.md": 1 });
    setMockResolvedLinks("c.md", { "target.md": 2 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalBacklinks).toBe(3);
    expect(data.backlinks).toEqual([
      { path: "a.md", count: 3 },
      { path: "c.md", count: 2 },
      { path: "b.md", count: 1 },
    ]);
  });

  test("ignores sources whose link count for the target is zero", async () => {
    setMockResolvedLinks("source.md", { "other.md": 5 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalBacklinks).toBe(0);
  });

  test("handles a self-link (file links to itself)", async () => {
    setMockFile("note.md", "");
    setMockResolvedLinks("note.md", { "note.md": 2 });
    const r = await getBacklinksHandler({
      arguments: { path: "note.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.backlinks).toEqual([{ path: "note.md", count: 2 }]);
  });

  test("does not error when the target file doesn't exist on disk", async () => {
    // Common after deletion: backlinks survive their target.
    setMockResolvedLinks("source.md", { "deleted.md": 1 });
    const r = await getBacklinksHandler({
      arguments: { path: "deleted.md" },
      app: mockApp(),
    });
    expect(r.content[0].text).not.toContain("File not found");
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalBacklinks).toBe(1);
  });

  test("excludes unresolved-link sources by default", async () => {
    setMockResolvedLinks("real.md", { "target.md": 1 });
    setMockUnresolvedLinks("typo.md", { target: 1 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.backlinks.map((b: { path: string }) => b.path)).toEqual([
      "real.md",
    ]);
  });

  test("includeUnresolved=true picks up basename matches", async () => {
    // typo.md uses `[[target]]` (no extension) which doesn't resolve;
    // when opted-in, it should still surface as a backlink.
    setMockUnresolvedLinks("typo.md", { target: 1 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md", includeUnresolved: "true" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.backlinks).toEqual([{ path: "typo.md", count: 1 }]);
  });

  test("includeUnresolved=true picks up exact path matches", async () => {
    setMockUnresolvedLinks("typo.md", { "target.md": 2 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md", includeUnresolved: "true" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.backlinks).toEqual([{ path: "typo.md", count: 2 }]);
  });

  test("aggregates resolved + unresolved counts from the same source", async () => {
    setMockResolvedLinks("mixed.md", { "target.md": 1 });
    setMockUnresolvedLinks("mixed.md", { target: 2 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md", includeUnresolved: "true" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.backlinks).toEqual([{ path: "mixed.md", count: 3 }]);
  });

  test("sort tiebreaker is path-asc for equal counts", async () => {
    setMockResolvedLinks("zebra.md", { "target.md": 2 });
    setMockResolvedLinks("apple.md", { "target.md": 2 });
    setMockResolvedLinks("mango.md", { "target.md": 2 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.backlinks.map((b: { path: string }) => b.path)).toEqual([
      "apple.md",
      "mango.md",
      "zebra.md",
    ]);
  });

  test("caps output at limit and reports truncated+total", async () => {
    setMockResolvedLinks("a.md", { "target.md": 3 });
    setMockResolvedLinks("b.md", { "target.md": 2 });
    setMockResolvedLinks("c.md", { "target.md": 1 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md", limit: 2 },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.backlinks).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.totalBacklinks).toBe(3);
  });

  test("default limit leaves a small result set untouched (no truncated field)", async () => {
    setMockResolvedLinks("a.md", { "target.md": 1 });
    setMockResolvedLinks("b.md", { "target.md": 1 });
    const r = await getBacklinksHandler({
      arguments: { path: "target.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.backlinks).toHaveLength(2);
    expect(data.truncated).toBeUndefined();
  });
});
