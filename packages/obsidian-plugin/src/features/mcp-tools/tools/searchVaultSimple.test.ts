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

  test("reports the 0-indexed line each match starts at", async () => {
    setMockFile("multiline.md", "line zero\nline one\nhit here\nline three");
    const result = await searchVaultSimpleHandler({
      arguments: { query: "hit" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results[0].matches[0].line).toBe(2);
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

describe("search_vault_simple — regex-literal scan", () => {
  test("regex metacharacters in the query match literally", async () => {
    setMockFile("notes.md", "Version a.b(c) shipped. Also axbxcx here.");

    const result = await searchVaultSimpleHandler({
      arguments: { query: "a.b(c)" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].matches).toHaveLength(1);
    expect(data.results[0].matches[0].context).toContain("a.b(c)");
  });

  test("overlapping-step parity: matches advance by query length", async () => {
    // "aaaa" with query "aa" → matches at 0 and 2 (not 1), matching
    // the previous indexOf stepping.
    setMockFile("steps.md", "aaaa");

    const result = await searchVaultSimpleHandler({
      arguments: { query: "aa", contextLength: 0 },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(
      data.results[0].matches.map(
        (m: { match: { start: number } }) => m.match.start,
      ),
    ).toEqual([0, 2]);
  });

  test("result order is stable and limit stops across batches", async () => {
    // 20 matching files: more than two read batches of 8.
    for (let i = 0; i < 20; i++) {
      setMockFile(`f${String(i).padStart(2, "0")}.md`, `target ${i}`);
    }

    const result = await searchVaultSimpleHandler({
      arguments: { query: "target", limit: 10 },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results).toHaveLength(10);
    const names = data.results.map((r: { filename: string }) => r.filename);
    expect(names).toEqual([...names].sort()); // vault order preserved
  });
});

describe("search_vault_simple — content bytes are pinned for a client that never reads _meta (R-06)", () => {
  // The literal below was captured from this handler's actual output for
  // this exact fixture and query, then pasted in — it is not derived or
  // recomputed here. A structural comparison (parsing content[0].text and
  // checking fields) would not catch a change to key order, whitespace or
  // a renamed field, and those are exactly the things a client reading
  // raw text is exposed to. If the payload work ever touches the argument
  // passed to successText(), this test fails loudly; if it only adds a
  // sibling _meta key, this test keeps passing.
  test("JSON.stringify(result.content) matches the captured literal", async () => {
    setMockFile(
      "vault-fixture.md",
      "The quick brown fox jumps over the lazy dog. The fox runs again.",
    );
    const result = await searchVaultSimpleHandler({
      arguments: { query: "fox" },
      app: mockApp(),
    });
    expect(JSON.stringify(result.content)).toBe(
      '[{"type":"text","text":"{\\"results\\":[{\\"filename\\":\\"vault-fixture.md\\",\\"matches\\":[{\\"context\\":\\"The quick brown fox jumps over the lazy dog. The fox runs again.\\",\\"match\\":{\\"start\\":16,\\"end\\":19},\\"line\\":0},{\\"context\\":\\"The quick brown fox jumps over the lazy dog. The fox runs again.\\",\\"match\\":{\\"start\\":49,\\"end\\":52},\\"line\\":0}]}]}"}]',
    );
  });
});

describe("search_vault_simple — result _meta carries the structured payload on success (R-05, ADR-0018 D5/D6)", () => {
  test("_meta.io.github.istefox.mcp-connector/searchResults carries vaultName, totalRows, truncated and rows; structuredContent is absent", async () => {
    setMockFile("a.md", "one hit here");
    const result = (await searchVaultSimpleHandler({
      arguments: { query: "hit" },
      app: mockApp(),
    })) as {
      content: Array<{ type: "text"; text: string }>;
      _meta?: Record<string, unknown>;
      structuredContent?: unknown;
    };

    const payload = result._meta?.[
      "io.github.istefox.mcp-connector/searchResults"
    ] as
      | {
          vaultName: string;
          totalRows: number;
          truncated: boolean;
          rows: unknown[];
        }
      | undefined;
    expect(payload).toBeDefined();
    expect(typeof payload?.vaultName).toBe("string");
    expect(typeof payload?.totalRows).toBe("number");
    expect(typeof payload?.truncated).toBe("boolean");
    expect(Array.isArray(payload?.rows)).toBe(true);

    // structuredContent is a first-class, client-visible field; emitting
    // it alongside a payload that only ever lives in _meta would invite a
    // client to expect the pair (ADR-0018 D4). Whether the tool's
    // *tools/list* entry carries no outputSchema is checked where that
    // entry actually exists — mcpServer.test.ts — not on the call result,
    // which never carries that key regardless.
    expect("structuredContent" in result).toBe(false);
  });
});
