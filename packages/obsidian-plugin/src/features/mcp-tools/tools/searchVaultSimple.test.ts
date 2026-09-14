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
    // "aaaa" with query "aa" → matches at 0 and 2 (not 1), matching the
    // previous indexOf stepping. Repaired per ADR-0023 D2 / R-02: `match`
    // ({start, end}) is removed from the response, so stepping order is
    // now verified via match count + `line` rather than `match.start`.
    setMockFile("steps.md", "aaaa");

    const result = await searchVaultSimpleHandler({
      arguments: { query: "aa", contextLength: 0 },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results[0].matches).toHaveLength(2);
    expect(
      data.results[0].matches.map((m: { line: number }) => m.line),
    ).toEqual([0, 0]);
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
  // The literal below was captured from this handler's expected output
  // (post-R-02: `match.start`/`match.end` removed, `line` retained) for
  // this exact fixture and query, then pasted in — it is not derived or
  // recomputed here. A structural comparison (parsing content[0].text and
  // checking fields) would not catch a change to key order, whitespace or
  // a renamed field, and those are exactly the things a client reading
  // raw text is exposed to. If the payload work ever touches the argument
  // passed to successText(), this test fails loudly; if it only adds a
  // sibling _meta key, this test keeps passing.
  //
  // Repaired for ADR-0023 D2 / R-02: the previous literal embedded
  // `match:{start,end}`, which the response no longer carries.
  test("JSON.stringify(result.content) matches the captured literal", async () => {
    setMockFile(
      "vault-fixture.md",
      "The quick brown fox jumps over the lazy dog. The fox runs again.",
    );
    const result = await searchVaultSimpleHandler({
      arguments: { query: "fox" },
      app: mockApp(),
    });
    // Repaired for ADR-0026 (issue #533): every row now carries a
    // file-level `uri` (see the describe block below), a deliberate
    // shape change to this literal, not drift.
    expect(JSON.stringify(result.content)).toBe(
      '[{"type":"text","text":"{\\"results\\":[{\\"filename\\":\\"vault-fixture.md\\",\\"matches\\":[{\\"context\\":\\"The quick brown fox jumps over the lazy dog. The fox runs again.\\",\\"line\\":0},{\\"context\\":\\"The quick brown fox jumps over the lazy dog. The fox runs again.\\",\\"line\\":0}],\\"uri\\":\\"obsidian://open?vault=Test%20Vault&file=vault-fixture.md\\"}]}"}]',
    );
  });
});

describe("search_vault_simple — maxMatchesPerFile cap and moreMatches flag (R-01, R-02)", () => {
  // Six literal "hit" occurrences, none overlapping, in one file.
  const SIX_HITS_TEXT = Array(6).fill("hit").join(" filler ");

  test("6 matches with maxMatchesPerFile: 5 → exactly 5 matches, moreMatches: true", async () => {
    setMockFile("six.md", SIX_HITS_TEXT);
    const result = await searchVaultSimpleHandler({
      arguments: { query: "hit", maxMatchesPerFile: 5 },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].matches).toHaveLength(5);
    expect(data.results[0].moreMatches).toBe(true);
  });

  test("off-by-one boundary: exactly maxMatchesPerFile matches → moreMatches is NOT true", async () => {
    // Five literal "hit" occurrences — exactly at the cap, not over it.
    const FIVE_HITS_TEXT = Array(5).fill("hit").join(" filler ");
    setMockFile("five.md", FIVE_HITS_TEXT);
    const result = await searchVaultSimpleHandler({
      arguments: { query: "hit", maxMatchesPerFile: 5 },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].matches).toHaveLength(5);
    // The flag means "there were more than the cap", not "at least the
    // cap" — an exact-cap file must not set it (falsy or absent both pass;
    // `true` is the only forbidden value).
    expect(data.results[0].moreMatches).not.toBe(true);
  });

  test("default maxMatchesPerFile (argument omitted) caps at 5", async () => {
    setMockFile("six-default.md", SIX_HITS_TEXT);
    const result = await searchVaultSimpleHandler({
      arguments: { query: "hit" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results[0].matches).toHaveLength(5);
    expect(data.results[0].moreMatches).toBe(true);
  });

  test("line survives and match ({start, end}) is absent from every match entry", async () => {
    setMockFile("survives.md", "one hit here");
    const result = await searchVaultSimpleHandler({
      arguments: { query: "hit" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    const match = data.results[0].matches[0];
    expect(typeof match.line).toBe("number");
    expect("match" in match).toBe(false);
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

    // ADR-0026 D10: `uri` is a wire-only addition, mapped in immediately
    // before JSON.stringify. It must never reach the `_meta` payload rows —
    // that would require adding `uri` to the shared `SearchResult`/row
    // shape, which fails searchResultsPayload.ts's `Unprojected`
    // exhaustiveness assertion.
    for (const row of payload?.rows ?? []) {
      expect((row as Record<string, unknown>).uri).toBeUndefined();
    }
  });
});

describe("search_vault_simple — file-level uri (ADR-0026, R-01, R-08)", () => {
  test("every result row carries a uri built from filename", async () => {
    setMockFile("a.md", "hit here");
    setMockFile("Notes/b.md", "hit there");

    const result = await searchVaultSimpleHandler({
      arguments: { query: "hit" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.results).toHaveLength(2);
    for (const row of data.results) {
      expect(row.uri).toBe(
        `obsidian://open?vault=Test%20Vault&file=${encodeURIComponent(row.filename)}`,
      );
    }
  });

  test("uri is file-level only — no uri key inside a matches row", async () => {
    setMockFile("a.md", "hit here");
    const result = await searchVaultSimpleHandler({
      arguments: { query: "hit" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    for (const match of data.results[0].matches) {
      expect("uri" in match).toBe(false);
    }
  });
});

describe("search_vault_simple — _meta payload gated on declared UI capability (R-09, ADR-0023 D9)", () => {
  const PAYLOAD_KEY = "io.github.istefox.mcp-connector/searchResults";

  // FAILING today: searchVaultSimpleHandler calls withSearchResultsPayload
  // unconditionally and never reads hasUiCapability at all.
  test("hasUiCapability: false — the modern era's declared non-support — omits the _meta payload", async () => {
    setMockFile("a.md", "one hit here");
    const result = (await searchVaultSimpleHandler({
      arguments: { query: "hit" },
      app: mockApp(),
      hasUiCapability: false,
    })) as { _meta?: Record<string, unknown> };

    expect(result._meta?.[PAYLOAD_KEY]).toBeUndefined();
  });

  test("hasUiCapability: true — the modern era's declared support — carries the _meta payload", async () => {
    setMockFile("a.md", "one hit here");
    const result = (await searchVaultSimpleHandler({
      arguments: { query: "hit" },
      app: mockApp(),
      hasUiCapability: true,
    })) as { _meta?: Record<string, unknown> };

    expect(result._meta?.[PAYLOAD_KEY]).toBeDefined();
  });

  // Regression guard, not a task-8 failing case: hasUiCapability absent is
  // the legacy-era shape (no per-request signal exists there) AND every
  // caller that predates this field (direct handler callers, partial test
  // fixtures) — both must keep the unconditional-attach behaviour that
  // exists today. This must stay green through task 8's implementation.
  test("hasUiCapability omitted (legacy era / callers that predate the signal) — payload stays unconditional", async () => {
    setMockFile("a.md", "one hit here");
    const result = (await searchVaultSimpleHandler({
      arguments: { query: "hit" },
      app: mockApp(),
    })) as { _meta?: Record<string, unknown> };

    expect(result._meta?.[PAYLOAD_KEY]).toBeDefined();
  });
});
