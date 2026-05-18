import { describe, expect, test, beforeEach } from "bun:test";
import {
  renameHeadingHandler,
  renameHeadingSchema,
} from "./renameHeading";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
  setMockResolvedLinks,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("rename_heading tool", () => {
  test("schema declares the tool name", () => {
    expect(renameHeadingSchema.get("name")?.toString()).toContain(
      "rename_heading",
    );
  });

  test("returns file-not-found when source path does not resolve", async () => {
    const r = await renameHeadingHandler({
      arguments: { path: "missing.md", from: { text: "Foo" }, to: "Bar" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.errorCode).toBe("file-not-found");
  });

  test("positive: rewrites the source heading and one backlinker", async () => {
    setMockFile("source.md", "## Old heading\nbody");
    setMockFile("back.md", "See [[source#Old heading]] please.");
    setMockMetadata("source.md", {
      headings: [{ heading: "Old heading", level: 2, line: 0 }],
    });
    setMockResolvedLinks("back.md", { "source.md": 1 });

    const r = await renameHeadingHandler({
      arguments: {
        path: "source.md",
        from: { text: "Old heading" },
        to: "New heading",
      },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.updatedFiles.sort()).toEqual(["back.md", "source.md"]);
    expect(payload.linkRewriteCount).toBe(1);
  });

  test("returns heading-not-found from the walker when no heading matches", async () => {
    setMockFile("source.md", "## Other");
    setMockMetadata("source.md", {
      headings: [{ heading: "Other", level: 2, line: 0 }],
    });

    const r = await renameHeadingHandler({
      arguments: { path: "source.md", from: { text: "Missing" }, to: "X" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.errorCode).toBe("heading-not-found");
  });

  test("returns ambiguous-heading with candidates when level is omitted and multi-match", async () => {
    setMockFile("source.md", "## Foo\n\n\n\n### Foo");
    setMockMetadata("source.md", {
      headings: [
        { heading: "Foo", level: 2, line: 0 },
        { heading: "Foo", level: 3, line: 4 },
      ],
    });

    const r = await renameHeadingHandler({
      arguments: { path: "source.md", from: { text: "Foo" }, to: "Bar" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.errorCode).toBe("ambiguous-heading");
    expect(payload.candidates).toHaveLength(2);
    expect(payload.candidates.map((c: { level: number }) => c.level)).toEqual([
      2, 3,
    ]);
  });

  test("`from.level` disambiguates between same-text headings at different levels", async () => {
    setMockFile("source.md", "## Foo\nbody2\n\n### Foo\nbody3");
    setMockMetadata("source.md", {
      headings: [
        { heading: "Foo", level: 2, line: 0 },
        { heading: "Foo", level: 3, line: 3 },
      ],
    });

    const r = await renameHeadingHandler({
      arguments: {
        path: "source.md",
        from: { text: "Foo", level: 3 },
        to: "Bar",
      },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.ok).toBe(true);
  });

  test("returns heading-collision when `to` already exists at the same level", async () => {
    setMockFile("source.md", "## Old\n\n\n\n## Existing");
    setMockMetadata("source.md", {
      headings: [
        { heading: "Old", level: 2, line: 0 },
        { heading: "Existing", level: 2, line: 4 },
      ],
    });

    const r = await renameHeadingHandler({
      arguments: {
        path: "source.md",
        from: { text: "Old" },
        to: "Existing",
      },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.errorCode).toBe("heading-collision");
  });

  test("rewrites self-references inside the source file (e.g. TOC entries)", async () => {
    setMockFile(
      "source.md",
      "# Title\n[[#Old heading]] (TOC)\n\n## Old heading\nbody",
    );
    setMockMetadata("source.md", {
      headings: [
        { heading: "Title", level: 1, line: 0 },
        { heading: "Old heading", level: 2, line: 3 },
      ],
    });
    // No backlinkers in `resolvedLinks` — but the source itself has a
    // self-reference that must be rewritten.

    const r = await renameHeadingHandler({
      arguments: {
        path: "source.md",
        from: { text: "Old heading" },
        to: "New heading",
      },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.updatedFiles).toEqual(["source.md"]);
    expect(payload.linkRewriteCount).toBe(1); // self-ref rewrite counts
  });

  test("skips files in resolvedLinks that do not actually reference the heading", async () => {
    setMockFile("source.md", "## Old");
    setMockFile("noref.md", "I link to [[source]] without #fragment.");
    setMockMetadata("source.md", {
      headings: [{ heading: "Old", level: 2, line: 0 }],
    });
    // noref.md has a wikilink to source.md but with NO heading fragment.
    setMockResolvedLinks("noref.md", { "source.md": 1 });

    const r = await renameHeadingHandler({
      arguments: { path: "source.md", from: { text: "Old" }, to: "New" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const payload = JSON.parse(r.content[0].text);
    // Source updated, noref.md should NOT appear in updatedFiles because
    // it had no heading-link to rewrite.
    expect(payload.updatedFiles).toEqual(["source.md"]);
    expect(payload.linkRewriteCount).toBe(0);
  });

  test("counts multiple link rewrites accurately across backlinkers", async () => {
    setMockFile("source.md", "## Target");
    setMockFile(
      "a.md",
      "Two refs: [[source#Target]] and [[source#Target|alias]].",
    );
    setMockFile(
      "b.md",
      "One ref: [text](source.md#Target).",
    );
    setMockMetadata("source.md", {
      headings: [{ heading: "Target", level: 2, line: 0 }],
    });
    setMockResolvedLinks("a.md", { "source.md": 2 });
    setMockResolvedLinks("b.md", { "source.md": 1 });

    const r = await renameHeadingHandler({
      arguments: { path: "source.md", from: { text: "Target" }, to: "Hit" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.updatedFiles.sort()).toEqual([
      "a.md",
      "b.md",
      "source.md",
    ]);
    expect(payload.linkRewriteCount).toBe(3);
  });

  test("RFC edge case #4 — subheading-path link rewrite via the wrapper end-to-end", async () => {
    setMockFile("source.md", "# Parent\n## Old\nbody");
    setMockFile(
      "back.md",
      "Deep ref: [[source#Parent > Old]] and shallow [[source#Old]].",
    );
    setMockMetadata("source.md", {
      headings: [
        { heading: "Parent", level: 1, line: 0 },
        { heading: "Old", level: 2, line: 1 },
      ],
    });
    setMockResolvedLinks("back.md", { "source.md": 2 });

    const r = await renameHeadingHandler({
      arguments: { path: "source.md", from: { text: "Old" }, to: "Renamed" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.linkRewriteCount).toBe(2);
  });
});
