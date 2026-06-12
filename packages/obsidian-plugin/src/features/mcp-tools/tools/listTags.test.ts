import { describe, expect, test, beforeEach } from "bun:test";
import { listTagsHandler, listTagsSchema } from "./listTags";
import { mockApp, resetMockVault, setMockTags } from "$/test-setup";

beforeEach(() => resetMockVault());

describe("list_tags tool", () => {
  test("schema declares the tool name", () => {
    expect(listTagsSchema.get("name")?.toString()).toContain("list_tags");
  });

  test("returns empty result when vault has no tags", async () => {
    const r = await listTagsHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data).toEqual({ totalTags: 0, tags: [] });
  });

  test("returns all tags with counts when vault has tags", async () => {
    setMockTags({ "#project": 5, "#daily": 12, "#idea": 1 });
    const r = await listTagsHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalTags).toBe(3);
    expect(data.tags).toHaveLength(3);
    expect(data.tags.map((t: { tag: string }) => t.tag).sort()).toEqual([
      "#daily",
      "#idea",
      "#project",
    ]);
  });

  test("default sort is by count descending", async () => {
    setMockTags({ "#a": 1, "#b": 10, "#c": 5 });
    const r = await listTagsHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.tags).toEqual([
      { tag: "#b", count: 10 },
      { tag: "#c", count: 5 },
      { tag: "#a", count: 1 },
    ]);
  });

  test("sort by name returns alphabetical order", async () => {
    setMockTags({ "#zebra": 1, "#apple": 100, "#mango": 5 });
    const r = await listTagsHandler({
      arguments: { sort: "name" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.tags.map((t: { tag: string }) => t.tag)).toEqual([
      "#apple",
      "#mango",
      "#zebra",
    ]);
  });

  test("explicit sort by count matches default behaviour", async () => {
    setMockTags({ "#a": 3, "#b": 7 });
    const r = await listTagsHandler({
      arguments: { sort: "count" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.tags[0]).toEqual({ tag: "#b", count: 7 });
    expect(data.tags[1]).toEqual({ tag: "#a", count: 3 });
  });

  test("preserves nested tag paths verbatim", async () => {
    setMockTags({
      "#project/active": 4,
      "#project/archived": 2,
      "#project": 1,
    });
    const r = await listTagsHandler({
      arguments: { sort: "name" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.tags.map((t: { tag: string }) => t.tag)).toEqual([
      "#project",
      "#project/active",
      "#project/archived",
    ]);
  });

  test("count desc applies a name-ascending tiebreaker on equal counts", async () => {
    setMockTags({ "#zebra": 5, "#apple": 5, "#mango": 5, "#banana": 1 });
    const r = await listTagsHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.tags).toEqual([
      { tag: "#apple", count: 5 },
      { tag: "#mango", count: 5 },
      { tag: "#zebra", count: 5 },
      { tag: "#banana", count: 1 },
    ]);
  });

  test("preserves special characters in tag names verbatim", async () => {
    setMockTags({
      "#tag-with-dash": 3,
      "#tag_with_underscore": 2,
      "#numeric-2026": 1,
    });
    const r = await listTagsHandler({
      arguments: { sort: "name" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    // `Intl.Collator("en", { sensitivity: "variant" })` orders `_` before
    // `-` (Unicode-aware punctuation order, not ASCII byte-wise). Pinned
    // here so the cross-platform sort contract stays observable.
    expect(data.tags.map((t: { tag: string }) => t.tag)).toEqual([
      "#numeric-2026",
      "#tag_with_underscore",
      "#tag-with-dash",
    ]);
  });

  test("count sort orders nested + root tags deterministically on ties", async () => {
    setMockTags({
      "#project/active": 1,
      "#project": 1,
      "#area/work": 1,
      "#area": 1,
    });
    const r = await listTagsHandler({
      arguments: { sort: "count" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    // All counts equal → tiebreaker by name asc; root before nested
    // because the bare prefix sorts before its `/`-extended descendants.
    expect(data.tags.map((t: { tag: string }) => t.tag)).toEqual([
      "#area",
      "#area/work",
      "#project",
      "#project/active",
    ]);
  });

  test("caps output at limit and reports truncated+total", async () => {
    setMockTags({ "#a": 3, "#b": 2, "#c": 1 });
    const r = await listTagsHandler({
      arguments: { limit: 2 },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.tags).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.totalTags).toBe(3);
  });

  test("default limit leaves a small result set untouched (no truncated field)", async () => {
    setMockTags({ "#a": 1, "#b": 2 });
    const r = await listTagsHandler({ arguments: {}, app: mockApp() });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.tags).toHaveLength(2);
    expect(data.truncated).toBeUndefined();
  });
});
