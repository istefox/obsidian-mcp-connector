import { describe, expect, test, beforeEach } from "bun:test";
import { type } from "arktype";
import {
  getVaultFileHandler,
  getVaultFileOutputSchema,
  getVaultFileSchema,
} from "./getVaultFile";
import {
  mockApp,
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

  test("returns markdown content as text by default", async () => {
    setMockFile("Notes/a.md", "# Hello");
    const result = await getVaultFileHandler({
      arguments: { path: "Notes/a.md" },
      app: mockApp(),
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { text: string }).text).toBe("# Hello");
  });

  test("returns JSON shape when format=json with frontmatter+tags+stat", async () => {
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

  test("returns image content block for .png file", async () => {
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
  });

  test("returns error when path not found", async () => {
    const result = await getVaultFileHandler({
      arguments: { path: "missing.md" },
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/not found/i);
  });
});
