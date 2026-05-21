import { describe, expect, test, beforeEach } from "bun:test";
import {
  searchVaultSimpleHandler,
  searchVaultSimpleSchema,
} from "./searchVaultSimple";
import { mockApp, resetMockVault, setMockFile } from "$/test-setup";

beforeEach(() => resetMockVault());

describe("search_vault_simple tool", () => {
  test("schema declares the tool name", () => {
    expect(searchVaultSimpleSchema.get("name")?.toString()).toContain(
      "search_vault_simple",
    );
  });

  test("finds substring matches across vault files", async () => {
    setMockFile("a.md", "Hello world. Foo bar.");
    setMockFile("b.md", "No relevant text here.");
    setMockFile("c.md", "Saying world peace.");

    const result = await searchVaultSimpleHandler({
      arguments: { query: "world" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    const paths = data.results.map((r: { filename: string }) => r.filename);
    expect(paths).toContain("a.md");
    expect(paths).toContain("c.md");
    expect(paths).not.toContain("b.md");
  });

  test("respects contextLength parameter", async () => {
    setMockFile("a.md", "Aaaaaaaaaa hit Bbbbbbbbbb"); // 10 chars before/after
    const result = await searchVaultSimpleHandler({
      arguments: { query: "hit", contextLength: 3 },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results).toHaveLength(1);
    const match = data.results[0].matches[0];
    // Context should be roughly 3 chars on each side
    expect((match.context as string).length).toBeLessThanOrEqual(3 + 3 + 3); // 3 before + match (3) + 3 after
  });

  test("respects limit parameter (regression: issue #62)", async () => {
    setMockFile("a.md", "match");
    setMockFile("b.md", "match");
    setMockFile("c.md", "match");
    setMockFile("d.md", "match");
    setMockFile("e.md", "match");

    const result = await searchVaultSimpleHandler({
      arguments: { query: "match", limit: 2 },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results.length).toBeLessThanOrEqual(2);
  });

  test("returns empty results on no matches", async () => {
    setMockFile("a.md", "irrelevant");
    const result = await searchVaultSimpleHandler({
      arguments: { query: "nomatch" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results).toEqual([]);
  });

  test("is case-insensitive by default", async () => {
    setMockFile("a.md", "HELLO World");
    const result = await searchVaultSimpleHandler({
      arguments: { query: "hello" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results).toHaveLength(1);
  });
});
