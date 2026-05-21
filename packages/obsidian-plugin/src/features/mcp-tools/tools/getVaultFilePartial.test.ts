import { describe, expect, test, beforeEach } from "bun:test";
import {
  getVaultFilePartialHandler,
  getVaultFilePartialSchema,
} from "./getVaultFilePartial";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_vault_file_partial tool", () => {
  // ── Common ────────────────────────────────────────────────────────────────

  test("schema declares the tool name", () => {
    expect(getVaultFilePartialSchema.get("name")?.toString()).toContain(
      "get_vault_file_partial",
    );
  });

  test("returns isError when filename does not resolve", async () => {
    const r = await getVaultFilePartialHandler({
      arguments: { filename: "missing.md", mode: "frontmatter", target: "x" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("File not found");
  });

  test("rejects missing target for non-document-map modes", async () => {
    setMockFile("note.md", "");
    // Empty target on `frontmatter` → handler returns isError before touching
    // the cache. Same applies to `heading` / `block`. document-map ignores
    // `target` (tested separately below).
    for (const mode of ["frontmatter", "heading", "block"] as const) {
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "note.md", mode },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Missing required `target`");
    }
  });

  test("targetDelimiter override is respected on heading mode", async () => {
    setMockFile("doc.md", "# Parent\nfoo\n## Child\nbar\n## Other\nbaz");
    setMockMetadata("doc.md", {
      headings: [
        { heading: "Parent", level: 1, line: 0 },
        { heading: "Child", level: 2, line: 2 },
        { heading: "Other", level: 2, line: 4 },
      ],
    });
    const r = await getVaultFilePartialHandler({
      arguments: {
        filename: "doc.md",
        mode: "heading",
        target: "Parent>>Child",
        targetDelimiter: ">>",
      },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("## Child\nbar");
  });

  // ── Primary: frontmatter (6 cases) ────────────────────────────────────────

  describe("mode: frontmatter (PRIMARY depth)", () => {
    test("returns a scalar frontmatter value", async () => {
      setMockFile("note.md", "");
      setMockMetadata("note.md", { frontmatter: { status: "open" } });
      const r = await getVaultFilePartialHandler({
        arguments: {
          filename: "note.md",
          mode: "frontmatter",
          target: "status",
        },
        app: mockApp(),
      });
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text)).toBe("open");
    });

    test("returns isError when target field is missing", async () => {
      setMockFile("note.md", "");
      setMockMetadata("note.md", { frontmatter: { other: "x" } });
      const r = await getVaultFilePartialHandler({
        arguments: {
          filename: "note.md",
          mode: "frontmatter",
          target: "status",
        },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Frontmatter field not found");
      expect(r.content[0].text).toContain('"status"');
    });

    test("returns isError when file has no frontmatter at all", async () => {
      setMockFile("note.md", "body only");
      // No setMockMetadata call → frontmatter is undefined / empty.
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "note.md", mode: "frontmatter", target: "any" },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("File has no frontmatter");
    });

    // ── #138: cache-empty disambiguation ──────────────────────────────
    // The tool reflects Obsidian's MetadataCache and never re-parses YAML
    // (a second parser would diverge from the rest of Obsidian). When a
    // frontmatter block IS present but the cache exposed nothing (Obsidian's
    // own parser dropped it — e.g. an unquoted scalar containing ": "), the
    // error must be actionable, not the misleading "File has no frontmatter".
    test("#138: fence present but cache empty → actionable parse-divergence error", async () => {
      setMockFile(
        "repro.md",
        [
          "---",
          "id: t-repro-018",
          'purpose: Verify partial-read behavior with patch_vault_file targetType: "block"',
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      // No setMockMetadata → simulates Obsidian's cache dropping the block.
      const r = await getVaultFilePartialHandler({
        arguments: {
          filename: "repro.md",
          mode: "frontmatter",
          target: "purpose",
        },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).not.toContain("File has no frontmatter");
      expect(r.content[0].text).toContain("metadata cache");
      expect(r.content[0].text).toContain(": ");
    });

    test("#138 R4: empty fence (--- / ---) → still 'File has no frontmatter'", async () => {
      setMockFile("empty-fm.md", ["---", "---", "", "# Body"].join("\n"));
      const r = await getVaultFilePartialHandler({
        arguments: {
          filename: "empty-fm.md",
          mode: "frontmatter",
          target: "x",
        },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("File has no frontmatter");
    });

    test("#138 R5: opening --- with no closing fence → actionable error, not 'no frontmatter'", async () => {
      setMockFile(
        "malformed.md",
        ["---", "foo: bar", "still no close"].join("\n"),
      );
      const r = await getVaultFilePartialHandler({
        arguments: {
          filename: "malformed.md",
          mode: "frontmatter",
          target: "foo",
        },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).not.toContain("File has no frontmatter");
      expect(r.content[0].text).toContain("metadata cache");
    });

    test("supports special-character keys", async () => {
      setMockFile("note.md", "");
      setMockMetadata("note.md", {
        frontmatter: {
          "field with spaces": "v1",
          "field-with-dashes": "v2",
          field_with_underscore: "v3",
          "numeric-2026": "v4",
        },
      });
      for (const [key, val] of [
        ["field with spaces", "v1"],
        ["field-with-dashes", "v2"],
        ["field_with_underscore", "v3"],
        ["numeric-2026", "v4"],
      ]) {
        const r = await getVaultFilePartialHandler({
          arguments: { filename: "note.md", mode: "frontmatter", target: key },
          app: mockApp(),
        });
        expect(r.isError).toBeUndefined();
        expect(JSON.parse(r.content[0].text)).toBe(val);
      }
    });

    test("returns nested object values serialized as JSON", async () => {
      setMockFile("note.md", "");
      setMockMetadata("note.md", {
        frontmatter: { author: { name: "Marco", role: "PM" } },
      });
      const r = await getVaultFilePartialHandler({
        arguments: {
          filename: "note.md",
          mode: "frontmatter",
          target: "author",
        },
        app: mockApp(),
      });
      expect(r.isError).toBeUndefined();
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed).toEqual({ name: "Marco", role: "PM" });
    });

    test("returns array-valued fields as JSON arrays", async () => {
      setMockFile("note.md", "");
      setMockMetadata("note.md", {
        frontmatter: { tags: ["project", "active", "2026"] },
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "note.md", mode: "frontmatter", target: "tags" },
        app: mockApp(),
      });
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text)).toEqual([
        "project",
        "active",
        "2026",
      ]);
    });
  });

  // ── Primary: document-map (5 cases) ──────────────────────────────────────

  describe("mode: document-map (PRIMARY depth)", () => {
    test("returns the outline of a file with headings, blocks, and frontmatter", async () => {
      setMockFile("doc.md", "");
      setMockMetadata("doc.md", {
        headings: [
          { heading: "Intro", level: 1, line: 0 },
          { heading: "Details", level: 2, line: 5 },
        ],
        blocks: { abc: { startLine: 10, endLine: 12 } },
        frontmatter: { status: "draft", tags: ["x"] },
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "document-map" },
        app: mockApp(),
      });
      expect(r.isError).toBeUndefined();
      const data = JSON.parse(r.content[0].text);
      expect(data.path).toBe("doc.md");
      expect(data.frontmatter.sort()).toEqual(["status", "tags"]);
      expect(data.headings).toEqual([
        { heading: "Intro", level: 1, line: 0 },
        { heading: "Details", level: 2, line: 5 },
      ]);
      expect(data.blocks).toEqual(["abc"]);
    });

    test("returns outline for a file with only headings (no frontmatter)", async () => {
      setMockFile("doc.md", "");
      setMockMetadata("doc.md", {
        headings: [{ heading: "Only", level: 1, line: 0 }],
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "document-map" },
        app: mockApp(),
      });
      const data = JSON.parse(r.content[0].text);
      expect(data.frontmatter).toEqual([]);
      expect(data.headings).toHaveLength(1);
      expect(data.blocks).toEqual([]);
    });

    test("returns an empty outline for an empty file", async () => {
      setMockFile("empty.md", "");
      // No metadata at all.
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "empty.md", mode: "document-map" },
        app: mockApp(),
      });
      const data = JSON.parse(r.content[0].text);
      expect(data).toEqual({
        path: "empty.md",
        frontmatter: [],
        headings: [],
        blocks: [],
      });
    });

    test("preserves nested-heading levels in the outline", async () => {
      setMockFile("doc.md", "");
      setMockMetadata("doc.md", {
        headings: [
          { heading: "H1A", level: 1, line: 0 },
          { heading: "H2A", level: 2, line: 1 },
          { heading: "H3A", level: 3, line: 2 },
          { heading: "H2B", level: 2, line: 3 },
          { heading: "H1B", level: 1, line: 4 },
        ],
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "document-map" },
        app: mockApp(),
      });
      const data = JSON.parse(r.content[0].text);
      expect(data.headings.map((h: { level: number }) => h.level)).toEqual([
        1, 2, 3, 2, 1,
      ]);
    });

    test("ignores `target` if passed", async () => {
      setMockFile("doc.md", "");
      setMockMetadata("doc.md", {
        frontmatter: { status: "open" },
      });
      const r = await getVaultFilePartialHandler({
        arguments: {
          filename: "doc.md",
          mode: "document-map",
          target: "should-be-ignored",
        },
        app: mockApp(),
      });
      // No error, no special treatment — target is silently dropped.
      expect(r.isError).toBeUndefined();
      const data = JSON.parse(r.content[0].text);
      expect(data.frontmatter).toEqual(["status"]);
    });
  });

  // ── Secondary: heading (5 cases) ──────────────────────────────────────────

  describe("mode: heading (SECONDARY)", () => {
    test("returns the section under a unique heading", async () => {
      setMockFile(
        "doc.md",
        "# Intro\nthis is intro\nstill intro\n# Other\nother body",
      );
      setMockMetadata("doc.md", {
        headings: [
          { heading: "Intro", level: 1, line: 0 },
          { heading: "Other", level: 1, line: 3 },
        ],
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "heading", target: "Intro" },
        app: mockApp(),
      });
      expect(r.isError).toBeUndefined();
      // Section is from the heading line (inclusive) to before the next
      // same-or-higher-level heading (exclusive).
      expect(r.content[0].text).toBe("# Intro\nthis is intro\nstill intro");
    });

    test("returns isError when the target heading is missing", async () => {
      setMockFile("doc.md", "# A\ntext");
      setMockMetadata("doc.md", {
        headings: [{ heading: "A", level: 1, line: 0 }],
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "heading", target: "Nope" },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Heading not found");
    });

    test("returns isError when the target heading is ambiguous", async () => {
      setMockFile("doc.md", "# Section\nfirst\n# Section\nsecond");
      setMockMetadata("doc.md", {
        headings: [
          { heading: "Section", level: 1, line: 0 },
          { heading: "Section", level: 1, line: 2 },
        ],
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "heading", target: "Section" },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Ambiguous heading target");
    });

    test("resolves nested heading paths via the default `::` delimiter", async () => {
      setMockFile(
        "doc.md",
        "# Parent\nintro\n## Section\nfirst\n# Other\n## Section\nsecond",
      );
      setMockMetadata("doc.md", {
        headings: [
          { heading: "Parent", level: 1, line: 0 },
          { heading: "Section", level: 2, line: 2 },
          { heading: "Other", level: 1, line: 4 },
          { heading: "Section", level: 2, line: 5 },
        ],
      });
      // Both "Section" headings would be ambiguous at top-level, but the
      // nested path disambiguates to the one under "Parent".
      const r = await getVaultFilePartialHandler({
        arguments: {
          filename: "doc.md",
          mode: "heading",
          target: "Parent::Section",
        },
        app: mockApp(),
      });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe("## Section\nfirst");
    });

    test("section extends to end-of-file when no closer heading exists", async () => {
      setMockFile("doc.md", "# A\nline1\nline2");
      setMockMetadata("doc.md", {
        headings: [{ heading: "A", level: 1, line: 0 }],
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "heading", target: "A" },
        app: mockApp(),
      });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe("# A\nline1\nline2");
    });
  });

  // ── Secondary: block (4 cases) ────────────────────────────────────────────

  describe("mode: block (SECONDARY)", () => {
    test("returns the markdown range of a block reference", async () => {
      setMockFile("doc.md", "intro\nthis is the target ^abc\nfollowup");
      setMockMetadata("doc.md", {
        blocks: { abc: { startLine: 1, endLine: 1 } },
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "block", target: "abc" },
        app: mockApp(),
      });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe("this is the target ^abc");
    });

    test("accepts the target with or without the leading `^`", async () => {
      setMockFile("doc.md", "line0\nline1 ^xyz");
      setMockMetadata("doc.md", {
        blocks: { xyz: { startLine: 1, endLine: 1 } },
      });
      const withCaret = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "block", target: "^xyz" },
        app: mockApp(),
      });
      const withoutCaret = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "block", target: "xyz" },
        app: mockApp(),
      });
      expect(withCaret.content[0].text).toBe(withoutCaret.content[0].text);
    });

    test("returns isError when the target block is missing", async () => {
      setMockFile("doc.md", "line0\nline1");
      setMockMetadata("doc.md", {
        blocks: { present: { startLine: 0, endLine: 0 } },
      });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "block", target: "missing" },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Block not found");
      expect(r.content[0].text).toContain('"^missing"');
    });

    test("returns isError when target collapses to empty after stripping `^`", async () => {
      setMockFile("doc.md", "x");
      setMockMetadata("doc.md", { blocks: {} });
      const r = await getVaultFilePartialHandler({
        arguments: { filename: "doc.md", mode: "block", target: "^^^" },
        app: mockApp(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Invalid block target");
    });
  });
});
