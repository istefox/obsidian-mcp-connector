import { describe, expect, test, beforeEach } from "bun:test";
import { type } from "arktype";
import {
  getVaultFileHandler,
  getVaultFileOutputSchema,
  getVaultFileSchema,
} from "./getVaultFile";
import {
  mockApp,
  mockPlugin,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_vault_file tool", () => {
  test("schema declares the tool name", () => {
    expect(getVaultFileSchema.get("name")?.toString()).toContain(
      "get_vault_file",
    );
  });

  test("returns markdown content as text by default, plus a second URI block (ADR-0026 D4)", async () => {
    setMockFile("Notes/a.md", "# Hello");
    const result = await getVaultFileHandler({
      arguments: { path: "Notes/a.md" },
      app: mockApp(),
    });
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { text: string }).text).toBe("# Hello");
    expect((result.content[1] as { text: string }).text).toBe(
      `URI: obsidian://open?vault=Test%20Vault&file=${encodeURIComponent("Notes/a.md")}`,
    );
  });

  test("returns JSON shape when format=json with frontmatter+tags+stat+uri", async () => {
    setMockFile("a.md", "---\ntags: [foo]\n---\n# Body");
    setMockMetadata("a.md", {
      frontmatter: { tags: ["foo"] },
      headings: [{ heading: "Body", level: 1, line: 3 }],
    });
    const result = await getVaultFileHandler({
      arguments: { path: "a.md", format: "json" },
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.path).toBe("a.md");
    expect(parsed.frontmatter).toEqual({ tags: ["foo"] });
    expect(parsed.tags).toEqual(["foo"]);
    // ApiNoteJson contract — `stat` was missing in the initial 0.4.0 port.
    expect(parsed.stat).toEqual({
      ctime: 0,
      mtime: 0,
      size: "---\ntags: [foo]\n---\n# Body".length,
    });
    expect(parsed.truncated).toBe(false);
    expect(parsed.uri).toBe("obsidian://open?vault=Test%20Vault&file=a.md");
  });

  test("truncates default-format text output past the default 100 KB cap", async () => {
    const big = "a".repeat(101 * 1024);
    setMockFile("big.md", big);
    const result = await getVaultFileHandler({
      arguments: { path: "big.md" },
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.kind).toBe("text_truncated");
    expect(parsed.truncated).toBe(true);
    expect(parsed.maxTextOutputBytes).toBe(100 * 1024);
    expect(parsed.content.length).toBeLessThanOrEqual(100 * 1024);
    expect(parsed.hint).toContain("get_vault_file_partial");
    expect(parsed.uri).toBe("obsidian://open?vault=Test%20Vault&file=big.md");
  });

  test("honors a custom mcpTools.maxTextOutputKB from the plugin setting", async () => {
    setMockFile("note.md", "x".repeat(2000));
    const plugin = mockPlugin({
      loadData: async () => ({ mcpTools: { maxTextOutputKB: 1 } }),
    });
    const result = await getVaultFileHandler({
      arguments: { path: "note.md" },
      app: mockApp(),
      plugin,
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.kind).toBe("text_truncated");
    expect(parsed.maxTextOutputBytes).toBe(1024);
    expect(parsed.content.length).toBeLessThanOrEqual(1024);
  });

  test("format=json truncates content and sets truncated: true past the cap", async () => {
    const big = "b".repeat(101 * 1024);
    setMockFile("big.md", big);
    const result = await getVaultFileHandler({
      arguments: { path: "big.md", format: "json" },
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.content.length).toBeLessThanOrEqual(100 * 1024);
    expect(parsed.path).toBe("big.md");
  });

  test("polymorphic contract: default format has no structuredContent, format=json does", async () => {
    setMockFile("a.md", "# Body");
    const plain = await getVaultFileHandler({
      arguments: { path: "a.md" },
      app: mockApp(),
    });
    // The tool declares no MCP outputSchema (see index.test.ts), so the
    // default text response legitimately omits structuredContent — with a
    // declared schema this same response would be rejected client-side
    // with -32600 (the 0.27.2–0.27.6 bug).
    expect(plain.structuredContent).toBeUndefined();

    const json = await getVaultFileHandler({
      arguments: { path: "a.md", format: "json" },
      app: mockApp(),
    });
    expect(json.structuredContent).toBeDefined();
  });

  test("getVaultFileOutputSchema accepts the actual format=json structuredContent", async () => {
    setMockFile("a.md", "---\ntags: [foo]\n---\n# Body");
    setMockMetadata("a.md", {
      frontmatter: { tags: ["foo"] },
      headings: [{ heading: "Body", level: 1, line: 3 }],
    });
    const result = await getVaultFileHandler({
      arguments: { path: "a.md", format: "json" },
      app: mockApp(),
    });

    // Schema-vs-actual consistency: the real handler output must satisfy the
    // declared outputSchema, or clients validating structuredContent break.
    expect(result.structuredContent).toBeDefined();
    const validated = getVaultFileOutputSchema(result.structuredContent);
    expect(validated instanceof type.errors).toBe(false);
    expect(result.structuredContent).toEqual(
      JSON.parse((result.content[0] as { text: string }).text),
    );
  });

  test("returns image content block for .png file — no second URI block (ADR-0026 D6: native image/audio blocks are excluded)", async () => {
    setMockFile("img/pic.png", "fake-png-bytes");
    const result = await getVaultFileHandler({
      arguments: { path: "img/pic.png" },
      app: mockApp(),
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("image");
    // base64 of "fake-png-bytes"
    expect((result.content[0] as { data: string }).data).toBeDefined();
    expect((result.content[0] as { mimeType: string }).mimeType).toBe(
      "image/png",
    );
  });

  test("returns audio content block for .mp3 file", async () => {
    setMockFile("audio/song.mp3", "fake-mp3-bytes");
    const result = await getVaultFileHandler({
      arguments: { path: "audio/song.mp3" },
      app: mockApp(),
    });
    expect(result.content[0].type).toBe("audio");
    expect((result.content[0] as { mimeType: string }).mimeType).toBe(
      "audio/mpeg",
    );
  });

  test("returns JSON metadata when binary type unsupported (e.g. .pdf)", async () => {
    setMockFile("doc/file.pdf", "fake-pdf-bytes");
    const result = await getVaultFileHandler({
      arguments: { path: "doc/file.pdf" },
      app: mockApp(),
    });
    // Unsupported binary returns text content describing the file
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.path ?? parsed.filename).toBe("doc/file.pdf");
    expect(parsed.hint).toBeDefined();
    expect(parsed.uri).toBe(
      "obsidian://open?vault=Test%20Vault&file=doc%2Ffile.pdf",
    );
  });

  test("returns error when path not found", async () => {
    const result = await getVaultFileHandler({
      arguments: { path: "missing.md" },
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/not found/i);
    expect(result.content).toHaveLength(1);
  });

  describe("heading input (ADR-0026 D7-D9, R-01, R-04)", () => {
    test("heading matching resolves and appends %23<heading> in the default-text URI block", async () => {
      setMockFile("Notes/a.md", "# Title\n\n## Section\nBody");
      const result = await getVaultFileHandler({
        arguments: { path: "Notes/a.md", heading: "Section" },
        app: mockApp(),
      });
      expect(result.content).toHaveLength(2);
      expect((result.content[1] as { text: string }).text).toContain(
        "%23Section",
      );
    });

    test("heading matching resolves and sets uri with %23<heading> in the json branch", async () => {
      setMockFile("a.md", "# Title\n\n## Section\nBody");
      const result = await getVaultFileHandler({
        arguments: { path: "a.md", format: "json", heading: "Section" },
        app: mockApp(),
      });
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.uri).toBe(
        "obsidian://open?vault=Test%20Vault&file=a.md%23Section",
      );
    });

    test("heading matching past the truncation cut, resolved via the metadata cache fallback", async () => {
      const heading = "## Past The Cut";
      const filler = "a".repeat(101 * 1024);
      setMockFile("big.md", `${filler}\n${heading}\nBody`);
      setMockMetadata("big.md", {
        headings: [
          {
            heading: "Past The Cut",
            level: 2,
            line: filler.split("\n").length,
          },
        ],
      });
      const result = await getVaultFileHandler({
        arguments: { path: "big.md", heading: "Past The Cut" },
        app: mockApp(),
      });
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.kind).toBe("text_truncated");
      expect(parsed.uri).toContain("%23Past%20The%20Cut");
    });

    test("heading not found returns heading_not_found error, no uri, no content", async () => {
      setMockFile("a.md", "# Title\nBody");
      const result = await getVaultFileHandler({
        arguments: { path: "a.md", heading: "Nope" },
        app: mockApp(),
      });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.errorCode).toBe("heading_not_found");
      expect(parsed.heading).toBe("Nope");
      expect(parsed.path).toBe("a.md");
    });

    test("heading on a .png file resolves to heading_not_found, not a crash", async () => {
      setMockFile("img/pic.png", "fake-png-bytes");
      const result = await getVaultFileHandler({
        arguments: { path: "img/pic.png", heading: "Anything" },
        app: mockApp(),
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.errorCode).toBe("heading_not_found");
    });
  });
});
