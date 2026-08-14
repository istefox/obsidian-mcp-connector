// searchAndReplace.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import {
  searchAndReplaceHandler,
  searchAndReplaceSchema,
} from "./searchAndReplace";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockModifyFail,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("search_and_replace tool", () => {
  test("schema declares the tool name", () => {
    expect(searchAndReplaceSchema.get("name")?.toString()).toContain(
      "search_and_replace",
    );
  });

  test("dry_run=true (default) returns preview without modifying files", async () => {
    setMockFile("a.md", "hello world\nhello again");
    const r = await searchAndReplaceHandler({
      arguments: { pattern: "hello", replacement: "hi" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.dry_run).toBe(true);
    expect(data.files_matched).toBe(1);
    expect(data.total_replacements).toBe(2);
    // File must NOT be modified
    const app = mockApp();
    const f = app.vault.getAbstractFileByPath("a.md");
    const content = await app.vault.read(f as never);
    expect(content).toBe("hello world\nhello again");
  });

  test("dry_run=false applies the replacement", async () => {
    setMockFile("note.md", "foo bar foo");
    await searchAndReplaceHandler({
      arguments: {
        pattern: "foo",
        replacement: "baz",
        dry_run: false,
      },
      app: mockApp(),
    });
    const app = mockApp();
    const f = app.vault.getAbstractFileByPath("note.md");
    const content = await app.vault.read(f as never);
    expect(content).toBe("baz bar baz");
  });

  test("invalid regex returns isError without touching any file", async () => {
    setMockFile("a.md", "content");
    const r = await searchAndReplaceHandler({
      arguments: { pattern: "[invalid", replacement: "x" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("invalid_regex");
  });

  test("rejects ReDoS-vulnerable nested-quantifier alternation pattern", async () => {
    setMockFile("a.md", "content");
    const r = await searchAndReplaceHandler({
      arguments: { pattern: "(a+|b+)+", replacement: "x" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("unsafe_regex");
  });

  test("zero matches returns files_matched: 0, no error", async () => {
    setMockFile("a.md", "nothing here");
    const r = await searchAndReplaceHandler({
      arguments: { pattern: "xyz123", replacement: "q" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.files_matched).toBe(0);
    expect(data.total_replacements).toBe(0);
    expect(r.isError).toBeUndefined();
  });

  test("scope limits files scanned", async () => {
    setMockFile("a/note.md", "match here");
    setMockFile("b/note.md", "match here");
    const r = await searchAndReplaceHandler({
      arguments: {
        pattern: "match",
        replacement: "X",
        dry_run: false,
        scope: ["a"],
      },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.files_matched).toBe(1);
    // b/note.md must be untouched
    const app = mockApp();
    const f = app.vault.getAbstractFileByPath("b/note.md");
    expect(await app.vault.read(f as never)).toBe("match here");
  });

  test("g flag is always injected even if omitted", async () => {
    setMockFile("a.md", "a a a");
    const r = await searchAndReplaceHandler({
      // No flags — should still replace ALL occurrences
      arguments: { pattern: "a", replacement: "b", dry_run: false },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.total_replacements).toBe(3);
  });

  test("preview includes before/after lines, max 5 per file", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i} foo`);
    setMockFile("big.md", lines.join("\n"));
    const r = await searchAndReplaceHandler({
      arguments: { pattern: "foo", replacement: "bar" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    const detail = data.details[0];
    expect(detail.preview.length).toBe(5);
    expect(detail.preview[0]).toHaveProperty("before");
    expect(detail.preview[0]).toHaveProperty("after");
  });

  test("surfaces error when vault.modify fails on one file", async () => {
    setMockFile("ok.md", "replace me");
    setMockFile("fail.md", "replace me");
    setMockModifyFail("fail.md");
    let threw = false;
    try {
      await searchAndReplaceHandler({
        arguments: {
          pattern: "replace me",
          replacement: "done",
          dry_run: false,
        },
        app: mockApp(),
      });
    } catch {
      threw = true;
    }
    // The handler propagates vault.modify errors; the ToolRegistry catches them.
    // Partial writes (ok.md modified, fail.md not) are a known limitation — documented here.
    expect(threw).toBe(true);
    const app2 = mockApp();
    const fOk = app2.vault.getAbstractFileByPath("ok.md");
    expect(await app2.vault.read(fOk as never)).toBe("done");
  });
});
