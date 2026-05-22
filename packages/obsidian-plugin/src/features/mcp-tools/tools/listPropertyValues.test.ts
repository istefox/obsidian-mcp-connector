import { describe, expect, test, beforeEach } from "bun:test";
import {
  listPropertyValuesHandler,
  listPropertyValuesSchema,
} from "./listPropertyValues";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

function seed(path: string, fm: Record<string, unknown>): void {
  setMockFile(path, "");
  setMockMetadata(path, { frontmatter: fm });
}

describe("list_property_values tool", () => {
  test("schema declares the tool name", () => {
    expect(listPropertyValuesSchema.get("name")?.toString()).toContain(
      "list_property_values",
    );
  });

  test("counts distinct values descending with native types preserved", async () => {
    seed("a.md", { status: "active" });
    seed("b.md", { status: "active" });
    seed("c.md", { status: "done" });
    seed("d.md", { priority: 5 });
    const r = await listPropertyValuesHandler({
      arguments: { key: "status" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalDistinct).toBe(2);
    expect(data.truncated).toBe(false);
    expect(data.values).toEqual([
      { value: "active", count: 2 },
      { value: "done", count: 1 },
    ]);
  });

  test("preserves number vs string as distinct values", async () => {
    seed("a.md", { p: 5 });
    seed("b.md", { p: "5" });
    const r = await listPropertyValuesHandler({
      arguments: { key: "p" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalDistinct).toBe(2);
    const values = data.values.map((v: { value: unknown }) => v.value);
    expect(values).toContain(5);
    expect(values).toContain("5");
  });

  test("explodes list-valued frontmatter into per-element occurrences", async () => {
    seed("a.md", { tags: ["x", "y"] });
    seed("b.md", { tags: ["x"] });
    const r = await listPropertyValuesHandler({
      arguments: { key: "tags" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.values).toEqual([
      { value: "x", count: 2 },
      { value: "y", count: 1 },
    ]);
  });

  test("filters by folder prefix", async () => {
    seed("Projects/a.md", { status: "active" });
    seed("Archive/b.md", { status: "active" });
    const r = await listPropertyValuesHandler({
      arguments: { key: "status", folder: "Projects" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalDistinct).toBe(1);
    expect(data.values).toEqual([{ value: "active", count: 1 }]);
  });

  test("accepts a folder prefix that already ends in a slash", async () => {
    seed("Projects/a.md", { status: "active" });
    seed("Archive/b.md", { status: "active" });
    const r = await listPropertyValuesHandler({
      arguments: { key: "status", folder: "Projects/" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalDistinct).toBe(1);
    expect(data.values).toEqual([{ value: "active", count: 1 }]);
  });

  test("truncates to limit and reports totalDistinct", async () => {
    seed("a.md", { k: "v1" });
    seed("b.md", { k: "v2" });
    seed("c.md", { k: "v3" });
    const r = await listPropertyValuesHandler({
      arguments: { key: "k", limit: 2 },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.values.length).toBe(2);
    expect(data.truncated).toBe(true);
    expect(data.totalDistinct).toBe(3);
  });

  test("returns empty wrapper when no note has the key", async () => {
    seed("a.md", { other: "x" });
    const r = await listPropertyValuesHandler({
      arguments: { key: "absent" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data).toEqual({
      key: "absent",
      values: [],
      truncated: false,
      totalDistinct: 0,
    });
  });
});
